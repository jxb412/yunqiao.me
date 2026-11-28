import path from 'node:path';
import { parse } from 'smol-toml';
import type { AuroraStore } from '../store/index.js';
import type { Provider, ProviderModel } from '../store/types.js';
import { codexConfigPath } from '../codex.js';
import { providerAllowsAnonymous } from '../providerEndpoint.js';
import { applyContextDefaults, defaultAutoCompactTokenLimit, isValidContextWindow } from '../modelContext.js';
import { atomicWrite, readText } from './configFiles.js';
import { nativeModelId, readNativeModelMetadata, validatedNativeModel } from './nativeModelMetadata.js';
import { readManagedGatewayModelCatalog, serializeGatewayModelCatalog } from './catalogStorage.js';
import { readHistoryModelCoverage } from './historyModelCoverage.js';

export const CODEX_MODEL_CATALOG_FILE = 'codex-model-catalog.json';
const OWNER = 'yunqiao-api-gateway-v1';
export interface GatewayModelCatalog {
  models: Record<string, any>[];
  yunqiao: { kind: typeof OWNER; providerId: string };
}

export function isCodexTextModel(model: ProviderModel): boolean {
  return !!model.id && model.id.length <= 400 && !/[\s\u0000-\u001f]/.test(model.id)
    && !/(?:^|[-_./:])(?:image|audio|realtime|tts|transcribe|transcription|embedding|embeddings|whisper|speech|moderation|rerank|reranker|classifier|safety)(?:[-_./:]|$)/i.test(model.id)
    && !/(?:^|\/)(?:dall-e|sora|stable-diffusion|flux)(?:[-_.:/]|$)/i.test(model.id);
}

export function gatewayProviderAvailable(provider: Provider): boolean {
  if (!provider.enabled || provider.official) return false;
  try {
    const url = new URL(provider.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return provider.apiKeys.some(key => key.enabled && !!key.key.trim()) || providerAllowsAnonymous(url.hostname, provider.apiKeys);
  } catch { return false; }
}

/** Use exact local native templates; missing metadata falls back to ordinary API configuration. */
export function buildGatewayModelCatalog(provider: Provider, templates: readonly Record<string, any>[] = readNativeModelMetadata()): GatewayModelCatalog | undefined {
  const native = new Map<string, Record<string, any> | undefined>();
  for (const raw of templates) {
    const model = validatedNativeModel(raw);
    if (!model) continue;
    const id = nativeModelId(model.slug);
    // Ambiguous cache entries cannot authorize replacing the client's own model metadata.
    native.set(id, native.has(id) ? undefined : model);
  }
  const seen = new Set<string>();
  let incomplete = false;
  const models = gatewayProviderAvailable(provider) ? provider.models.filter(isCodexTextModel).flatMap(model => {
    const slug = `${provider.id}/${model.id}`;
    if (seen.has(slug)) return [];
    seen.add(slug);
    const template = native.get(nativeModelId(model.id));
    if (!template) { incomplete = true; return []; }
    const context = applyContextDefaults(model).contextWindow;
    const window = isValidContextWindow(context) ? context : template.context_window;
    if (!isValidContextWindow(window)) { incomplete = true; return []; }
    const thinkingDisabled = model.capabilities?.thinking === false || model.thinkingField === 'none';
    return [{ ...structuredClone(template), slug, display_name: model.displayName || model.id, description: `${provider.name} / ${model.id}`,
      priority: seen.size, visibility: 'list', supported_in_api: true,
      ...(thinkingDisabled ? { default_reasoning_level: null, supported_reasoning_levels: [] } : {}),
      additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null,
      ...(model.capabilities?.vision === true ? { input_modalities: ['text', 'image'] }
        : model.capabilities?.vision === false ? { input_modalities: ['text'] } : {}),
      context_window: window, max_context_window: window,
      effective_context_window_percent: 95, auto_compact_token_limit: defaultAutoCompactTokenLimit(window),
      prefer_websockets: false }];
  }) : [];
  if (incomplete) return undefined;
  const result: GatewayModelCatalog = { models, yunqiao: { kind: OWNER, providerId: provider.id } };
  // planned()/atomicWrite() read at most 4 MiB. Leave room for the ownership envelope.
  return Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8') < 4 * 1024 * 1024 - 8192 ? result : undefined;
}

/** 只刷新已挂载且带所有权标记的 API 网关目录；外部目录和直连配置不动。 */
export function refreshGatewayModelCatalog(store: AuroraStore): void {
  const configFile = codexConfigPath(), configBefore = readText(configFile);
  if (!configBefore) return;
  const root: any = parse(configBefore.replace(/^\uFEFF/, ''));
  const profile = typeof root.profile === 'string' ? root.profiles?.[root.profile] : undefined;
  const file = profile?.model_catalog_json ?? root.model_catalog_json;
  if ((profile?.model_provider ?? root.model_provider) !== 'yunqiao') return;
  const managed = readManagedGatewayModelCatalog(file, store.dir);
  if (!managed) return;
  const states = store.listAgents();
  const agent = [states['chatgpt-desktop'], states['codex-desktop'], states['codex-cli']]
    .find(value => value?.connected && value.mode === 'gateway' && value.authMode !== 'coexist');
  if (!agent?.providerId) return;
  const { text: before, catalog: previous } = managed;
  if (previous.yunqiao.providerId !== agent.providerId) return;
  const providers = store.listProviders(), providerRevision = store.providers.revision(providers);
  const provider = providers.find(value => value.id === agent.providerId);
  const catalog: GatewayModelCatalog | undefined = provider ? buildGatewayModelCatalog(provider)
    : { models: [], yunqiao: { kind: OWNER, providerId: agent.providerId } };
  if (!catalog) throw new Error('原生模型资料暂不完整，请重新应用客户端配置；上次目录保持不变');
  const after = serializeGatewayModelCatalog(catalog);
  if (after === before) return;
  const home = path.dirname(configFile), sqliteHome = process.env.AURORA_CLIENT_HOME ? home : process.env.CODEX_SQLITE_HOME || home;
  const selected = typeof agent.model === 'string' ? `${agent.providerId}/${agent.model}` : '';
  if (catalog.models.length && !readHistoryModelCoverage(configBefore, home, sqliteHome, catalog, selected).safe)
    throw new Error('历史模型预算需要兼容设置，请重新应用客户端配置；上次目录保持不变');
  if (readText(configFile) !== configBefore || store.providers.revision(providers) !== providerRevision) throw new Error('配置或供应商目录已变化，请重新刷新');
  atomicWrite(file, after, { existed: true, content: before });
}
