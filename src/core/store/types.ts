import type { ProtocolName } from '../types.js';
import type { ProviderBalanceQuery } from '../providerBalanceTypes.js';

export interface ProviderModel {
  /** 发给上游的模型名 */
  id: string;
  /** 展示名 */
  displayName?: string;
  contextWindow?: number;
  maxOutput?: number;
  /** 每百万 token，美元 */
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
    thinking?: boolean;
  };
  /** 思考参数写法（DeepSeek 系用 enable_thinking） */
  thinkingField?: 'reasoning_effort' | 'enable_thinking' | 'none';
}

export interface ApiKey {
  id: string;
  label: string;
  key: string;
  enabled: boolean;
  weight: number;
  /** 冷却到什么时候（ISO） */
  cooldownUntil?: string;
  lastError?: string;
  lastUsedAt?: string;
}

export interface Provider {
  id: string;
  name: string;
  presetId?: string;
  /** 上游真实协议 */
  format: ProtocolName;
  baseUrl: string;
  apiKeys: ApiKey[];
  models: ProviderModel[];
  enabled: boolean;
  priority: number;
  headers?: Record<string, string>;
  /** 单供应商代理，如 http://127.0.0.1:7890 */
  proxy?: string;
  /** 是否官方订阅通道（走 OAuth，不参与本地路由改写） */
  official?: boolean;
  color?: string;
  icon?: string;
  notes?: string;
  /** 中转站倍率，用于费用估算 */
  rateMultiplier?: number;
  balanceQuery?: ProviderBalanceQuery;
  quota?: {
    balance?: number;
    currency?: string;
    updatedAt?: string;
    windows?: Array<{ label: string; usedPercent: number; resetsAt?: string }>;
  };
  createdAt: string;
  updatedAt: string;
}

export type RouteMode = 'order' | 'rotate' | 'weight' | 'usage' | 'pace' | 'smart';

export interface RouteMember {
  providerId: string;
  /** null = 用该供应商的默认模型 */
  model: string | null;
  weight: number;
}

export interface RoutingGroup {
  id: string;
  name: string;
  mode: RouteMode;
  members: RouteMember[];
  enabled: boolean;
  /** 组内失败重试次数 */
  retries: number;
  notes?: string;
  createdAt: string;
}

export type AgentId =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex-cli'
  | 'codex-desktop'
  | 'chatgpt-desktop'
  | 'gemini-cli'
  | 'deepseek'
  | 'workbuddy'
  | 'qwen-code'
  | 'kimi-code'
  | 'opencode'
  | 'zcode'
  | 'zcode-desktop'
  | 'antigravity'
  | 'generic';

export interface AgentState {
  id: AgentId;
  connected: boolean;
  providerId?: string;
  model?: string;
  mode?: 'gateway' | 'direct';
  authMode?: 'api' | 'coexist';
  /** Explicit native execution policy choice; omitted preserves existing permissions. */
  permissionMode?: 'preserve' | 'full-access';
  /** Optional Claude Code first-run compatibility setting, never an official login. */
  skipOnboarding?: boolean;
  /** Claude Code 的 opus / sonnet / haiku 分别用哪个模型 */
  modelMap?: Record<string, string>;
  configPath?: string;
  /** 接入前备份路径 */
  backupPath?: string;
  /** Settings were imported; retain this machine's undo information until the client is reapplied. */
  pendingReapply?: boolean;
  lastSyncAt?: string;
  detected?: boolean;
  version?: string;
}

export interface UsageRecord {
  /** False when the provider's price metadata was incomplete when the request ran. */
  costKnown?: boolean;
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
  latencyMs: number;
  firstByteMs?: number;
  error?: string;
  attempts: number;
  requestId: string;
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
  /** 全局上游代理 */
  proxy: string;
  /** 隐私遮蔽：密钥/邮箱/手机号在发往上游前替换 */
  maskSecrets: boolean;
  /** 上下文自动裁剪 */
  autoTrimContext: boolean;
  /** 每个请求最大重试次数（故障转移） */
  maxRetries: number;
  /** 单个请求超时毫秒 */
  requestTimeoutMs: number;
  /** 用量日志保留天数 */
  usageRetentionDays: number;
  /** 局域网共享网关 */
  lanShare: boolean;
  keepAwakeWhileSharing: boolean;
  /** 网关访问令牌，局域网共享时必填 */
  gatewayToken: string;
  /** WebDAV 备份 */
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string;
  /** 首字超时（毫秒），超过就换下一个上游 */
  firstByteTimeoutMs: number;
  /** 记录请求日志 */
  logRequests: boolean;
  /** 云端供应商目录地址（后台 pub.php?action=catalog） */
  catalogUrl: string;
  /** 更新检查地址（后台 pub.php?action=update） */
  updateUrl: string;
  /** 启动时自动检查更新 */
  autoCheckUpdate: boolean;
  /** 后台管理地址，UI 里给个入口 */
  adminUrl: string;
  /** 上游返回模型列表后自动合并 */
  autoSyncModels: boolean;
  /** 上次看到的 Codex 桌面版版本，用于检测官方更新 */
  codexVersion?: string;
  /** Last gateway connection-affecting change; display preferences do not advance it. */
  connectionUpdatedAt?: string;
  updatedAt: string;
}

export interface PluginRecord {
  id: string;
  name: string;
  description?: string;
  /** js 源码（中间件） */
  code?: string;
  enabled: boolean;
  builtin?: boolean;
  options?: Record<string, unknown>;
  updatedAt: string;
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
  provider?: string;
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
  truncated?: boolean;
}

