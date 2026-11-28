import { providerEndpoint } from '../providerEndpoint.js';

export function nativeDirectCredentialIssue(agentId: string, hasKey: boolean): string {
  if (hasKey || (agentId !== 'gemini-cli' && agentId !== 'claude-code')) return '';
  const client = agentId === 'gemini-cli' ? 'Gemini CLI' : 'Claude Code';
  return `${client} 的直连模式需要已启用的供应商 API Key。使用免密本地服务时，请选择本地网关接入。`;
}

/** Native SDK settings that reproduce the gateway's upstream URL exactly. */
export function nativeDirectParameters(base: string, protocol: string): { baseUrl: string; apiVersion?: string } {
  const endpoint = providerEndpoint(base, protocol), version = endpoint.version;
  let baseUrl = endpoint.baseUrl;
  if (protocol === 'openai-chat' || protocol === 'openai-responses') {
    // These clients append only the operation, including below proxy prefixes.
    if (!version) baseUrl += '/v1';
  } else if (protocol === 'anthropic') {
    // Anthropic's SDK always appends /v1/messages to its configured base URL.
    if (version && version !== 'v1') throw new Error('此 API 版本无法由 Claude 客户端直连配置，请选择本地网关接入');
    if (version) baseUrl = baseUrl.slice(0, -(version.length + 1));
  } else if (protocol === 'gemini') {
    // Gemini CLI forwards both variables to the SDK. Explicitly pin the API
    // version, since SDK releases have used different defaults (v1beta / v1).
    if (version) baseUrl = baseUrl.slice(0, -(version.length + 1));
    return { baseUrl, apiVersion: version || 'v1beta' };
  }
  return { baseUrl };
}
