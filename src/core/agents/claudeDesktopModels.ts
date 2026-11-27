import type { AgentState, Provider } from '../store/types.js';

const legacyAlias = /^claude-(sonnet|opus|haiku)-aurora$/;

/** Only advertise routes that name an actual Claude model, including provider-qualified IDs. */
export function isClaudeDesktopModel(id: string): boolean {
  const route = /^(?:[a-z0-9][a-z0-9._-]*\/)?(?:[a-z]{2,6}\.anthropic\.)?(claude-[a-z0-9.-]+?)(?:-v\d+:\d+)?$/.exec(id);
  if (!route) return false;
  return /^claude-(?:sonnet|opus|haiku|fable|mythos)-\d+(?:[-.]\d+)*(?:-latest)?$/.test(route[1])
    || /^claude-3(?:-[57])?-(?:sonnet|opus|haiku)(?:-(?:\d{8}|latest))?$/.test(route[1]);
}

/** The first profile entry is Claude Desktop's default. One rejected ID invalidates the entire profile. */
export function claudeDesktopModels(provider: Pick<Provider, 'models'>, selected?: string) {
  const models = new Map(provider.models.filter(model => isClaudeDesktopModel(model.id)).map(model => [model.id, model]));
  const ordered = new Set([...(selected && models.has(selected) ? [selected] : []), ...models.keys()]);
  return Array.from(ordered, id => {
    const display = models.get(id)?.displayName?.trim();
    return { name: id, labelOverride: display && display !== id ? `${display} (${id})` : id };
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
  return isClaudeDesktopModel(name) ? provider.models.find(model => model.id === name)?.id : undefined;
}
