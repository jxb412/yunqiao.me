import { isDeepStrictEqual } from 'node:util';
import type { Provider } from './store/types.js';
import { providerOrigin } from './providerBalanceValidation.js';

function freshHeaders(next?: Record<string, string>, previous?: Record<string, string>): Record<string, string> | undefined {
  const existing = new Set(Object.values(previous ?? {}));
  const fresh = Object.entries(next ?? {}).filter(([, value]) => !existing.has(value));
  return fresh.length ? Object.fromEntries(fresh) : undefined;
}

/** Full editor drafts and partial updates both pass through this check before any network use. */
export function isolateProviderCredentials(previous: Provider, next: Provider): Provider {
  const apiChanged = providerOrigin(previous.baseUrl) !== providerOrigin(next.baseUrl);
  const oldQuery = previous.balanceQuery;
  const query = next.balanceQuery;
  const queryChanged = providerOrigin(oldQuery?.url ?? previous.baseUrl) !== providerOrigin(query?.url ?? next.baseUrl);
  if (apiChanged) {
    const previousKeys = new Set(previous.apiKeys.map(key => key.key.trim()));
    next = { ...next, headers: freshHeaders(next.headers, previous.headers),
      apiKeys: next.apiKeys.map(key => previousKeys.has(key.key.trim()) ? { ...key, key: '' } : key) };
  }
  if (apiChanged && isDeepStrictEqual(oldQuery, query)) return { ...next, balanceQuery: undefined };
  if ((apiChanged || queryChanged) && query && oldQuery) {
    return { ...next, balanceQuery: { ...query,
      token: query.token === oldQuery.token ? undefined : query.token,
      headers: freshHeaders(query.headers, oldQuery.headers),
      body: query.body === oldQuery.body ? undefined : query.body,
    } };
  }
  return next;
}
