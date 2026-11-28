import { AuroraStore } from './store/index.js';
import { catalogPresets, ensureCatalog, refreshCatalog } from './catalog.js';
import { manageModels } from './modelManagement.js';
import { getLocalClientsSnapshot, syncLocalClients, restoreIgnoredLocalSource } from './localClients.js';
import { activeRequests } from './gateway/liveUsage.js';
import path from 'node:path';
import fs from 'node:fs';
import { applyContextDefaults, isChatgptTextModel, isValidContextWindow } from './modelContext.js';
import { readText, atomicWrite, digest, expectedPlanFiles, planned, restorePlanSnapshot, type PlannedFile } from './agents/configFiles.js';
import { runPermissionAction } from './agents/permissions.js';
import { getCoexistCatalog } from './gateway/coexist.js';
import { buildGatewayModelCatalog } from './agents/modelCatalog.js';
import { planGatewayModelCatalog, serializeGatewayModelCatalog } from './agents/catalogStorage.js';
import { readHistoryModelCoverage } from './agents/historyModelCoverage.js';
import { runExtensionAction } from './extensions/index.js';
import { AGENT_ADAPTERS, detectReset, getAdapter, connectionParameters, exportEnvScript, configureDesktopPath, codexPlan, planRevision, type ConnectContext } from './agents/adapters.js';
import { detectAllAsync, detectDesktopAsync } from './agents/detectionAsync.js';
import { resumeCommand } from './sessions.js';
import { scanSessionsAsync, readSessionAsync, exportSessionAsync, listCodexAssetsAsync } from './readOnlyJobs.js';
import { BUILTIN_MIDDLEWARE, SAMPLE_PLUGIN, getMiddlewareStatus } from './plugins/middleware.js';
import { desktopInfo, launchAndInject, injectorStatus, BUILTIN_INJECT_SCRIPTS } from './injector.js';
import { diagnoseSessions, repairSessions, toggleCodexAsset, readAgentsMd, writeAgentsMd, readCodexFlags, writeCodexFlag, CODEX_FLAGS } from './codex.js';
import { openUpstream, readAll } from './gateway/upstream.js';
import { buildUpstreamHttp, parseClientRequest } from './protocol/index.js';
import type { GatewayStatus } from './gateway/server.js';
import type { Provider, UsageRecord } from './store/types.js';
import { buildInfo } from './buildInfo.js';
import { providerAllowsAnonymous, providerEndpoint } from './providerEndpoint.js';
import { runHistoryRepairAction } from './historyRepair.js';
import { runSessionIndexRepairAction } from './sessionIndexRepair.js';
import {
  checkUpdate,
  fetchCloudCatalog,
  importCloudProviders,
} from './cloud.js';
import { GITHUB_RELEASE_PAGE } from './releaseSources.js';
import { providerBalance } from './providerBalance.js';
import { diagnoseClient } from './clientDiagnostics.js';
import { testClientConnection, cancelClientConnectionTest } from './clientConnectionTest.js';
import { prepareClientHistory, recoverClientHistory, applyClientHistory, historyPreviewRevision, clientConnectionRevision, clientHistoryContext, CODEX_STATE_IDS, type PreparedClientHistory } from './agentHistory.js';
import { assertClientsStopped, type HistoryContext } from './historyRepairIO.js';
import { discoverHistoryProviderIds } from './agents/historyProviders.js';

/**
 * 与 Electron 无关的动作层：桌面端的 IPC 和网关的 /api/rpc 共用同一份实现，
 * 这样 Web 控制台 / 手机端拿到的行为和桌面端完全一致。
 */

export interface ActionDeps {
  store: AuroraStore;
  gatewayStatus: () => GatewayStatus;
  gatewayUrl: () => string;
  startGateway?: () => Promise<void>;
  restartGateway?: () => Promise<void>;
  resetCooldowns?: () => void;
  platform?: string;
  version?: string;
  dataDir: string;
  localClientWarnings?: string[];
  /** Trusted main-process/test context; never populated from an RPC payload. */
  historyContext?: HistoryContext;
}

interface ClientFileSnapshot { path: string; existed: boolean; content: string }
interface ClientFileExpected { existed: boolean; hash: string }
// A preview open in this process must not expire while the customer decides.
// Bound the cache by recent usage, never by elapsed time.
const historyProviderSnapshots = new Map<string, readonly string[]>();
const historyProviderSnapshotKey = (deps: ActionDeps, configPath: string, revision: string) => JSON.stringify([path.resolve(deps.store.dir), path.resolve(configPath), revision]);
function rememberHistoryProviders(deps: ActionDeps, configPath: string, revision: string, ids: readonly string[]) {
  const key = historyProviderSnapshotKey(deps, configPath, revision); historyProviderSnapshots.delete(key);
  while (historyProviderSnapshots.size >= 128) historyProviderSnapshots.delete(historyProviderSnapshots.keys().next().value!);
  historyProviderSnapshots.set(key, Object.freeze([...ids]));
}
interface GatewayCatalogPreviewSnapshot {
  enabled: boolean;
  clientRevision: string;
  connectionRevision: string;
  catalog?: { path: string; existed: boolean; beforeDigest: string; afterDigest: string; revision: string };
}
const gatewayCatalogSnapshots = new Map<string, GatewayCatalogPreviewSnapshot>();
function rememberGatewayCatalog(deps: ActionDeps, configPath: string, revision: string, snapshot: GatewayCatalogPreviewSnapshot) {
  const key = historyProviderSnapshotKey(deps, configPath, revision); gatewayCatalogSnapshots.delete(key);
  while (gatewayCatalogSnapshots.size >= 128) gatewayCatalogSnapshots.delete(gatewayCatalogSnapshots.keys().next().value!);
  gatewayCatalogSnapshots.set(key, structuredClone(snapshot));
}
function snapshotClientFiles(paths: string[]): ClientFileSnapshot[] {
  return paths.map(file => ({ path: file, content: readText(file), existed: fs.existsSync(file) }));
}
/** Never undo another application's edit while recovering a failed state commit. */
function rollbackClientFiles(files: ClientFileSnapshot[], expected: Map<string, ClientFileExpected>): string[] {
  const failed: string[] = [];
  for (const file of [...files].reverse()) {
    try {
      const current = snapshotClientFiles([file.path])[0], currentHash = digest(current.content);
      if (current.existed === file.existed && currentHash === digest(file.content)) continue;
      const applied = expected.get(file.path);
      if (!applied || current.existed !== applied.existed || currentHash !== applied.hash) { failed.push(file.path); continue; }
      if (file.existed) atomicWrite(file.path, file.content, { existed: current.existed, content: current.content });
      else if (current.existed) fs.unlinkSync(file.path);
    } catch { failed.push(file.path); }
  }
  return failed;
}
function clientStateFailure(files: ClientFileSnapshot[], expected: Map<string, ClientFileExpected>, backup?: string, reason = '无法保存客户端连接状态') {
  const failed = rollbackClientFiles(files, expected);
  detectReset();
  return { ok: false, ...(backup ? { backup } : {}), message: `${reason}；${failed.length ? `部分配置无法自动回滚或已被其他程序修改，请手动检查：${failed.join('、')}` : '已恢复本次操作前的客户端配置'}${backup ? `；首次接入前备份保留：${backup}` : ''}` };
}

const settingsQueues = new WeakMap<AuroraStore, Promise<unknown>>();
async function saveSettingsAndRestart(deps: ActionDeps, payload: any) {
  const previous = settingsQueues.get(deps.store) || Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    const before = deps.store.getSettings();
    const next = deps.store.saveSettings(payload);
    try {
      if (next.gatewayPort !== before.gatewayPort || next.gatewayHost !== before.gatewayHost || next.lanShare !== before.lanShare) await deps.restartGateway?.();
    } catch (error) {
      try { deps.store.settings.restoreIfUnchanged(before, next); }
      catch {
        try { await deps.restartGateway?.(); }
        catch { throw new Error('网关重启失败；配置随后已变化或无法恢复，已保留当前文件，当前网关也未能启动，请检查系统设置'); }
        throw new Error('网关重启失败；配置随后已变化或无法恢复，已保留当前文件并按当前配置恢复网关，请检查系统设置');
      }
      try { await deps.restartGateway?.(); }
      catch (restoreError) { throw new Error(`${String((error as Error).message)}；原配置已还原，但原网关重启失败：${String((restoreError as Error).message)}`); }
      throw error;
    }
    return next;
  });
  settingsQueues.set(deps.store, task);
  try { return await task; }
  finally { if (settingsQueues.get(deps.store) === task) settingsQueues.delete(deps.store); }
}


/** 各客户端的官方下载地址（拿不准的留空，界面上就不显示按钮，避免给错链接） */
const store = (q: string) => 'ms-windows-store://search/?query=' + encodeURIComponent(q);

const AGENT_DOWNLOADS: Record<string, { win?: string; winAlt?: string; mac?: string; linux?: string; note?: string }> = {
  'claude-code': { win: store('Node.js LTS'), winAlt: 'https://docs.claude.com/en/docs/claude-code/setup', mac: 'https://docs.claude.com/en/docs/claude-code/setup', linux: 'https://docs.claude.com/en/docs/claude-code/setup', note: '需要 Node.js 18+，装完运行 claude 登录' },
  'claude-desktop': { win: store('Claude'), winAlt: 'https://claude.ai/download', mac: 'https://claude.ai/download', note: '官方桌面客户端' },
  'codex-cli': { win: store('Windows Terminal'), winAlt: 'https://github.com/openai/codex/releases', mac: 'https://github.com/openai/codex/releases', linux: 'https://github.com/openai/codex/releases', note: 'Codex CLI 与桌面版同源' },
  'codex-desktop': { win: store('Codex'), winAlt: 'https://chatgpt.com/codex', mac: 'https://chatgpt.com/codex', note: '从 ChatGPT 官网下载 Codex 桌面版' },
  'chatgpt-desktop': { win: store('ChatGPT'), winAlt: 'https://chatgpt.com/download', mac: 'https://chatgpt.com/download', note: '官方桌面客户端' },
  'gemini-cli': { win: store('Node.js LTS'), winAlt: 'https://github.com/google-gemini/gemini-cli', mac: 'https://github.com/google-gemini/gemini-cli', linux: 'https://github.com/google-gemini/gemini-cli', note: 'npm i -g @google/gemini-cli' },
  'qwen-code': { win: 'https://github.com/QwenLM/qwen-code', mac: 'https://github.com/QwenLM/qwen-code', linux: 'https://github.com/QwenLM/qwen-code' },
  opencode: { win: 'https://github.com/sst/opencode', mac: 'https://github.com/sst/opencode', linux: 'https://github.com/sst/opencode' },
  deepseek: { win: 'https://platform.deepseek.com', mac: 'https://platform.deepseek.com', note: '先去开放平台拿 API Key' },
  'kimi-code': { win: 'https://platform.moonshot.cn', mac: 'https://platform.moonshot.cn' },
  antigravity: { win: 'https://antigravity.google', mac: 'https://antigravity.google' },
};

function downloadsFor(id: string) {
  const d = AGENT_DOWNLOADS[id];
  if (!d) return undefined;
  const isWin = process.platform === 'win32';
  return {
    ...d,
    current: isWin ? d.win : process.platform === 'darwin' ? d.mac : d.linux,
    alt: isWin ? d.winAlt : undefined,
    storeHint: isWin,
  };
}
function extractErr(text: string): string {
  try {
    const j = JSON.parse(text);
    return j?.error?.message ?? j?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export async function testProvider(deps: ActionDeps, payload: { providerId: string; model?: string }) {
  const p = deps.store.getProvider(payload.providerId);
  if (!p) return { ok: false, message: '供应商不存在' };
  const key = p.apiKeys.find((k) => k.enabled && k.key.trim());
  let local = false;
  try { local = providerAllowsAnonymous(new URL(p.baseUrl).hostname, p.apiKeys); } catch { return { ok: false, message: '供应商地址无效' }; }
  if (!key?.key && !local)
    return { ok: false, message: '这家供应商还没有填 API Key' };
  const model = payload.model ?? p.models[0]?.id ?? '';
  if (!model) return { ok: false, message: '还没有配置模型' };
  const t0 = Date.now();
  try {
    const ir = parseClientRequest('openai-chat', {
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
      stream: false,
    });
    const req = buildUpstreamHttp(
      ir,
      {
        baseUrl: p.baseUrl,
        apiKey: key?.key || '',
        format: p.format,
        model,
        maxTokens: 8,
        extraHeaders: p.headers,
        supportsThinking: false,
      },
      'openai-chat',
    );
    const res = await openUpstream(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      proxy: p.proxy || deps.store.getSettings().proxy || undefined,
      timeoutMs: 30000,
    });
    const text = await readAll(res.stream, 512 * 1024);
    let response: any;
    try { response = JSON.parse(text); } catch { /* invalid API response */ }
    const valid = response && !response.error && (
      p.format === 'anthropic' ? response.type === 'message' && Array.isArray(response.content) :
      p.format === 'openai-chat' ? Array.isArray(response.choices) && !!response.choices[0]?.message :
      p.format === 'openai-responses' ? Array.isArray(response.output) && response.status !== 'failed' :
      Array.isArray(response.candidates) && response.candidates.length > 0
    );
    const ok = res.status >= 200 && res.status < 300 && !!valid;
    return {
      ok,
      status: res.status,
      latencyMs: Date.now() - t0,
      message: ok ? `连通正常（${Date.now() - t0}ms）` : (response?.error || res.status >= 400 ? extractErr(text) : `接口返回 HTTP ${res.status}，但内容不符合 ${p.format} 响应格式`),
      sample: text.slice(0, 800),
    };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e), latencyMs: Date.now() - t0 };
  }
}

async function readProviderModelPages(endpoint: string, format: Provider['format'], headers: Record<string, string>, proxy?: string):
  Promise<{ records: any[] } | { error: string } | undefined> {
  const url = new URL(endpoint);
  const cursors = new Set<string>();
  const records: any[] = [];
  const signal = AbortSignal.timeout(60_000);
  let bytes = 0;
  for (let page = 1; page <= 100; page++) {
    let json;
    try {
      const res = await openUpstream(url.href, { method: 'GET', headers, proxy, timeoutMs: 15000, signal });
      const text = await readAll(res.stream, 4 * 1024 * 1024);
      if (res.status >= 200 && res.status < 300) json = JSON.parse(text);
      bytes += Buffer.byteLength(text);
    } catch { /* Try the alternate models path only when the first page is unavailable. */ }
    const list = json?.data ?? json?.models;
    if (!Array.isArray(list) || json.error) {
      return page === 1 ? undefined : { error: `模型列表第 ${page} 页读取失败，已保留本地模型，请重试` };
    }
    if (records.length + list.length > 10000 || bytes > 16 * 1024 * 1024) {
      return { error: '模型列表超过同步大小上限，已保留本地模型' };
    }
    records.push(...list);
    let cursor;
    if (format === 'gemini') {
      cursor = json.nextPageToken;
      if (cursor == null || cursor === '') return { records };
    } else if (format === 'anthropic') {
      if (json.has_more == null || json.has_more === false) return { records };
      cursor = json.has_more === true ? json.last_id : undefined;
    } else return { records };
    if (typeof cursor !== 'string' || !cursor.trim() || cursors.has(cursor)) {
      return { error: '模型列表分页游标无效或重复，已保留本地模型' };
    }
    cursors.add(cursor);
    url.searchParams.set(format === 'gemini' ? 'pageToken' : 'after_id', cursor);
  }
  return { error: '模型列表超过 100 页仍未读完，已保留本地模型' };
}

export async function fetchProviderModels(deps: ActionDeps, payload: { providerId: string }) {
  const p = deps.store.getProvider(payload.providerId);
  if (!p) return { ok: false, models: [], message: '供应商已不存在，请刷新列表' };
  if (typeof p.baseUrl !== 'string' || !p.baseUrl.trim()) return { ok: false, models: p.models, message: '请先填写供应商的实际 API 地址，再同步模型' };
  let endpoint;
  try { endpoint = providerEndpoint(p.baseUrl, p.format); }
  catch { return { ok: false, models: p.models, message: '供应商接口地址无效，请检查后重新同步模型' }; }
  const connection = (provider: Provider) => JSON.stringify({ baseUrl: provider.baseUrl, format: provider.format,
    headers: provider.headers, proxy: provider.proxy || deps.store.getSettings().proxy,
    keys: provider.apiKeys.map(k => ({ key: k.key, enabled: k.enabled })) });
  const startedConnection = connection(p), startedModels = new Set(p.models.map(m => m.id));
  const key = p.apiKeys.find(k => k.enabled && k.key.trim())?.key;
  const { baseUrl: base, version } = endpoint;
  const urls = version ? [`${base}/models`] : p.format === 'gemini'
    ? [`${base}/v1beta/models`] : [`${base}/v1/models`, `${base}/models`];
  const headers: Record<string, string> = {};
  if (p.format === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
  } else if (key) {
    if (p.format === 'gemini') headers['x-goog-api-key'] = key;
    else headers.authorization = `Bearer ${key}`;
  }
  for (const url of urls) {
    try {
      const catalog = await readProviderModelPages(url, p.format, { ...headers, ...p.headers }, p.proxy || deps.store.getSettings().proxy || undefined);
      if (!catalog) continue;
      if ('error' in catalog) return { ok: false, models: deps.store.getProvider(p.id)?.models || [], message: catalog.error };
      const list = catalog.records;
      const nonChatEndpoints = new Set(['image-generation', 'openai-video', 'embeddings', 'jina-rerank']);
      let skippedNonChat = false;
      const models = list.flatMap((x: any) => {
        const rawId = x?.id ?? x?.name;
        if (typeof rawId !== 'string') return [];
        const id = rawId.replace(/^models\//, '').trim();
        if (!id || id.length > 512 || /[\s\u0000-\u001f]/.test(id)) return [];
        // New API lists the primary endpoint first, including for image generators that also expose a chat facade.
        if (Array.isArray(x.supported_endpoint_types) && nonChatEndpoints.has(x.supported_endpoint_types[0])) {
          skippedNonChat = true;
          return [];
        }
        const context = x.context_window ?? x.input_token_limit ?? x.inputTokenLimit;
        const thinking = [x.capabilities?.thinking, x.capabilities?.reasoning, x.reasoning].find(value => typeof value === 'boolean');
        const explicitVision = [x.capabilities?.vision, x.vision, x.supports_vision].find(value => typeof value === 'boolean');
        const modalities = [x.input_modalities, x.architecture?.input_modalities, x.modalities?.input]
          .find(value => Array.isArray(value) && value.length && value.every(item => typeof item === 'string' && item.length));
        const vision = explicitVision ?? (modalities ? modalities.includes('image') : undefined);
        const capabilities = { ...(typeof thinking === 'boolean' ? { thinking } : {}), ...(typeof vision === 'boolean' ? { vision } : {}) };
        return [{ id, ...(isValidContextWindow(context) ? { contextWindow: context } : {}),
          ...(Object.keys(capabilities).length ? { capabilities } : {}) }];
      });
      if (models.length || skippedNonChat) {
        // A network response must not restore a deleted provider or overwrite edits made while it was loading.
        const current = deps.store.getProvider(p.id);
        if (!current) return { ok: false, models: [], message: '供应商已删除，本次同步结果已丢弃' };
        if (connection(current) !== startedConnection) return { ok: false, models: current.models, message: '供应商连接配置已变化，请重新同步模型' };
        if (!models.length) return { ok: false, models: current.models, message: '供应商返回的列表中没有可同步的对话模型' };
        const merged = [...current.models];
        const modelIndex = new Map(merged.map((model, index) => [model.id, index]));
        for (const m of models) {
          const index = modelIndex.get(m.id);
          if (index !== undefined) {
            // Existing explicit limits are local choices; synchronization never replaces them.
            if (merged[index].contextWindow === undefined && isChatgptTextModel(m.id)) merged[index] = applyContextDefaults({ ...merged[index], contextWindow: m.contextWindow });
            for (const capability of ['thinking', 'vision'] as const) {
              if (merged[index].capabilities?.[capability] === undefined && m.capabilities?.[capability] !== undefined) {
                merged[index] = { ...merged[index], capabilities: { ...merged[index].capabilities, [capability]: m.capabilities[capability] } };
              }
            }
          } else if (!startedModels.has(m.id)) {
            modelIndex.set(m.id, merged.length);
            merged.push(applyContextDefaults(m));
          }
        }
        let savedModels = merged;
        try { if (merged.length !== current.models.length || merged.some((model, index) => model !== current.models[index])) savedModels = deps.store.saveProvider({ ...current, models: merged }).models; }
        catch { return { ok: false, models: current.models, message: '模型已获取，但本地保存失败，请检查数据目录后重试' }; }
        return { ok: true, models: savedModels, added: merged.length - current.models.length };
      }
    } catch {
      continue;
    }
  }
  return { ok: false, models: deps.store.getProvider(p.id)?.models || [], message: '这家供应商没有公开的模型列表接口，请手动添加模型' };
}

export function summarizeUsage(records: UsageRecord[]) {
  const byDay = new Map<string, { cost: number; tokens: number; calls: number; unpricedCalls: number }>();
  const byProvider = new Map<string, { cost: number; tokens: number; calls: number; unpricedCalls: number; name: string }>();
  const byModel = new Map<string, { cost: number; tokens: number; calls: number; unpricedCalls: number }>();
  const byAgent = new Map<string, { calls: number; tokens: number }>();
  let totalIn = 0,
    totalOut = 0,
    totalCost = 0,
    totalCache = 0,
    totalCacheWrite = 0,
    cacheInput = 0,
    cacheReports = 0,
    cacheWriteReports = 0,
    errors = 0,
    unpricedCalls = 0;

  for (const r of records) {
    const day = r.ts.slice(0, 10);
    const tokens = r.inputTokens + r.outputTokens;
    totalIn += r.inputTokens;
    totalOut += r.outputTokens;
    const unknownPrice = r.costKnown === false && r.status >= 200 && r.status < 300 ? 1 : 0;
    const cost = r.costKnown === false ? 0 : r.cost;
    unpricedCalls += unknownPrice;
    totalCost += cost;
    totalCache += r.cacheRead || 0;
    totalCacheWrite += r.cacheWrite || 0;
    if (r.cacheWriteKnown || r.cacheWrite > 0) cacheWriteReports++;
    if (r.cacheReadKnown || r.cacheRead > 0) { cacheInput += r.inputTokens; cacheReports++; }
    if (r.error || r.status < 200 || r.status >= 400) errors++;
    const d = byDay.get(day) ?? { cost: 0, tokens: 0, calls: 0, unpricedCalls: 0 };
    byDay.set(day, { cost: d.cost + cost, tokens: d.tokens + tokens, calls: d.calls + 1, unpricedCalls: d.unpricedCalls + unknownPrice });
    const p = byProvider.get(r.providerId) ?? { cost: 0, tokens: 0, calls: 0, unpricedCalls: 0, name: r.providerName };
    byProvider.set(r.providerId, { cost: p.cost + cost, tokens: p.tokens + tokens, calls: p.calls + 1, unpricedCalls: p.unpricedCalls + unknownPrice, name: r.providerName });
    const mo = byModel.get(r.model) ?? { cost: 0, tokens: 0, calls: 0, unpricedCalls: 0 };
    byModel.set(r.model, { cost: mo.cost + cost, tokens: mo.tokens + tokens, calls: mo.calls + 1, unpricedCalls: mo.unpricedCalls + unknownPrice });
    const ag = byAgent.get(r.agent) ?? { calls: 0, tokens: 0 };
    byAgent.set(r.agent, { calls: ag.calls + 1, tokens: ag.tokens + tokens });
  }

  return {
    totals: {
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheRead: totalCache,
      cacheWrite: totalCacheWrite,
      cacheRate: cacheInput ? Math.min(1, totalCache / cacheInput) : 0,
      cacheReports,
      cacheWriteReports,
      cost: totalCost,
      unpricedCalls,
      calls: records.length,
      errors,
    },
    byDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => (a.day < b.day ? -1 : 1)),
    byProvider: [...byProvider.entries()].map(([id, v]) => ({ id, ...v })),
    byModel: [...byModel.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.cost - a.cost),
    byAgent: [...byAgent.entries()].map(([id, v]) => ({ id, ...v })),
  };
}

/** 返回 null 表示「这个动作需要桌面端处理」 */
export async function runAction(deps: ActionDeps, action: string, payload: any): Promise<any | null> {
  const store = deps.store;
  payload = payload ?? {};
  if (action.startsWith('extension.')) return runExtensionAction(deps, action, payload);
  if (action === 'agent.permissions.preview' || action === 'agent.permissions.restore') return runPermissionAction(deps, action, payload);
  configureDesktopPath(store.readExtra<any>('extensions.json', {})?.connection?.exePath);
  if (action.startsWith('codex.repair.')) return runHistoryRepairAction(action, payload);
  if (action.startsWith('codex.indexRepair.')) return runSessionIndexRepairAction(action, payload);
  switch (action) {
    case 'state.get': {
      const catalog = await ensureCatalog(store);
      const { nativeCatalog: _native, ...codexCoexist } = getCoexistCatalog(store);
      const agents = store.listAgents();
      if (!agents['chatgpt-desktop'] && agents['codex-desktop']) store.saveAgent({ ...agents['codex-desktop'], id: 'chatgpt-desktop' });
      const localClients = getLocalClientsSnapshot(store), localWarnings = deps.localClientWarnings || [];
      return {
        settings: store.getSettings(),
        providers: store.listProviders(),
        localClients: { ...localClients, ok: localClients.ok && !localWarnings.length, warnings: [...localClients.warnings, ...localWarnings] },
        codexCoexist,
        groups: store.listGroups(),
        agents: store.listAgents(),
        plugins: store.listPlugins(),
        middlewareStatus: getMiddlewareStatus(store),
        presets: catalogPresets(store, catalog),
        catalog: { source: catalog.source, fetchedAt: catalog.fetchedAt, version: catalog.version, warning: catalog.warning, syncing: catalog.syncing },
        builtinMiddleware: BUILTIN_MIDDLEWARE.map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description,
          defaultOptions: b.defaultOptions,
        })),
        agentCatalog: AGENT_ADAPTERS.map((a) => ({
          id: a.id,
          name: a.name,
          vendor: a.vendor,
          description: a.description,
          protocol: a.protocol,
          hotSwitch: a.hotSwitch,
          needsInstall: a.needsInstall,
          support: a.support,
          category: a.category,
          supportNote: a.supportNote,
          docsUrl: a.docsUrl,
          configPath: a.configPaths()[0],
          launchHint: a.launchHint(''),
          downloads: downloadsFor(a.id),
        })),
        gateway: deps.gatewayStatus(),
        gatewayUrl: deps.gatewayUrl(),
        dataDir: deps.dataDir,
        version: deps.version ?? '0.1.0',
        build: buildInfo,
        platform: deps.platform ?? process.platform,
        detected: await detectAllAsync({ background: true }),
        mode: deps.platform === 'web' ? 'web' : 'desktop',
      };
    }

    case 'provider.save':
      return store.saveProvider(payload);
    case 'model.batch.preview':
      return manageModels(store, payload);
    case 'model.batch.apply':
      return manageModels(store, payload, true);
    case 'provider.delete':
      store.deleteProvider(payload.id);
      return { ok: true };
    case 'provider.test':
      return testProvider(deps, payload);
    case 'provider.models':
      return fetchProviderModels(deps, payload);
    case 'provider.balance':
      return providerBalance(store, payload);
    case 'provider.resetCooldown':
      deps.resetCooldowns?.();
      return { ok: true };

    /* ---------- 云端 ---------- */
    case 'localClients.scan':
    case 'localClients.restore': {
      if (deps.platform === 'web') return { ok: false, message: '请在电脑端检测与导入本地客户端配置' };
      return action === 'localClients.restore'
        ? restoreIgnoredLocalSource(store, String(payload.sourceId || ''), { gatewayUrl: deps.gatewayUrl() })
        : syncLocalClients(store, { force: true, gatewayUrl: deps.gatewayUrl() });
    }
    case 'cloud.catalog': {
      const data = payload.url && payload.url !== store.getSettings().catalogUrl
        ? await fetchCloudCatalog(payload.url, store)
        : payload.refresh ? await refreshCatalog(store) : await ensureCatalog(store);
      return { ok: true, ...data };
    }
    case 'cloud.import': {
      const items = payload.providers ?? [];
      const r = importCloudProviders(store, items);
      return { ok: true, added: r.added, merged: r.merged, count: r.providers.length };
    }
    case 'update.check': {
      try {
        return { ok: true, ...(await checkUpdate(deps.version ?? payload.current ?? '0.1.0', { platform: payload.platform, arch: payload.arch, source: payload.source, minimumVersion: payload.minimumVersion })) };
      } catch (e: any) {
        return { ok: false, message: String(e?.message ?? e), fallbackUrl: '', releaseUrl: GITHUB_RELEASE_PAGE };
      }
    }
    case 'account.scan':
      return { ok: true, accounts: getLocalClientsSnapshot(store).accounts };
    case 'account.import': {
      return { ok: false, message: '本机 API 配置已改为自动发现，请在“我的供应商”重新扫描。官方账号登录凭据不作为 API Key 导入。' };
    }

    /* ---------- Codex 增强 ---------- */
    case 'codex.diagnose':
      return diagnoseSessions();
    case 'codex.repairSessions':
      return { ok: false, message: '请使用历史会话中的批量修复，先预览范围后执行；旧版全库直接改写入口已停用。' };
    case 'codex.assets':
      return { ok: true, assets: await listCodexAssetsAsync() };
    case 'codex.toggleAsset':
      return toggleCodexAsset(payload.id, !!payload.enabled);
    case 'codex.readAgents':
      return { ok: true, text: readAgentsMd() };
    case 'codex.writeAgents':
      return writeAgentsMd(String(payload.text ?? ''));
    case 'codex.flags':
      return { ok: true, flags: readCodexFlags(), schema: CODEX_FLAGS };
    case 'inject.info': {
      const st = store.getSettings();
      const info = await desktopInfo(st.codexVersion);
      return { ok: true, info, scripts: injectScripts(store) };
    }
    case 'inject.status':
      return { ok: true, ...(await injectorStatus()) };
    case 'inject.run': {
      const st = store.getSettings();
      const info = await desktopInfo(st.codexVersion);
      if (info.version) store.saveSettings({ codexVersion: info.version });
      return launchAndInject(injectScripts(store));
    }
    case 'inject.saveScript': {
      const list = injectScripts(store);
      const s = payload.script;
      const i = list.findIndex((x) => x.id === s.id);
      if (i >= 0) list[i] = { ...list[i], ...s };
      else list.push({ id: 'inject:' + Date.now(), name: s.name || '自定义', code: s.code || '', enabled: true });
      store.saveSettings({ codexVersion: store.getSettings().codexVersion });
      writeInjectScripts(store, list);
      return { ok: true, scripts: list };
    }
    case 'inject.deleteScript': {
      const list = injectScripts(store).filter((x) => x.id !== payload.id);
      writeInjectScripts(store, list);
      return { ok: true, scripts: list };
    }
    case 'codex.setFlag':
      return writeCodexFlag(String(payload.key), String(payload.value));

    case 'group.save':
      return store.saveGroup(payload);
    case 'group.delete':
      store.deleteGroup(payload.id);
      return { ok: true };

    case 'settings.save':
      return saveSettingsAndRestart(deps, payload);

    case 'agent.detect':
      detectReset();
      return await detectAllAsync();
    case 'agent.diagnose':
      return diagnoseClient(deps, payload);
    case 'agent.test':
      return testClientConnection(deps, payload);
    case 'agent.test.cancel':
      return cancelClientConnectionTest(deps, payload);
    case 'agent.preview':
    case 'agent.parameters':
    case 'agent.connect': {
      try {
      const adapter = getAdapter(String(payload.agentId || ''));
      if (!adapter) return { ok: false, message: '未知客户端' };
      if (adapter.support === 'unsupported') return { ok: false, message: adapter.supportNote, files: [], warnings: [] };
      const sharedCodex = adapter.id === 'codex-cli' || adapter.id === 'chatgpt-desktop';
      if (sharedCodex && action !== 'agent.parameters') {
        const recovered = await recoverClientHistory(deps);
        if (!recovered.ok) return { ...recovered, files: [], warnings: [] };
      }
      const desktopDetection = adapter.id === 'chatgpt-desktop'
        ? await detectDesktopAsync(store.readExtra<any>('extensions.json', {})?.connection?.exePath, action === 'agent.connect')
          .catch(() => ({ installed: false, supportsCodexConfig: false, evidence: [] }))
        : undefined;
      const authMode = payload.authMode || 'api';
      if (!['api', 'coexist'].includes(authMode) || (authMode === 'coexist' && !sharedCodex)) return { ok: false, message: '此客户端不支持所选账号模式' };
      if (action === 'agent.parameters' && authMode === 'coexist') return { ok: false, message: '共存模式请通过配置向导应用；官方登录由原客户端使用，不导出登录凭据。' };
      const coexist = authMode === 'coexist' ? getCoexistCatalog(store) : undefined;
      if (coexist && !coexist.officialModelCount) return { ok: false, message: coexist.warnings[0] || '请先在官方客户端登录并加载模型列表，再开启共存模式。' };
      if (coexist && !['127.0.0.1', '0.0.0.0', '::'].includes(store.getSettings().gatewayHost)) return { ok: false, message: '共存模式需要本机网关。请在系统设置中选择“仅本机”或“局域网”监听范围。' };
      const provider = sharedCodex && authMode === 'coexist' && payload.providerId === 'official' ? {
        id: 'official', name: 'ChatGPT 官方账号', format: 'openai-responses' as const, baseUrl: 'https://chatgpt.com/backend-api/codex',
        apiKeys: [], models: coexist!.models.filter(m => m.official).map(m => ({ id: m.upstreamModel, displayName: m.displayName, contextWindow: m.contextWindow })),
        enabled: true, priority: 0, createdAt: '', updatedAt: '',
      } : store.getProvider(String(payload.providerId || ''));
      if (!provider) return { ok: false, message: '请选择有效供应商' };
      if (payload.mode && !['gateway', 'direct'].includes(payload.mode)) return { ok: false, message: '不支持的接入模式' };
      const states = store.listAgents();
      const prior = states[adapter.id] || (sharedCodex ? states['codex-cli'] || states['chatgpt-desktop'] || states['codex-desktop'] : undefined);
      const configPath = sharedCodex ? adapter.configPaths()[0] : '';
      let historyProviderIds: readonly string[] | undefined;
      if (sharedCodex) {
        const snapshot = typeof payload.revision === 'string' ? historyProviderSnapshots.get(historyProviderSnapshotKey(deps, configPath, payload.revision)) : undefined;
        if (snapshot) { historyProviderIds = snapshot; rememberHistoryProviders(deps, configPath, payload.revision, snapshot); }
        else {
          try { const home = path.dirname(configPath); historyProviderIds = discoverHistoryProviderIds(readText(configPath), home, deps.historyContext?.sqliteHome || (process.env.AURORA_CLIENT_HOME ? home : process.env.CODEX_SQLITE_HOME || home)); }
          catch { historyProviderIds = []; }
        }
      }
      const context: ConnectContext = {
        provider, model: String(payload.model || provider.models[0]?.id || ''), modelMap: payload.modelMap,
        mode: payload.mode || 'gateway', gatewayUrl: deps.gatewayUrl(), token: store.getSettings().gatewayToken, globalProxy: store.getSettings().proxy,
        previousBackup: prior?.connected || prior?.pendingReapply ? prior.backupPath : undefined,
        expectedRevision: payload.revision,
        authMode, permissionMode: payload.permissionMode ?? 'preserve', skipOnboarding: payload.skipOnboarding ?? false,
        modelCatalogPath: path.join(store.dir, 'codex-model-catalog.json'),
        desktopDetection,
        historyProviderIds,
      };
      const reviewedConnectionRevision = sharedCodex ? clientConnectionRevision(deps) : '';
      let nativeCatalog = coexist?.nativeCatalog;
      let catalogPlan: PlannedFile | undefined;
      let compatibleModelSettings = false;
      let acceptedCatalogDowngrade = false;
      let validateCatalogPreview: (() => void) | undefined;
      if (sharedCodex && authMode === 'api' && context.mode === 'gateway' && action !== 'agent.parameters') {
        // A native catalog is optional. Missing metadata, busy/unreadable history or
        // an occupied catalog path must never prevent ordinary API configuration.
        compatibleModelSettings = true;
        const snapshot = action === 'agent.connect' && typeof payload.revision === 'string'
          ? gatewayCatalogSnapshots.get(historyProviderSnapshotKey(deps, configPath, payload.revision)) : undefined;
        try {
          // Keep a reviewed compatibility plan stable when the client exits or metadata appears.
          const candidate = snapshot?.enabled === false ? undefined : buildGatewayModelCatalog(provider);
          if (snapshot?.enabled) {
            // Only a verified optional-catalog change may reuse the original preview revision.
            // Payload choices, actual config bytes, provider state, catalog bytes and model
            // metadata must still describe exactly the plan the customer reviewed.
            validateCatalogPreview = () => {
              const original = snapshot.catalog;
              const live = buildGatewayModelCatalog(store.getProvider(provider.id)!);
              const current = original && live ? planned(original.path, serializeGatewayModelCatalog(live)) : undefined;
              if (!original || !current || clientConnectionRevision(deps) !== snapshot.connectionRevision
                || current.existed !== original.existed || digest(current.before) !== original.beforeDigest || digest(current.after) !== original.afterDigest
                || planRevision(codexPlan({ ...context, modelCatalogPath: original.path, gatewayModelCatalog: true })) !== snapshot.clientRevision
                || planRevision([current]) !== original.revision)
                throw new Error('配置或模型目录在预览后已变化，请重新预览再应用');
            };
            validateCatalogPreview();
          }
          if (candidate?.models.some(model => model.slug === `${provider.id}/${context.model}`)) {
            const configuration = readText(configPath);
            let compatibleHistory = false;
            try {
              const historyContext = clientHistoryContext(deps);
              // Starting a client after preview is harmless while current read-only
              // history evidence remains compatible. Otherwise use ordinary settings.
              if (!snapshot?.enabled) await assertClientsStopped(historyContext);
              compatibleHistory = readHistoryModelCoverage(configuration, historyContext.home, historyContext.sqliteHome, candidate, `${provider.id}/${context.model}`).safe;
            } catch { /* Optional history evidence selects the ordinary configuration path. */ }
            if (compatibleHistory) {
              catalogPlan = snapshot?.catalog ? planned(snapshot.catalog.path, serializeGatewayModelCatalog(candidate))
                : planGatewayModelCatalog(store.dir, candidate, configuration, { reuseManagedCurrent: !!context.previousBackup });
              nativeCatalog = candidate;
              context.modelCatalogPath = catalogPlan.path;
              context.gatewayModelCatalog = true;
              compatibleModelSettings = false;
            } else if (snapshot?.enabled) acceptedCatalogDowngrade = true;
          }
        } catch (error) {
          if (snapshot?.enabled) return { ok: false, message: String((error as Error).message) };
          // Keep the working configuration path and the selected root context limits.
        }
      }
      if (coexist) catalogPlan = planned(context.modelCatalogPath!, JSON.stringify(coexist.nativeCatalog, null, 2));
      const preview: ReturnType<typeof adapter.preview> & { history?: PreparedClientHistory['history'] } = adapter.preview(context);
      const clientRevision = preview.revision;
      if (compatibleModelSettings) preview.warnings.push('将保留客户端原生能力，并使用当前所选模型的上下文与 90% 自动压缩设置；配置仍可正常保存。');
      // 将目录内容和磁盘快照一起绑定到预览，防止目录独立修改后覆盖外部工作。
      if (catalogPlan && clientRevision) preview.revision = digest(JSON.stringify({ clientRevision, catalogRevision: planRevision([catalogPlan]) }));
      let history: PreparedClientHistory | undefined;
      if (sharedCodex && preview.ok && action !== 'agent.parameters') {
        const prepared = await prepareClientHistory(deps, codexPlan(context)[0].after, action === 'agent.preview');
        history = prepared; preview.history = history.history;
        if (clientConnectionRevision(deps) !== reviewedConnectionRevision) return { ...preview, ok: false, message: '供应商或连接状态在检查期间已变化，请重新预览' };
        preview.revision = historyPreviewRevision(preview.revision, history, reviewedConnectionRevision);
      }
      if (action === 'agent.preview' && sharedCodex && preview.ok && preview.revision) {
        rememberHistoryProviders(deps, configPath, preview.revision, context.historyProviderIds || []);
        if (authMode === 'api' && context.mode === 'gateway' && clientRevision) rememberGatewayCatalog(deps, configPath, preview.revision,
          { enabled: context.gatewayModelCatalog === true, clientRevision, connectionRevision: reviewedConnectionRevision,
            ...(catalogPlan ? { catalog: { path: catalogPlan.path, existed: catalogPlan.existed, beforeDigest: digest(catalogPlan.before),
              afterDigest: digest(catalogPlan.after), revision: planRevision([catalogPlan]) } } : {}) });
      }
      if (action === 'agent.preview' || !preview.ok) return preview;
      if (action === 'agent.parameters') return { ok: true, ...connectionParameters(context, adapter.protocol), script: exportEnvScript(context, adapter.protocol), note: adapter.supportNote };
      if (context.expectedRevision && context.expectedRevision !== preview.revision && !acceptedCatalogDowngrade) return { ok: false, message: '配置或连接参数在预览后已变化，请重新预览再应用' };
      if (context.mode === 'gateway' && !deps.gatewayStatus().running) {
        if (adapter.support !== 'automatic' || !deps.startGateway) return { ok: false, message: '本地网关未运行，请先启动网关后再应用配置' };
        try { await deps.startGateway(); } catch { /* Report startup failure without exposing connection details. */ }
        if (!deps.gatewayStatus().running) return { ok: false, message: '本地网关启动失败。请检查系统设置中的监听地址和端口占用后重试，客户端配置尚未写入。' };
        // The client or provider may have changed while the listener was starting.
        return await runAction({ ...deps, startGateway: undefined }, action, payload);
      }
      // The adapter independently checks only its client-file plan.
      context.expectedRevision = clientRevision;
      const catalogFile = context.modelCatalogPath!;
      if (history) {
        const files = codexPlan(context);
        if (planRevision(files) !== clientRevision) return { ok: false, message: '配置在检查历史期间已变化，请重新预览' };
        if (catalogPlan) files.push(catalogPlan);
        return await applyClientHistory(deps, {
          prepared: history, files,
          revalidate: () => {
            validateCatalogPreview?.();
            const liveCatalog = coexist ? getCoexistCatalog(store).nativeCatalog : nativeCatalog ? buildGatewayModelCatalog(store.getProvider(provider.id)!) : undefined;
            if (nativeCatalog && !coexist) {
              const historyContext = clientHistoryContext(deps);
              if (!liveCatalog || !readHistoryModelCoverage(readText(configPath), historyContext.home, historyContext.sqliteHome, liveCatalog, `${provider.id}/${context.model}`).safe)
                throw new Error('模型或历史预算在预览后变化，请重新预览');
            }
            const liveCatalogText = coexist ? JSON.stringify(liveCatalog, null, 2) : liveCatalog ? serializeGatewayModelCatalog(liveCatalog as NonNullable<ReturnType<typeof buildGatewayModelCatalog>>) : '';
            if (clientConnectionRevision(deps) !== reviewedConnectionRevision || planRevision(codexPlan(context)) !== clientRevision
              || (catalogPlan && (planRevision([planned(catalogFile, liveCatalogText)]) !== planRevision([catalogPlan]))))
              throw new Error('配置或模型目录在检查后已变化');
          },
          commit: () => {
            if (catalogPlan) atomicWrite(catalogFile, catalogPlan.after, { existed: catalogPlan.existed, content: catalogPlan.before });
            return adapter.connect(context);
          },
          states: result => CODEX_STATE_IDS.map(id => ({ id, connected: true, pendingReapply: false, providerId: provider.id, model: context.model,
            modelMap: context.modelMap, mode: context.mode, authMode, permissionMode: context.permissionMode, skipOnboarding: context.skipOnboarding,
            configPath: result.path, backupPath: result.backup })),
        });
      }
      let clientBefore: ClientFileSnapshot[], catalogBefore: ClientFileSnapshot[];
      try {
        const allowedPaths = new Set(adapter.configPaths().map(file => path.resolve(file)));
        const plannedPaths = preview.files.map(file => file.path);
        if (plannedPaths.some(file => !allowedPaths.has(path.resolve(file)))) throw new Error('客户端预览包含未知配置位置');
        clientBefore = snapshotClientFiles(plannedPaths);
        catalogBefore = coexist ? snapshotClientFiles([catalogFile]) : [];
      } catch { return { ok: false, message: '无法安全读取本次操作前的配置，未应用连接。请检查客户端配置与云桥数据目录权限。' }; }
      const catalogExpected = coexist ? new Map([[catalogFile, { existed: true, hash: digest(JSON.stringify(coexist.nativeCatalog, null, 2)) }]]) : new Map<string, ClientFileExpected>();
      if (coexist) {
        try { store.writeExtra('codex-model-catalog.json', coexist.nativeCatalog); }
        catch { return clientStateFailure(catalogBefore, catalogExpected, prior?.backupPath, '无法保存共存模型目录'); }
      }
      const result = adapter.connect(context);
      if (coexist && !result.ok) {
        const failed = rollbackClientFiles(catalogBefore, catalogExpected);
        if (failed.length) return { ...result, message: `${result.message}；模型目录无法自动回滚或已被其他程序修改，请手动检查：${failed.join('、')}` };
      }
      if (result.ok) {
        const ids = sharedCodex ? (['codex-cli', 'chatgpt-desktop', 'codex-desktop'] as const) : [adapter.id];
        let expected = new Map(catalogExpected);
        try {
          expected = new Map([...expectedPlanFiles(sharedCodex ? 'codex-cli' : adapter.id, result.backup, clientBefore), ...catalogExpected]);
          // Old Claude Desktop conversations store role aliases. Reapplying the same provider
          // should preserve their routing even when the new menu default changes.
          const oldDesktop = adapter.id === 'claude-desktop' && prior?.providerId === provider.id ? prior : undefined;
          const modelMap = context.modelMap ?? (oldDesktop?.model ? {
            sonnet: oldDesktop.modelMap?.sonnet || oldDesktop.model,
            opus: oldDesktop.modelMap?.opus || oldDesktop.model,
            haiku: oldDesktop.modelMap?.haiku || oldDesktop.model,
          } : undefined);
          store.saveAgents(ids.map(id => ({ id, connected: true, pendingReapply: false, providerId: provider.id, model: context.model, modelMap, mode: context.mode, authMode, permissionMode: context.permissionMode, skipOnboarding: context.skipOnboarding, configPath: result.path, backupPath: result.backup })));
        } catch { return clientStateFailure([...clientBefore, ...catalogBefore], expected, result.backup); }
      }
      return result;
      } catch { return { ok: false, message: '无法核验客户端配置或连接记录，未完成应用。请检查配置文件、磁盘空间和数据目录权限后重试。' }; }
    }
    case 'agent.disconnect': {
      const adapter = getAdapter(String(payload.agentId || ''));
      if (!adapter) return { ok: false, message: '未知客户端' };
      const sharedCodex = adapter.id === 'codex-cli' || adapter.id === 'chatgpt-desktop';
      if (sharedCodex) {
        const recovered = await recoverClientHistory(deps);
        if (!recovered.ok) return recovered;
      }
      const current = store.listAgents()[adapter.id];
      if (!current?.backupPath) return adapter.disconnect();
      if (sharedCodex) {
        try {
          const reviewedConnectionRevision = clientConnectionRevision(deps);
          const original = restorePlanSnapshot('codex-cli', current.backupPath, adapter.configPaths());
          const files = original.files;
          const history = await prepareClientHistory(deps, files[0].after, false, true);
          return await applyClientHistory(deps, {
              prepared: history, files,
              revalidate: () => {
                if (clientConnectionRevision(deps) !== reviewedConnectionRevision || restorePlanSnapshot('codex-cli', current.backupPath!, adapter.configPaths()).revision !== original.revision)
                  throw new Error('原始配置备份或当前配置已变化');
              },
              commit: () => ({ ...adapter.disconnect(current.backupPath), backup: current.backupPath }),
              states: () => CODEX_STATE_IDS.map(id => ({ id, connected: false, pendingReapply: false, backupPath: undefined })),
            });
        } catch { return { ok: false, message: '无法安全核验原配置和历史备份，当前连接保持不变。请检查备份目录与客户端配置。' }; }
      }
      let before: ClientFileSnapshot[], expected: Map<string, ClientFileExpected>;
      try {
        before = snapshotClientFiles(adapter.restorePaths?.(current.backupPath) ?? adapter.configPaths());
        expected = expectedPlanFiles(adapter.id === 'chatgpt-desktop' ? 'codex-cli' : adapter.id, current.backupPath, before, true);
      } catch { return { ok: false, message: '无法安全读取当前配置或原始备份，未断开连接。请检查客户端配置与备份目录权限。' }; }
      const result = adapter.disconnect(current?.backupPath);
      if (result.ok) {
        const ids = adapter.id === 'codex-cli' || adapter.id === 'chatgpt-desktop' ? (['codex-cli', 'chatgpt-desktop', 'codex-desktop'] as const) : [adapter.id];
        try { store.saveAgents(ids.map(id => ({ id, connected: false, pendingReapply: false, backupPath: undefined }))); }
        catch { return clientStateFailure(before, expected, current.backupPath); }
      }
      return result;
    }

    case 'plugin.save':
      return store.savePlugin(payload);
    case 'plugin.delete':
      store.deletePlugin(payload.id);
      return { ok: true };
    case 'plugin.sample':
      return SAMPLE_PLUGIN;

    case 'gateway.status':
      return deps.gatewayStatus();
    case 'gateway.url':
      return deps.gatewayUrl();
    case 'gateway.restart':
      await deps.restartGateway?.();
      return deps.gatewayStatus();

    case 'usage.recent':
      return store.recentRequests(200);
    case 'usage.live':
      return activeRequests(store);
    case 'usage.summary':
      return summarizeUsage(store.readUsage(payload?.days ?? 14));

    case 'sessions.scan':
      return scanSessionsAsync();
    case 'sessions.read':
      return readSessionAsync(payload.path);
    case 'sessions.resume':
      return { command: resumeCommand(payload.summary) };
    case 'sessions.export': {
      const md = await exportSessionAsync({ summary: payload.summary, path: payload.path });
      return { ok: true, markdown: md };
    }

    default:
      return null;
  }
}






/* ------------------------------ 注入脚本存取 ------------------------------ */

const INJECT_FILE = 'inject-scripts.json';

function injectScripts(store: AuroraStore): Array<{ id: string; name: string; code: string; enabled: boolean }> {
  const saved = store.readExtra<Array<{ id: string; name: string; code: string; enabled: boolean }> | null>(INJECT_FILE, null);
  if (saved && Array.isArray(saved)) return saved;
  return BUILTIN_INJECT_SCRIPTS.map((s) => ({ ...s }));
}

function writeInjectScripts(store: AuroraStore, list: Array<{ id: string; name: string; code: string; enabled: boolean }>): void {
  store.writeExtra(INJECT_FILE, list);
}


