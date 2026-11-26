/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ProviderBalanceQuery } from '../../../src/core/providerBalanceTypes';
export type { BalanceAdapter, ProviderBalanceQuery, ProviderBalanceEntry, ProviderBalanceItem, ProviderBalanceResult } from '../../../src/core/providerBalanceTypes';

export type ProtocolName = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini';

export interface ProviderModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutput?: number;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  capabilities?: { tools?: boolean; vision?: boolean; thinking?: boolean };
  thinkingField?: 'reasoning_effort' | 'enable_thinking' | 'none';
  _new?: boolean;
}

export interface ApiKey {
  id: string;
  label: string;
  key: string;
  hasKey?: boolean;
  enabled: boolean;
  weight: number;
  cooldownUntil?: string;
  lastError?: string;
  lastUsedAt?: string;
}

export interface Provider {
  id: string;
  name: string;
  presetId?: string;
  format: ProtocolName;
  baseUrl: string;
  apiKeys: ApiKey[];
  models: ProviderModel[];
  enabled: boolean;
  priority: number;
  headers?: Record<string, string>;
  proxy?: string;
  official?: boolean;
  color?: string;
  icon?: string;
  notes?: string;
  rateMultiplier?: number;
  quota?: { balance?: number; currency?: string; updatedAt?: string; windows?: Array<{ label: string; usedPercent: number; resetsAt?: string }> };
  balanceQuery?: ProviderBalanceQuery;
  createdAt: string;
  updatedAt: string;
}

export type RouteMode = 'order' | 'rotate' | 'weight' | 'usage' | 'pace' | 'smart';

export interface RoutingGroup {
  id: string;
  name: string;
  mode: RouteMode;
  members: Array<{ providerId: string; model: string | null; weight: number }>;
  enabled: boolean;
  retries: number;
  notes?: string;
  createdAt: string;
}

export interface Settings {
  language: 'zh-CN' | 'en-US';
  theme: 'dark' | 'light' | 'system';
  accent: string;
  gatewayHost: string;
  gatewayPort: number;
  autoStartGateway: boolean;
  launchAtLogin: boolean;
  closeToTray: boolean;
  proxy: string;
  maskSecrets: boolean;
  autoTrimContext: boolean;
  maxRetries: number;
  requestTimeoutMs: number;
  usageRetentionDays: number;
  lanShare: boolean;
  keepAwakeWhileSharing: boolean;
  gatewayToken: string;
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string;
  firstByteTimeoutMs: number;
  logRequests: boolean;
  catalogUrl: string;
  updateUrl: string;
  autoCheckUpdate: boolean;
  adminUrl: string;
  autoSyncModels: boolean;
  connectionUpdatedAt?: string;
  updatedAt: string;
}

export interface CloudProvider {
  key: string;
  name: string;
  vendor?: string;
  format: ProtocolName;
  baseUrl: string;
  region?: string;
  color?: string;
  icon?: string;
  docs?: string;
  note?: string;
  tags?: string[];
  official?: boolean;
  models?: ProviderModel[];
}

export interface CloudCatalog {
  ok: boolean;
  version: number;
  updatedAt: string;
  providers: CloudProvider[];
  source?: 'remote' | 'cache' | 'builtin';
  fetchedAt?: string;
  warning?: string;
}

export interface UpdateInfo {
  ok: boolean;
  version: string;
  notes: string;
  mandatory: boolean;
  hasUpdate: boolean;
  url: string;
  current: string;
  publishedAt?: string;
  message?: string;
  source?: 'github' | 'website';
  releaseUrl?: string;
  assetName?: string;
}

export interface LocalAccount {
  id: string;
  kind: 'claude' | 'chatgpt' | 'copilot' | 'gemini';
  label: string;
  source: string;
  clientId?: string;
  clientName?: string;
  email?: string;
  plan?: string;
  authKind?: 'api-key' | 'oauth';
  importable?: boolean;
  credentialStatus?: 'present' | 'expired' | 'record-only' | 'unknown';
  expiresAt?: string;
  baseUrl?: string;
  format: ProtocolName;
  found: boolean;
  note?: string;
}

export interface LocalClientSource {
  id: string;
  clientId: string;
  label: string;
  path: string;
  status: 'imported' | 'updated' | 'unchanged' | 'linked' | 'modified' | 'ignored' | 'missing-key' | 'unsupported' | 'missing-file';
  providerId?: string;
  message?: string;
  canRestore?: boolean;
}

export interface LocalClientsSnapshot {
  ok: boolean;
  checkedAt: string;
  sources: LocalClientSource[];
  accounts: LocalAccount[];
  added: number;
  updated: number;
  warnings: string[];
}

export interface PluginRecord {
  id: string;
  name: string;
  description?: string;
  code?: string;
  enabled: boolean;
  builtin?: boolean;
  options?: Record<string, unknown>;
  updatedAt: string;
}

export interface AgentCatalogItem {
  id: string;
  name: string;
  vendor: string;
  description: string;
  protocol: string;
  hotSwitch: boolean;
  needsInstall: boolean;
  configPath: string;
  launchHint: string;
  support?: 'automatic' | 'manual' | 'unsupported';
  category?: 'cli' | 'desktop' | 'service';
  supportNote?: string;
  docsUrl?: string;
  downloads?: { win?: string; winAlt?: string; mac?: string; linux?: string; current?: string; alt?: string; storeHint?: boolean; note?: string };
}

export interface AgentState {
  id: string;
  permissionMode?: 'preserve' | 'full-access';
  skipOnboarding?: boolean;
  authMode?: 'api' | 'coexist';
  mode?: 'gateway' | 'direct';
  connected: boolean;
  pendingReapply?: boolean;
  providerId?: string;
  model?: string;
  modelMap?: Record<string, string>;
  configPath?: string;
  lastSyncAt?: string;
}

export interface Preset {
  id: string;
  name: string;
  nameZh: string;
  vendor: string;
  region: 'cn' | 'global' | 'local' | 'relay' | 'subscription';
  format: ProtocolName;
  baseUrl: string;
  color: string;
  icon: string;
  docs?: string;
  customBaseUrl?: boolean;
  official?: boolean;
  note?: string;
  models: ProviderModel[];
}

export interface GatewayStatus {
  running: boolean;
  host: string;
  port: number;
  startedAt?: string;
  requests: number;
  errors: number;
  lastError?: string;
}

export interface AgentDetection {
  installed: boolean;
  configured?: boolean;
  version?: string;
  command?: string;
  configPath?: string;
  productName?: string;
  supportsCodexConfig?: boolean;
  evidence?: string[];
  detectionError?: string;
  detecting?: boolean;
}

export interface AppState {
  build?: { id: string; builtAt: string; revision: string; channel: 'local' | 'release' };
  settings: Settings;
  providers: Provider[];
  localClients?: LocalClientsSnapshot;
  codexCoexist?: {
    identity: { available: boolean; status: string; message: string; expiresAt?: string };
    models: Array<{ id: string; upstreamModel: string; providerId: string; providerName: string; displayName: string; official: boolean; contextWindow?: number }>;
    officialModelCount: number;
    warnings: string[];
  };
  groups: RoutingGroup[];
  agents: Record<string, AgentState>;
  plugins: PluginRecord[];
  middlewareStatus?: Record<string, { status: 'ok' | 'error' | 'blocked'; checkedAt: string; message?: string }>;
  presets: Preset[];
  catalog?: { source: 'remote' | 'cache' | 'builtin'; version: number; fetchedAt?: string; warning?: string; syncing?: boolean };
  builtinMiddleware: Array<{ id: string; name: string; description: string; defaultOptions: any }>;
  agentCatalog: AgentCatalogItem[];
  gateway: GatewayStatus;
  gatewayUrl: string;
  dataDir: string;
  version: string;
  platform: string;
  detected: Record<string, AgentDetection>;
  mode?: 'desktop' | 'web';
}

export interface UsageRecord {
  threadId?: string;
  cacheReadKnown?: boolean;
  cacheWriteKnown?: boolean;
  estimated?: boolean;
  ts: string;
  agent: string;
  providerId: string;
  providerName: string;
  model: string;
  requestModel: string;
  protocol: string;
  stream: boolean;
  status: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costKnown?: boolean;
  latencyMs: number;
  firstByteMs?: number;
  error?: string;
  attempts: number;
  requestId: string;
}

export interface UsageSummary {
  totals: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; cacheRate: number; cacheReports: number; cacheWriteReports: number; cost: number; unpricedCalls?: number; calls: number; errors: number };
  byDay: Array<{ day: string; cost: number; unpricedCalls?: number; tokens: number; calls: number }>;
  byProvider: Array<{ id: string; name?: string; cost: number; unpricedCalls?: number; tokens: number; calls: number }>;
  byModel: Array<{ id: string; cost: number; unpricedCalls?: number; tokens: number; calls: number }>;
  byAgent: Array<{ id: string; calls: number; tokens: number }>;
}

export interface SessionSummary {
  id: string;
  agent: string;
  isSubagent?: boolean;
  parentSessionId?: string;
  subagentId?: string;
  title: string;
  project?: string;
  cwd?: string;
  path: string;
  messageCount: number;
  tokens: number;
  cost: number;
  model?: string;
  modelProvider?: string;
  sourceLabel?: string;
  sourceScope?: string;
  sourceKind?: 'cli' | 'desktop';
  contentStatus?: 'available' | 'metadata-only' | 'ambiguous';
  contentNote?: string;
  canResume?: boolean;
  archived?: boolean;
  updatedAt: string;
  createdAt: string;
  sizeBytes: number;
}

declare global {
  interface Window {
    aurora?: {
      invoke: (action: string, payload?: any) => Promise<any>;
      recent: () => Promise<UsageRecord[]>;
      onUsage: (cb: (r: UsageRecord) => void) => () => void;
      onGateway: (cb: (s: GatewayStatus) => void) => () => void;
    };
  }
}

export async function call<T = any>(action: string, payload?: any): Promise<T> {
  if (window.aurora) {
    const res = await window.aurora.invoke(action, payload);
    if (res && typeof res === 'object' && 'error' in res && !('ok' in res)) {
      throw new Error(res.error);
    }
    return res as T;
  }
  if (action === 'app.openExternal') {
    const url = new URL(payload.url);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('请在桌面端打开此链接');
    window.open(url.href, '_blank', 'noopener,noreferrer');
    return { ok: true } as T;
  }
  // Web 控制台 / 手机端：令牌仅保留当前浏览器会话
  const r = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('aurora.gatewayToken') || ''}` },
    body: JSON.stringify({ action, payload }),
  });
  const j = await r.json();
  if (r.status === 401) throw new Error('AUTH_REQUIRED');
  if (j?.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message || '请求失败');
  if (!r.ok) throw new Error(`请求失败 (${r.status})`);
  return j.result as T;
}

export const isWebMode = () => !window.aurora;

/* ---------------- 格式化 ---------------- */

export function fmtNum(n?: number): string {
  if (n == null) return '—';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 10_000) return (n / 1000).toFixed(1) + 'K';
  return String(Math.round(n));
}

export function fmtCtx(n?: number): string {
  if (!n) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}

export function fmtCost(n?: number): string {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) +
    ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function fmtBytes(n?: number): string {
  if (!n) return '0 B';
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

export function maskKey(k: string): string {
  if (!k) return '未填写';
  if (k.length <= 10) return k.slice(0, 3) + '••••';
  return k.slice(0, 6) + '••••••' + k.slice(-4);
}

export const PROTOCOL_TEXT: Record<string, string> = {
  anthropic: 'Anthropic',
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  gemini: 'Gemini',
};

export const MODE_TEXT: Record<RouteMode, string> = {
  order: '依次故障转移',
  rotate: '轮换',
  weight: '按权重',
  usage: '用得少的优先',
  pace: '额度余量优先',
  smart: '健康与优先级',
};

