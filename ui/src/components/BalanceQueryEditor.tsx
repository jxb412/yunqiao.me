import React, { useEffect, useState } from 'react';
import type { BalanceAdapter, ProviderBalanceQuery } from '../lib/api';
import { providerOrigin, validateBalanceQuery } from '../../../src/core/providerBalanceValidation';
import { Field } from './ui';

const ADAPTERS: Array<[BalanceAdapter, string]> = [
  ['auto', '自动识别（推荐）'], ['disabled', '关闭余额查询'], ['deepseek', 'DeepSeek'], ['moonshot', 'Moonshot / Kimi'],
  ['openrouter', 'OpenRouter'], ['stepfun', '阶跃星辰'], ['novita', 'Novita'], ['sub2api', 'Sub2API'], ['newapi', 'New API（兼容接口）'], ['custom', '自定义查询'],
];

function headersValue(text: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('附加请求头必须是 JSON 对象，且所有值都为字符串');
  return parsed;
}

function queryError(query: ProviderBalanceQuery, baseUrl: string, headers: string): string {
  if (query.adapter !== 'custom') return '';
  if (query.auth === 'token' && !query.token?.trim()) return '请填写独立查询 Token';
  if (!query.balancePath?.trim() && !(query.totalPath?.trim() && query.usedPath?.trim())) return '请填写余额字段路径，或同时填写总额与已用字段路径';
  try { validateBalanceQuery({ ...query, headers: headersValue(headers) }, baseUrl); }
  catch (error: any) { return error instanceof SyntaxError ? '附加请求头不是有效 JSON' : error.message; }
  return '';
}

export default function BalanceQueryEditor({ value, baseUrl, onChange, onValidityChange }: {
  value?: ProviderBalanceQuery; baseUrl: string; onChange: (value: ProviderBalanceQuery) => void; onValidityChange: (error: string) => void;
}) {
  const query = value || { adapter: 'auto' as const };
  const [headers, setHeaders] = useState(() => query.headers ? JSON.stringify(query.headers, null, 2) : '');
  const storedHeaders = JSON.stringify(query.headers);
  useEffect(() => {
    setHeaders(current => {
      try { if (JSON.stringify(headersValue(current)) === storedHeaders) return current; } catch { /* Replace old invalid text when the external configuration changes. */ }
      return query.headers ? JSON.stringify(query.headers, null, 2) : '';
    });
  }, [storedHeaders, query.adapter, value === undefined]);
  const set = (patch: Partial<ProviderBalanceQuery>) => onChange({ ...query, ...patch });
  const error = queryError(query, baseUrl, headers);
  useEffect(() => { onValidityChange(error); }, [error, onValidityChange]);
  return <details className="balance-query-editor">
    <summary>余额查询<span>{ADAPTERS.find(([id]) => id === query.adapter)?.[1] || '自动识别'}</span></summary>
    <p className="hint">保存供应商后生效。余额来自上游查询，每个 Key 单独展示。</p>
    <Field label="查询方式"><select className="select" aria-label="余额查询方式" value={query.adapter} onChange={event => {
      const adapter = event.target.value as BalanceAdapter;
      onChange({ adapter }); setHeaders('');
    }}>{ADAPTERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
    {query.adapter !== 'custom' && <p className="hint">{query.adapter === 'disabled' ? '不自动查询，也不发送手动刷新请求。' : '按服务商支持的接口读取余额或额度；未开放查询接口时会明确提示。'}</p>}
    {query.adapter === 'custom' && <>
      <div className="grid cols-2">
        <Field label="查询地址" hint="填写实际查询接口的完整地址。更换站点后请重新填写查询凭据。"><input className="input mono" aria-label="余额查询地址" value={query.url || ''} onChange={event => {
          const url = event.target.value;
          const changed = !!query.url && providerOrigin(query.url) !== providerOrigin(url);
          if (changed) setHeaders('');
          set({ url, ...(changed ? { token: undefined, headers: undefined, body: undefined } : {}) });
        }} /></Field>
        <Field label="请求方式"><select className="select" aria-label="余额请求方式" value={query.method || 'GET'} onChange={event => set({ method: event.target.value as 'GET' | 'POST', ...(event.target.value === 'GET' ? { body: undefined } : {}) })}><option value="GET">GET</option><option value="POST">POST</option></select></Field>
      </div>
      <Field label="查询认证" hint="复用 API Key 仅限与 Base URL 同源；跨站查询请使用独立凭据。"><select className="select" aria-label="余额查询认证" value={query.auth || 'api-key'} onChange={event => set({ auth: event.target.value as ProviderBalanceQuery['auth'], ...(event.target.value !== 'token' ? { token: undefined } : {}) })}><option value="api-key">复用每个 API Key（同源）</option><option value="token">独立查询 Token</option><option value="none">无需认证</option></select></Field>
      {query.auth === 'token' && <Field label="独立查询 Token"><input className="input mono" aria-label="独立查询 Token" type="password" autoComplete="off" value={query.token || ''} onChange={event => set({ token: event.target.value })} /></Field>}
      {query.auth !== 'none' && <div className="grid cols-2">
        <Field label="认证请求头" hint="留空使用 Authorization。"><input className="input mono" aria-label="余额认证请求头" value={query.authHeader || ''} onChange={event => set({ authHeader: event.target.value })} /></Field>
        <Field label="认证格式"><select className="select" aria-label="余额认证格式" value={query.authScheme || 'bearer'} onChange={event => set({ authScheme: event.target.value as 'bearer' | 'raw' })}><option value="bearer">Bearer Token</option><option value="raw">直接传入 Token</option></select></Field>
      </div>}
      <Field label="附加请求头（JSON，可选）"><textarea className="input mono" aria-label="余额附加请求头" value={headers} onChange={event => {
        const text = event.target.value; setHeaders(text);
        try { set({ headers: headersValue(text) }); } catch { /* Keep the text and block saving until valid. */ }
      }} /></Field>
      {query.method === 'POST' && <Field label="请求正文（静态 JSON，可选）" hint="按接口文档填写固定 JSON，不支持脚本或变量替换。"><textarea className="input mono" aria-label="余额请求正文" value={query.body || ''} onChange={event => set({ body: event.target.value })} /></Field>}
      <div className="grid cols-2">
        <Field label="余额字段路径" hint="使用点号访问嵌套字段，数组用数字索引。"><input className="input mono" aria-label="余额字段路径" value={query.balancePath || ''} onChange={event => set({ balancePath: event.target.value })} /></Field>
        <Field label="币种或额度单位" hint="按上游含义填写，额度点数不要标为货币。"><input className="input" aria-label="余额币种" value={query.currency || ''} onChange={event => set({ currency: event.target.value })} /></Field>
        <Field label="查询结果含义"><select className="select" aria-label="查询结果含义" value={query.scope || 'account'} onChange={event => set({ scope: event.target.value as ProviderBalanceQuery['scope'] })}><option value="account">账户余额</option><option value="key">密钥额度</option><option value="subscription">套餐额度</option></select></Field>
        <Field label="总额字段路径（可选）"><input className="input mono" aria-label="总额字段路径" value={query.totalPath || ''} onChange={event => set({ totalPath: event.target.value })} /></Field>
        <Field label="已用字段路径（可选）"><input className="input mono" aria-label="已用字段路径" value={query.usedPath || ''} onChange={event => set({ usedPath: event.target.value })} /></Field>
        <Field label="换算倍率（可选）" hint="结果乘以该值；留空不换算。"><input className="input" aria-label="余额换算倍率" type="number" step="any" value={query.multiplier ?? ''} onChange={event => set({ multiplier: event.target.value.trim() ? Number(event.target.value) : undefined })} /></Field>
      </div>
      {error && <p className="balance-error" role="alert">{error}</p>}
    </>}
  </details>;
}
