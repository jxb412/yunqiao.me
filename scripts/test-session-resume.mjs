import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { parse } from 'smol-toml';

const workspace = path.resolve(import.meta.dirname, '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunqiao-session-resume-')));
const clients = path.join(temporary, 'clients'), previous = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = clients;
const id = '10000000-0000-4000-8000-000000000001';
const summary = { id, agent: 'Codex', path: 'never-read', title: 'Fixture' };
let passed = 0;
const test = (name, run) => { run(); passed++; console.log(`PASS ${name}`); };
const posixQuote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const powershellQuote = value => `'${value.replace(/'/g, "''")}'`;
const resultFile = path.join(temporary, 'argv.json'), recorder = path.join(temporary, 'record-argv.cjs');
fs.writeFileSync(recorder, "require('node:fs').writeFileSync(process.env.YUNQIAO_ARGV_REPORT, JSON.stringify(process.argv.slice(2)));\n");
const shellEnv = { ...process.env, YUNQIAO_ARGV_REPORT: resultFile, MSYS2_ARG_CONV_EXCL: '*' };

function nativeArguments(shell, command, platform) {
  fs.rmSync(resultFile, { force: true });
  // Git Bash exposes POSIX argv before its separate Windows-native argv bridge.
  // Use its builtin printf for that cross-platform check; real Windows shells
  // and native POSIX hosts both execute the Node recorder as a native process.
  const posixOnWindows = process.platform === 'win32' && platform !== 'win32';
  const invocation = posixOnWindows ? "printf '%s\\0'" : platform === 'win32'
    ? `& ${powershellQuote(process.execPath)} ${powershellQuote(recorder)}`
    : `${posixQuote(process.execPath.replaceAll('\\', '/'))} ${posixQuote(recorder.replaceAll('\\', '/'))}`;
  assert.ok(command.startsWith('codex '));
  const script = command.replace(/^codex/, invocation);
  const scriptFile = path.join(temporary, 'argv.sh');
  if (platform !== 'win32') fs.writeFileSync(scriptFile, script + '\n');
  const args = platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    : [scriptFile.replaceAll('\\', '/')];
  const child = spawnSync(shell, args, { cwd: temporary, env: shellEnv, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(child.error, undefined, `${shell}: ${child.error}`);
  assert.equal(child.status, 0, `${shell}: ${child.stderr}`);
  if (posixOnWindows) { assert.ok(child.stdout.endsWith('\0')); return child.stdout.slice(0, -1).split('\0'); }
  assert.ok(fs.existsSync(resultFile), `Native argv recorder did not run: ${shell}`);
  return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
}

try {
  const bundle = path.join(temporary, 'bundle.cjs');
  await build({ stdin: { contents: "export {scanSessions, readSession, exportSessionMarkdown, resumeCommand} from './src/core/sessions.ts';", resolveDir: workspace, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);

  const buddy = path.join(clients, '.codebuddy'), project = path.join(buddy, 'projects', 'test-project');
  const transcript = path.join(project, id + '.jsonl');
  const writeEvents = (file, rows) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  };
  const buddyEvents = [
    { type: 'session-meta', sessionId: id },
    { type: 'message', role: 'user', providerData: { isMeta: true }, content: 'client-only reminder' },
    { type: 'message', sessionId: id, cwd: temporary, timestamp: 1791900000100, role: 'user', content: [{ type: 'input_text', text: '<tag> literal user text' }] },
    { type: 'reasoning', rawContent: [{ type: 'reasoning_text', text: 'fixture reasoning' }] },
    { type: 'function_call', name: 'fixture_tool', arguments: '{"sample":1}', providerData: { model: 'fixture-model' } },
    { type: 'function_call_result', name: 'fixture_tool', output: { text: 'fixture tool result' } },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture final reply' }] },
    { type: 'ai-title', aiTitle: 'Saved project conversation' },
  ];
  test('CodeBuddy project histories preserve real conversation, tools, title and model through export', () => {
    writeEvents(transcript, buddyEvents);
    const before = fs.readFileSync(transcript), mtime = fs.statSync(transcript).mtimeMs;
    const item = api.scanSessions().find(row => row.path === transcript);
    assert.ok(item);
    assert.deepEqual([item.agent, item.id, item.title, item.model, item.cwd, item.messageCount],
      ['CodeBuddy', id, 'Saved project conversation', 'fixture-model', temporary, 5]);
    assert.ok(api.resumeCommand(item).includes('codebuddy --resume ' + id));
    assert.ok(api.resumeCommand(item).includes(temporary));
    const messages = api.readSession(transcript);
    assert.deepEqual(messages.map(row => row.role), ['user', 'assistant', 'assistant', 'tool', 'assistant']);
    assert.equal(messages[0].ts, new Date(1791900000100).toISOString());
    assert.equal(messages[0].text, '<tag> literal user text');
    assert.deepEqual(api.readSession(transcript, 1), messages.slice(0, 1));
    const md = api.exportSessionMarkdown(item);
    for (const term of ['fixture reasoning', 'fixture_tool', 'fixture tool result', 'fixture final reply', '<tag> literal user text']) assert.ok(md.includes(term));
    assert.ok(!md.includes('client-only reminder'));
    assert.deepEqual(fs.readFileSync(transcript), before); assert.equal(fs.statSync(transcript).mtimeMs, mtime);
  });
  test('CodeBuddy sidecars, bookkeeping, linked directories and non-transcript JSON stay outside session history', () => {
    const sidecar = path.join(project, id, 'tool-results', 'result.jsonl');
    const other = path.join(temporary, 'external-codebuddy');
    const external = path.join(other, 'external.jsonl'), alias = path.join(buddy, 'projects', 'linked-project');
    const rootFile = path.join(buddy, 'projects', 'stray.jsonl'), json = path.join(project, 'settings.json');
    for (const name of [sidecar, external, rootFile, json]) writeEvents(name, buddyEvents);
    writeEvents(path.join(project, 'metadata-only.jsonl'), buddyEvents.slice(0, 2));
    fs.symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const found = api.scanSessions().filter(row => row.agent === 'CodeBuddy');
    assert.deepEqual(found.map(row => row.path), [transcript]);
    for (const name of [sidecar, external, path.join(alias, 'external.jsonl'), rootFile, json]) assert.throws(() => api.readSession(name), /只能读取/);
  });
  test('CodeBuddy keeps legacy and duplicate histories readable and avoids ambiguous resume commands', () => {
    const duplicate = path.join(buddy, 'projects', 'second-project', id + '.jsonl');
    writeEvents(duplicate, buddyEvents);
    const mismatched = path.join(project, 'different.jsonl');
    writeEvents(mismatched, buddyEvents);
    const legacy = path.join(buddy, 'sessions', 'legacy.jsonl');
    writeEvents(legacy, [{ role: 'user', content: 'legacy conversation' }]);
    const scanned = api.scanSessions();
    for (const name of [duplicate, transcript, mismatched, legacy]) {
      const item = scanned.find(row => row.path === name);
      assert.ok(item); assert.ok(api.readSession(name).length); assert.equal(api.resumeCommand(item), '');
    }
    const resumable = { ...summary, agent: 'CodeBuddy', canResume: true, cwd: temporary };
    assert.ok(api.resumeCommand({ ...resumable, id: 'group:session-2' }).includes('codebuddy --resume group:session-2'));
    for (const unsafe of ['-option', 'a&whoami', 'a\nb', '']) assert.equal(api.resumeCommand({ ...resumable, id: unsafe }), '');
    for (const cwd of [undefined, 'relative/path', 'bad\npath']) assert.equal(api.resumeCommand({ ...resumable, cwd }), '');
  });
  test('long CodeBuddy transcripts use the most recent native title while indexing a bounded message prefix', () => {
    const longId = 'large-session', file = path.join(project, longId + '.jsonl');
    writeEvents(file, [{ type: 'message', cwd: temporary, sessionId: longId, role: 'user', content: 'original prompt' },
      { type: 'ai-title', aiTitle: 'Old title' }, { type: 'file-history-snapshot', snapshot: 'x'.repeat(300000) },
      { type: 'ai-title', aiTitle: 'Current title' }]);
    const item = api.scanSessions().find(row => row.path === file);
    assert.ok(item.truncated); assert.equal(item.title, 'Current title');
    assert.ok(api.resumeCommand(item).includes('codebuddy --resume ' + longId));
  });
  test('a relocated CodeBuddy configuration is readable without offering a default-profile resume command', () => {
    const config = path.join(temporary, 'alternative-config'), profile = path.join(temporary, 'empty-user');
    const relocated = path.join(config, 'projects', 'project', id + '.jsonl');
    writeEvents(relocated, buddyEvents);
    fs.mkdirSync(profile);
    const env = { ...process.env, HOME: profile, USERPROFILE: profile,
      APPDATA: profile, LOCALAPPDATA: profile, CLAUDE_CONFIG_DIR: profile, CODEX_HOME: profile, CODEBUDDY_CONFIG_DIR: config };
    delete env.AURORA_CLIENT_HOME;
    const script = `const api = require(process.argv[1]); const rows = api.scanSessions().filter(x => x.agent === 'CodeBuddy');
      if (rows.length !== 1 || rows[0].path !== process.argv[2] || api.resumeCommand(rows[0]) || api.readSession(rows[0].path).length !== 5) process.exitCode = 1;`;
    const child = spawnSync(process.execPath, ['-e', script, bundle, relocated], { cwd: temporary, env, windowsHide: true, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
  });

  test('sessions without provider metadata keep the original commands on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      assert.equal(api.resumeCommand(summary, platform), `codex resume ${id}`);
      assert.equal(api.resumeCommand({ ...summary, provider: 'display-label-only' }, platform), `codex resume ${id}`);
      assert.equal(api.resumeCommand({ ...summary, agent: 'Claude Code', modelProvider: 'ignored' }, platform), `claude --resume ${id}`);
      assert.equal(api.resumeCommand({ ...summary, agent: 'Gemini CLI', modelProvider: 'ignored' }, platform), `gemini --resume ${id}`);
    }
  });
  test('desktop, disabled, subagent and invalid identity guards remain intact', () => {
    for (const fields of [{ canResume: false }, { isSubagent: true }, { sourceKind: 'desktop' }, { id: 'x; exit' }, { id: '--last' }, { id: '' }, { agent: 'unknown' }]) {
      for (const platform of ['win32', 'darwin']) assert.equal(api.resumeCommand({ ...summary, modelProvider: 'yunqiao-history-route', ...fields }, platform), '');
    }
    assert.equal(api.resumeCommand(null), '');
  });
  test('malformed present provider metadata cannot silently select the current provider', () => {
    for (const provider of [null, 123, {}, '', ' spaced', 'trailing ', 'x'.repeat(201), 'x\n-c bad', 'x\0bad', 'x\tbad', '\u007f', '\ud800']) {
      for (const platform of ['win32', 'darwin']) assert.equal(api.resumeCommand({ ...summary, modelProvider: provider }, platform), '');
    }
    for (const provider of ['x"y', "x'''y", 'x\u2018y', 'x\u2019y', 'x\u201cy']) assert.equal(api.resumeCommand({ ...summary, modelProvider: provider }, 'win32'), '');
  });

  const common = ['yunqiao-history-route-abc123', 'openai', 'OpenAI', 'azure', 'true', '123', '供應商 / 分组:α😀',
    'path\\provider', "single'quote", "'leading", "trailing'", "''leading", "trailing''", "x'; exit 99; #", 'x$(exit 99)`exit 99`;&|<>%TEMP%'];
  const shells = [];
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    assert.ok(fs.existsSync(powershell), 'Native Windows PowerShell 5 is required for argv validation');
    shells.push({ name: 'Windows PowerShell 5', shell: powershell, platform: 'win32', providers: common });
    if (!spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true, timeout: 10000 }).error)
      shells.push({ name: 'PowerShell 7', shell: 'pwsh.exe', platform: 'win32', providers: common });
    const bash = process.env.YUNQIAO_TEST_BASH || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(bash)) shells.push({ name: 'Git Bash POSIX', shell: bash, platform: 'darwin', providers: [...common, 'x"y', "x'''y", 'x\u2019y'] });
    else console.log('SKIP POSIX shell execution: Git Bash is not installed on this Windows host');
  } else shells.push({ name: 'POSIX sh', shell: '/bin/sh', platform: process.platform, providers: [...common, 'x"y', "x'''y", 'x\u2019y'] });
  for (const { name, shell, platform, providers } of shells) {
    test(`${name} resumes CodeBuddy inside the literal project directory and restores the calling directory`, () => {
      const folder = "quotes'\u2018\u2019\u201a\u201b & [project] $(exit 99) `tick";
      const projectDir = path.join(temporary, folder);
      fs.mkdirSync(projectDir, { recursive: true });
      const cwd = platform === 'win32' ? projectDir : projectDir.replaceAll('\\', '/').replace(/^([a-z]):\//i, (_, drive) => '/' + drive.toLowerCase() + '/');
      const command = api.resumeCommand({ ...summary, agent: 'CodeBuddy', canResume: true, cwd }, platform);
      const script = platform === 'win32'
        ? `$initial = (Get-Location).Path; function codebuddy { [IO.File]::WriteAllText($env:YUNQIAO_ARGV_REPORT, (ConvertTo-Json -Compress -InputObject @((Get-Location).Path, $args[0], $args[1]))) }; ${command}; if ((Get-Location).Path -ne $initial) { exit 9 }`
        : `initial="$PWD"; codebuddy() { printf '%s\\0' "${'$'}{PWD##*/}" "$@"; }; ${command}; test "$initial" = "$PWD"`;
      fs.rmSync(resultFile, { force: true });
      const file = path.join(temporary, 'codebuddy-argv.sh');
      if (platform !== 'win32') fs.writeFileSync(file, script + '\n');
      const args = platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] : [file.replaceAll('\\', '/')];
      const child = spawnSync(shell, args, { cwd: temporary, env: shellEnv, encoding: 'utf8', windowsHide: true, timeout: 15000 });
      assert.equal(child.status, 0, child.stderr);
      const actual = platform === 'win32' ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : child.stdout.split('\0').slice(0, -1);
      assert.deepEqual([path.basename(actual[0]), ...actual.slice(1)], [folder, '--resume', id]);
    });
    test(`${name} delivers the exact TOML provider and session ID as process arguments`, () => {
      for (const provider of providers) {
        const command = api.resumeCommand({ ...summary, modelProvider: provider }, platform);
        assert.ok(command, `Missing command for ${JSON.stringify(provider)}`);
        const argv = nativeArguments(shell, command, platform);
        assert.deepEqual([argv[0], ...argv.slice(2)], ['-c', 'resume', id]);
        assert.deepEqual({ ...parse(argv[1]) }, { model_provider: provider }, `${name} changed ${JSON.stringify(provider)}`);
      }
    });
  }
  test('scanning a migrated session uses its exact provider without modifying configuration or history', () => {
    const home = path.join(clients, '.codex'), sessions = path.join(home, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, 'persisted.jsonl'), config = path.join(home, 'config.toml');
    const provider = 'yunqiao-history-route-fixture';
    fs.writeFileSync(config, 'model_provider="openai"\nmodel="unrelated-current-model"\n');
    fs.writeFileSync(file, [{ type: 'session_meta', payload: { id, model_provider: provider, source: 'cli', cwd: temporary } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Persisted fixture' } }].map(JSON.stringify).join('\n') + '\n');
    const before = new Map([file, config].map(name => [name, { bytes: fs.readFileSync(name), mtime: fs.statSync(name).mtimeMs }]));
    const item = api.scanSessions().find(value => value.path === file);
    assert.ok(item); assert.equal(item.modelProvider, provider);
    assert.equal(api.resumeCommand(item), api.resumeCommand({ ...summary, modelProvider: provider }, process.platform));
    for (const [name, expected] of before) { assert.deepEqual(fs.readFileSync(name), expected.bytes); assert.equal(fs.statSync(name).mtimeMs, expected.mtime); }
  });
  console.log(`Session resume: ${passed} checks passed`);
} finally {
  if (previous === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = previous;
  const relative = path.relative(fs.realpathSync(os.tmpdir()), temporary);
  assert.ok(relative.startsWith('yunqiao-session-resume-') && !relative.includes(path.sep));
  fs.rmSync(temporary, { recursive: true, force: true });
}
