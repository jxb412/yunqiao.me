import path from 'node:path';

export interface ClientPathContext {
  platform: NodeJS.Platform;
  home: string;
  environment: Record<string, string | undefined>;
  isolated?: boolean;
}

function environmentValue(ctx: ClientPathContext, name: string): string | undefined {
  if (ctx.environment[name] !== undefined || ctx.platform !== 'win32') return ctx.environment[name];
  // Windows worker_threads receive a case-sensitive copy of process.env.
  // Preserve the OS lookup semantics for common names such as Path.
  const key = Object.keys(ctx.environment).find(value => value.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : ctx.environment[key];
}

/** Pure path construction: these helpers never inspect the host or start a shell. */
export function cliCandidates(command: string, ctx: ClientPathContext): string[] {
  const paths = ctx.platform === 'win32' ? path.win32 : path.posix;
  const folders = (environmentValue(ctx, 'PATH') || '').split(ctx.platform === 'win32' ? ';' : ':');
  if (ctx.platform === 'darwin') {
    // Finder does not source shell startup files. Cover the standard native,
    // Homebrew and user npm installations without executing user shell code.
    folders.push(paths.join(ctx.home, '.local', 'bin'), paths.join(ctx.home, '.npm-global', 'bin'),
      paths.join(ctx.home, '.npm', 'bin'), paths.join(ctx.home, '.volta', 'bin'));
    if (!ctx.isolated) {
      for (const prefix of [ctx.environment.HOMEBREW_PREFIX, ctx.environment.npm_config_prefix, ctx.environment.NPM_CONFIG_PREFIX, ctx.environment.VOLTA_HOME]) {
        if (prefix && paths.isAbsolute(prefix)) folders.push(paths.join(prefix, 'bin'));
      }
      if (ctx.environment.NVM_BIN) folders.push(ctx.environment.NVM_BIN);
      folders.push('/opt/homebrew/bin', '/usr/local/bin');
    }
  }
  const extensions = ctx.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const seen = new Set<string>();
  return folders.flatMap(folder => {
    // Windows PATH entries may be quoted. Empty/relative entries must not make
    // the GUI's current working directory an executable discovery location.
    const clean = ctx.platform === 'win32' ? folder.replace(/^"(.*)"$/, '$1') : folder;
    if (!clean || !paths.isAbsolute(clean)) return [];
    return extensions.map(ext => paths.join(clean, command + ext));
  }).filter(candidate => {
    const key = ctx.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function desktopCandidates(names: readonly string[], ctx: ClientPathContext): string[] {
  const paths = ctx.platform === 'win32' ? path.win32 : path.posix;
  const local = !ctx.isolated && environmentValue(ctx, 'LOCALAPPDATA') || paths.join(ctx.home, 'AppData', 'Local');
  const roaming = !ctx.isolated && environmentValue(ctx, 'APPDATA') || paths.join(ctx.home, 'AppData', 'Roaming');
  return names.flatMap(name => ctx.platform === 'win32' ? [
    paths.join(local, 'Programs', name, `${name}.exe`), paths.join(local, name, `${name}.exe`),
    ...(name.toLowerCase() === 'claude' ? [paths.join(local, 'AnthropicClaude', 'claude.exe')] : []),
    paths.join(local, 'OpenAI', name, `${name}.exe`), paths.join(local, 'Microsoft', 'WindowsApps', `${name}.exe`),
    paths.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${name}.lnk`),
  ] : ctx.platform === 'darwin' ? [
    ...(!ctx.isolated ? [paths.join('/Applications', `${name}.app`)] : []), paths.join(ctx.home, 'Applications', `${name}.app`),
  ] : [paths.join(ctx.home, '.local', 'bin', name.toLowerCase())]);
}

/** Log files may have been copied from another OS; do not use the host separator. */
export function sessionProjectName(cwd: string): string {
  return (/^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? path.win32 : path.posix).basename(cwd);
}
