const apiVersionSuffix = /\/(v\d+[a-z0-9]*)$/i;

/** Normalize a pasted, versioned operation URL without stripping a relay's path prefix. */
export function providerEndpoint(value: string, format: string): { baseUrl: string; version?: string; hostname: string } {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('请填写有效的 API 基础地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('接口地址必须是 HTTP(S) URL，且不能包含账号密码');
  if (parsed.search || parsed.hash) throw new Error('接口地址不能包含查询参数或片段，请填写 API 基础地址');
  let pathname = parsed.pathname.replace(/\/+$/, '');
  const operation = format === 'openai-chat' ? /\/chat\/completions$/
    : format === 'openai-responses' ? /\/responses$/
    : format === 'anthropic' ? /\/messages$/
    : format === 'gemini' ? /\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/ : undefined;
  if (operation) {
    const prefix = pathname.replace(operation, '');
    if (apiVersionSuffix.test(prefix)) pathname = prefix;
  }
  return { baseUrl: parsed.origin + pathname, version: apiVersionSuffix.exec(pathname)?.[1], hostname: parsed.hostname };
}

/** Anonymous key slots are supported by loopback and literal private IPv4 model servers. */
export function localProviderHost(hostname: string): boolean {
  if (['localhost', '[::1]', '::1'].includes(hostname.toLowerCase())) return true;
  const parts = hostname.split('.');
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [first, second] = parts.map(Number);
  return first === 127 || first === 10 || (first === 192 && second === 168)
    || (first === 172 && second >= 16 && second <= 31);
}

export function providerAllowsAnonymous(hostname: string, keys: readonly { enabled: boolean; key: string }[]): boolean {
  return localProviderHost(hostname) && (keys.length === 0 || keys.some(slot => slot.enabled && !slot.key.trim()));
}
