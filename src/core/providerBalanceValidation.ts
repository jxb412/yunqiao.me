import type { ProviderBalanceQuery } from './providerBalanceTypes.js';

export function providerOrigin(url?: string): string | undefined {
  try {
    const parsed = new URL(url ?? '');
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.origin : undefined;
  } catch { return undefined; }
}

export const BALANCE_ADAPTERS = ['auto', 'disabled', 'deepseek', 'moonshot', 'openrouter', 'stepfun', 'novita', 'sub2api', 'newapi', 'custom'] as const;
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const fields = new Set(['adapter', 'auth', 'token', 'url', 'method', 'authHeader', 'authScheme', 'headers', 'body', 'balancePath', 'totalPath', 'usedPath', 'scope', 'currency', 'multiplier']);
export function balanceUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error('余额查询地址格式不正确'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash || /[\x00-\x20\\]/.test(value)) throw new Error('余额查询需要 HTTPS 地址；仅本机开发服务可使用 HTTP，地址不能含凭据或片段');
  return url;
}
export function balancePath(value: string): string[] {
  if (!value || value.length > 256 || !/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*|\.[0-9]+|\[[0-9]+\])*$/.test(value)) throw new Error('余额字段路径应为 JSON 属性路径，例如 data.balance 或 wallets[0].amount');
  const parts = value.replace(/\[(\d+)\]/g, '.$1').split('.');
  if (parts.some(part => unsafeKeys.has(part)) || parts.length > 16) throw new Error('余额字段路径不允许原型属性');
  return parts;
}
export function validateBalanceHeaders(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 32) throw new Error('余额请求头应为最多 32 项的对象');
  for (const [name, content] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name) || /^(host|connection|content-length|transfer-encoding|proxy-authorization|proxy-connection|upgrade|trailer|te)$/i.test(name)
      || typeof content !== 'string' || content.length > 8192 || /[\x00-\x1f\x7f]/.test(content)) throw new Error('余额请求头包含无效或禁止的字段');
  }
}
export function validateBalanceQuery(value: unknown, providerBase: string): asserts value is ProviderBalanceQuery | undefined {
  if (value === undefined) return;
  const query = value as ProviderBalanceQuery;
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !fields.has(key)) || !BALANCE_ADAPTERS.includes(query.adapter)) throw new Error('余额查询配置或适配器无效');
  if (query.auth !== undefined && !['api-key', 'token', 'none'].includes(query.auth)) throw new Error('余额认证方式无效');
  if (query.method !== undefined && !['GET', 'POST'].includes(query.method)) throw new Error('余额查询仅支持 GET 或 POST');
  if (query.authScheme !== undefined && !['bearer', 'raw'].includes(query.authScheme)) throw new Error('余额认证前缀无效');
  if (query.scope !== undefined && !['account', 'key', 'subscription'].includes(query.scope)) throw new Error('余额查询结果含义无效');
  for (const name of ['token', 'url', 'authHeader', 'body', 'balancePath', 'totalPath', 'usedPath', 'currency'] as const) if (query[name] !== undefined && (typeof query[name] !== 'string' || query[name]!.length > (name === 'body' ? 65536 : name === 'token' ? 8192 : 2048))) throw new Error('余额查询字段类型或长度无效');
  if (query.token && /[\x00-\x20\x7f]/.test(query.token)) throw new Error('余额查询令牌不能含空白或控制字符');
  if (query.headers !== undefined) validateBalanceHeaders(query.headers);
  if (query.authHeader) validateBalanceHeaders({ [query.authHeader]: 'validation' });
  for (const name of ['balancePath', 'totalPath', 'usedPath'] as const) if (query[name]) balancePath(query[name]!);
  if (query.currency && !/^[A-Za-z][A-Za-z0-9 _-]{0,15}$/.test(query.currency)) throw new Error('余额单位应为简短货币或点数标识');
  if (query.multiplier !== undefined && (typeof query.multiplier !== 'number' || !Number.isFinite(query.multiplier) || query.multiplier <= 0 || query.multiplier > 1e12)) throw new Error('余额换算倍率必须为大于零的有限数字');
  if (query.body) {
    try { JSON.parse(query.body); } catch { throw new Error('余额请求体必须是静态 JSON，不支持 JavaScript'); }
    if ((query.method || 'GET') !== 'POST') throw new Error('只有 POST 余额查询可以设置 JSON 请求体');
  }
  if (query.url) {
    const target = balanceUrl(query.url);
    if ((query.auth || 'api-key') === 'api-key') {
      let base: URL; try { base = new URL(providerBase); } catch { throw new Error('请先填写供应商地址，再使用 API Key 查询余额'); }
      if (target.origin !== base.origin) throw new Error('使用供应商 API Key 时，余额查询必须与供应商接口同源；独立查询请使用专用令牌');
    }
  }
  if (query.adapter === 'custom' && (!query.url || ![query.balancePath, query.totalPath, query.usedPath].some(Boolean))) throw new Error('自定义余额查询需要地址和至少一个金额字段路径');
  if (query.adapter !== 'custom' && (query.auth === 'token' || query.auth === 'none')) throw new Error('独立令牌或免认证余额接口请选择自定义适配器');
}
