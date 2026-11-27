import type { AgentState, Provider } from '../store/types.js';

const legacyAlias = /^claude-(sonnet|opus|haiku)-aurora$/;
const escapedPrefix = 'yunqiao-model/';

/** The first profile entry is Claude Desktop's default. Keep real upstream IDs wherever possible. */
export function claudeDesktopModels(provider: Pick<Provider, 'models'>, selected: string | undefined, gateway: boolean) {
  const models = new Map(provider.models.filter(model => model.id).map(model => [model.id, model]));
  const ordered = new Set([...(selected && models.has(selected) ? [selected] : []), ...models.keys()]);
  return Array.from(ordered, id => {
    const display = models.get(id)?.displayName?.trim();
    // Keep the three names used in older conversations available for their original bindings.
    const name = gateway && (legacyAlias.test(id) || id.startsWith(escapedPrefix)) ? escapedPrefix + id : id;
    return { name, labelOverride: display && display !== id ? `${display} (${id})` : id };
  });
}

/** Resolve only within the connected provider; a model ID itself can contain slashes. */
export function claudeDesktopTarget(provider: Provider, state: AgentState, name: string): string | undefined {
  const family = legacyAlias.exec(name)?.[1];
  if (family) {
    const target = state.modelMap?.[family] || state.model;
    if (!target || provider.models.some(model => model.id === target)) return target;
    // Older connection records can carry a provider-qualified model instead of the upstream ID.
    return target.startsWith(provider.id + '/') ? target.slice(provider.id.length + 1) : target;
  }
  const id = name.startsWith(escapedPrefix) ? name.slice(escapedPrefix.length) : name;
  if (name.startsWith(escapedPrefix) && !(legacyAlias.test(id) || id.startsWith(escapedPrefix))) return undefined;
  return provider.models.find(model => model.id === id)?.id;
}
