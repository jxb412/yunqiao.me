import path from 'node:path';

export function claudeGlobalConfigPath(home: string, configDir?: string): string {
  return path.join(configDir || home, '.claude.json');
}

export function usesClaudeCloudProvider(env?: Record<string, unknown>): boolean {
  const flags = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD'];
  return flags.some(key => ['1', 'true'].includes(String(env?.[key]).toLowerCase()));
}
