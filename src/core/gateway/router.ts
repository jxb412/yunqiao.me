import type { AuroraStore, ApiKey, Provider, ProviderModel, RouteMode } from '../store/index.js';
import { nowIso } from '../util.js';
import { localProviderHost } from '../providerEndpoint.js';

export interface Candidate {
  provider: Provider;
  providerModel: ProviderModel;
  key: ApiKey;
  /** 真正发给上游的模型名 */
  model: string;
}

export interface ResolveResult {
  requested: string;
  candidates: Candidate[];
  matchedGroup?: string;
  reason: string;
  retries?: number;
}

const COOLDOWN_MS = 60_000;

export class Router {
  /** 轮询游标：group/provider 维度的调用计数，用于 rotate / usage / pace */
  private counters = new Map<string, number>();
  private failCounts = new Map<string, number>();
  private usageCounts = new Map<string, number>();
  private volatileCooldowns = new Map<string, { key: string; until: number }>();
  persistenceWarning?: string;

  constructor(private store: AuroraStore) {}

  private keysOf(p: Provider): ApiKey[] {
    const now = Date.now();
    let allowsEmpty = false;
    try {
      allowsEmpty = localProviderHost(new URL(p.baseUrl).hostname);
    } catch { return []; }
    // Imported local servers can have no slots at all. A disabled slot still means disabled.
    const slots: ApiKey[] = allowsEmpty && !p.apiKeys.length
      ? [{ id: 'anonymous', label: '本地免密', key: '', enabled: true, weight: 1 }] : p.apiKeys;
    const usable = slots.filter((k) => {
      if (!k.enabled) return false;
      const slot = JSON.stringify([p.id, k.id]), cooldown = this.volatileCooldowns.get(slot);
      if (cooldown && cooldown.key === k.key && cooldown.until > now) return false;
      if (cooldown) this.volatileCooldowns.delete(slot);
      if (k.cooldownUntil && new Date(k.cooldownUntil).getTime() > now) return false;
      return !!k.key.trim() || allowsEmpty;
    });
    return usable;
  }

  private pickKey(p: Provider): ApiKey | undefined {
    const keys = this.keysOf(p);
    if (!keys.length) return undefined;
    if (keys.length === 1) return keys[0];
    const n = this.counters.get(`key:${p.id}`) ?? 0;
    this.counters.set(`key:${p.id}`, n + 1);
    const weight = (k: ApiKey) => Math.min(1000, Math.max(1, Math.floor(Number(k.weight) || 1)));
    let slot = n % keys.reduce((sum, k) => sum + weight(k), 0);
    for (const key of keys) { slot -= weight(key); if (slot < 0) return key; }
    return keys[0];
  }

  private candidatesFor(p: Provider, pm: ProviderModel, model: string): Candidate[] {
    const first = this.pickKey(p);
    if (!first) return [];
    const keys = [first, ...this.keysOf(p).filter((key) => key.id !== first.id)];
    return keys.map((key) => ({ provider: p, providerModel: pm, key, model }));
  }

  /** History aliases must not resolve through names, groups or unknown-model fallbacks. */
  resolveProviderModel(providerId: string, model: string): ResolveResult {
    const provider = this.store.getProvider(providerId), requested = `${providerId}/${model}`;
    if (!provider) return { requested, candidates: [], reason: '历史兼容连接指定的供应商已删除' };
    if (!provider.enabled) return { requested, candidates: [], reason: '历史兼容连接指定的供应商已停用' };
    const metadata = provider.models.find(entry => entry.id === model) ?? { id: model, capabilities: { tools: true } };
    const candidates = this.candidatesFor(provider, metadata, model);
    return { requested, candidates, reason: candidates.length ? `历史会话使用指定供应商「${provider.name}」`
      : '历史兼容连接指定的供应商没有可用密钥，或密钥正在冷却' };
  }

  resolveModel(requested: string): ResolveResult {
    const providers = this.store.listProviders().filter((p) => p.enabled);
    const groups = this.store.listGroups().filter((g) => g.enabled);

    // 1) 分组：group/xxx 或直接分组名
    const explicitGroup = requested.startsWith('group/');
    const groupKey = explicitGroup ? requested.slice(6) : null;
    const group = explicitGroup
      ? groups.find((g) => g.id === groupKey || g.name === groupKey)
      : groups.find((g) => g.name === requested || g.id === requested);
    if (group) {
      const candidates = this.expandGroup(group, providers);
      return {
          requested,
          candidates,
          matchedGroup: group.name,
          reason: `命中分组「${group.name}」（${MODE_LABEL[group.mode]}）`,
          retries: group.retries,
        };
    }
    if (explicitGroup) return { requested, candidates: [], reason: '指定的路由分组不存在或已停用' };

    // 2) provider/model
    const slash = requested.indexOf('/');
    if (slash > 0) {
      const prefix = requested.slice(0, slash);
      const rest = requested.slice(slash + 1);
      const p = providers.find(
        (x) =>
          x.id === prefix ||
          x.name.toLowerCase() === prefix.toLowerCase() ||
          x.presetId?.toLowerCase() === prefix.toLowerCase(),
      );
      if (p) {
          const pm = p.models.find((mm) => mm.id === rest) ?? {
            id: rest,
            capabilities: { tools: true },
          };
          return {
            requested,
            candidates: this.candidatesFor(p, pm, rest),
            reason: `指定供应商「${p.name}」`,
          };
      }
      const configured = this.store.listProviders().some((x) => x.id === prefix || x.presetId === prefix || x.name.toLowerCase() === prefix.toLowerCase());
      if (configured) return { requested, candidates: [], reason: '指定的供应商已停用或没有可用密钥' };
    }

    // 3) 裸模型名：所有声明了该模型的供应商
    const direct: Candidate[] = [];
    for (const p of providers) {
      const pm = p.models.find((mm) => mm.id.toLowerCase() === requested.toLowerCase());
      if (!pm) continue;
      direct.push(...this.candidatesFor(p, pm, pm.id));
    }
    if (direct.length) {
      direct.sort((a, b) => (b.provider.priority ?? 0) - (a.provider.priority ?? 0));
      return {
        requested,
        candidates: direct,
        reason:
          direct.length > 1
            ? `${direct.length} 家供应商都提供该模型，按优先级依次尝试`
            : `命中供应商「${direct[0].provider.name}」`,
      };
    }

    // Only providers without a declared catalog accept unknown models. An explicit binding never falls through.
    const fallback: Candidate[] = [];
    for (const p of [...providers].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
      if (p.models.length) continue;
      const pm =
        p.models.find((mm) => mm.id.toLowerCase() === requested.toLowerCase()) ??
        ({ id: requested, capabilities: { tools: true } } as ProviderModel);
      fallback.push(...this.candidatesFor(p, pm, requested));
    }
    return {
      requested,
      candidates: fallback,
      reason: fallback.length ? '未精确匹配，按优先级兜底转发' : '没有任何可用的供应商',
    };
  }

  private expandGroup(group: { members: any[]; mode: RouteMode; id: string }, providers: Provider[]): Candidate[] {
    const members: Array<{ candidates: Candidate[]; weight: number }> = [];
    for (const member of group.members) {
      // Zero explicitly removes a member from weighted traffic, including failover.
      if (group.mode === 'weight' && Number(member.weight) === 0) continue;
      const p = providers.find((x) => x.id === member.providerId);
      if (!p) continue;
      const model = member.model ?? p.models[0]?.id ?? '';
      if (!model) continue;
      const declared = p.models.find((mm) => mm.id === model);
      if (p.models.length && !declared) continue;
      const pm = declared ?? ({ id: model, capabilities: { tools: true } } as ProviderModel);
      const candidates = this.candidatesFor(p, pm, model);
      const weight = group.mode === 'weight' ? Math.min(1000, Math.max(1, Math.floor(Number(member.weight) || 1))) : 1;
      if (candidates.length) members.push({ candidates, weight });
    }
    const base = members.flatMap(member => member.candidates);
    if (!base.length) return base;

    const unique = (items: Candidate[]) => {
      const seen = new Set<string>();
      return items.filter((item) => {
        const id = `${item.provider.id}:${item.model}:${item.key.id}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    };
    switch (group.mode) {
      case 'weight':
      case 'rotate': {
        const n = this.counters.get(`grp:${group.id}`) ?? 0;
        this.counters.set(`grp:${group.id}`, n + 1);
        // Group weights choose a member; API key count must not increase its traffic share.
        let slot = n % members.reduce((sum, member) => sum + member.weight, 0);
        let off = 0;
        while (off < members.length - 1 && slot >= members[off].weight) slot -= members[off++].weight;
        return unique([...members.slice(off), ...members.slice(0, off)].flatMap(member => member.candidates));
      }
      case 'usage':
      case 'pace':
      case 'smart': {
        const now = Date.now();
        return unique([...base].sort((a, b) => {
          if (group.mode === 'usage') {
            const difference = (this.usageCounts.get(a.provider.id) ?? 0) - (this.usageCounts.get(b.provider.id) ?? 0);
            if (difference) return difference;
          }
          if (group.mode === 'pace') {
            const peak = (p: Provider) => {
              const values = p.quota?.windows?.map(window => window.usedPercent).filter(value => Number.isFinite(value) && value >= 0 && value <= 100) || [];
              return values.length ? Math.max(...values) : 101;
            };
            const difference = peak(a.provider) - peak(b.provider);
            if (difference) return difference;
          }
          const ca = new Date(a.key.cooldownUntil ?? 0).getTime();
          const cb = new Date(b.key.cooldownUntil ?? 0).getTime();
          const pa = ca > now ? 1 : 0;
          const pb = cb > now ? 1 : 0;
          if (pa !== pb) return pa - pb;
          const fa = this.failCounts.get(a.provider.id) ?? 0;
          const fb = this.failCounts.get(b.provider.id) ?? 0;
          if (fa !== fb) return fa - fb;
          return (b.provider.priority ?? 0) - (a.provider.priority ?? 0);
        }));
      }
      case 'order':
      default:
        return unique(base);
    }
  }

  markKeyFailure(providerId: string, keyId: string, reason: string, cooldownMs = COOLDOWN_MS, expectedKey?: string): void {
    const key = this.store.getProvider(providerId)?.apiKeys.find(item => item.id === keyId);
    if (!key || (expectedKey !== undefined && key.key !== expectedKey)) return;
    if (key) this.volatileCooldowns.set(JSON.stringify([providerId, keyId]), { key: key.key, until: Date.now() + cooldownMs });
    this.persistKeyStatus(() => this.store.providers.update((list) =>
      list.map((p) => {
        if (p.id !== providerId) return p;
        return {
          ...p,
          apiKeys: p.apiKeys.map((k) =>
            k.id === keyId
              ? { ...k, lastError: reason, cooldownUntil: new Date(Date.now() + cooldownMs).toISOString() }
              : k,
          ),
        };
      }),
    ));
    this.markProviderFailure(providerId);
  }

  /** Health ordering includes transport/server failures, without cooling every key. */
  markProviderFailure(providerId: string): void { this.failCounts.set(providerId, (this.failCounts.get(providerId) ?? 0) + 1); }

  markKeySuccess(providerId: string, keyId: string, expectedKey?: string): void {
    const key = this.store.getProvider(providerId)?.apiKeys.find(item => item.id === keyId);
    if (!key || (expectedKey !== undefined && key.key !== expectedKey)) return;
    this.volatileCooldowns.delete(JSON.stringify([providerId, keyId]));
    this.persistKeyStatus(() => this.store.providers.update((list) =>
      list.map((p) =>
        p.id !== providerId
          ? p
          : {
              ...p,
              apiKeys: p.apiKeys.map((k) =>
                k.id === keyId
                  ? { ...k, lastError: undefined, cooldownUntil: undefined, lastUsedAt: nowIso() }
                  : k,
              ),
            },
      ),
    ));
    this.failCounts.set(providerId, 0);
    this.usageCounts.set(providerId, (this.usageCounts.get(providerId) ?? 0) + 1);
  }

  private persistKeyStatus(write: () => unknown): void {
    try { write(); this.persistenceWarning = undefined; }
    catch { this.persistenceWarning = '密钥运行状态暂时无法保存，请检查数据目录的空间和权限；请求继续处理，冷却状态暂存于内存。'; }
  }

  /** Missing price metadata means unknown cost, including native subscriptions. */
  costKnown(provider: Provider, model: ProviderModel, usage?: { cacheRead?: number; cacheWrite?: number }): boolean {
    const override = this.store.overrides.read()[`${provider.id}/${model.id}`] ?? {};
    return [override.priceIn ?? model.inputPrice, override.priceOut ?? model.outputPrice,
      ...((usage?.cacheRead ?? 0) > 0 ? [model.cacheReadPrice] : []), ...((usage?.cacheWrite ?? 0) > 0 ? [model.cacheWritePrice] : [])]
      .every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  }

  /** 计算费用（美元） */
  costOf(provider: Provider, model: ProviderModel, usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): number {
    const ov = this.store.overrides.read()[`${provider.id}/${model.id}`] ?? {};
    const inPrice = ov.priceIn ?? model.inputPrice ?? 0;
    const outPrice = ov.priceOut ?? model.outputPrice ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const billableIn = Math.max(0, usage.input - cacheRead - cacheWrite);
    const raw =
      (billableIn / 1_000_000) * inPrice +
      (cacheRead / 1_000_000) * (model.cacheReadPrice ?? inPrice) +
      (cacheWrite / 1_000_000) * (model.cacheWritePrice ?? inPrice) +
      (usage.output / 1_000_000) * outPrice;
    return raw * (provider.rateMultiplier ?? 1);
  }

  resetCooldowns(): void {
    this.store.providers.update((list) =>
      list.map((p) => ({
        ...p,
        apiKeys: p.apiKeys.map((k) => ({ ...k, cooldownUntil: undefined, lastError: undefined })),
      })),
    );
    this.failCounts.clear();
    this.volatileCooldowns.clear();
    this.persistenceWarning = undefined;
  }
}

export const MODE_LABEL: Record<RouteMode, string> = {
  order: '依次',
  rotate: '轮换',
  weight: '按权重',
  usage: '用得少的优先',
  pace: '额度余量优先',
  smart: '健康与优先级',
};
