import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-history-alias-')));
const home = path.join(root, 'real-home'), alias = path.join(root, 'alias-home');
const links = [], databases = [];
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const link = (target, location) => { fs.symlinkSync(target, location, process.platform === 'win32' ? 'junction' : 'dir'); links.push(location); };
let passed = 0;
const test = async (label, run) => { await run(); passed++; console.log(`PASS ${label}`); };

try {
  fs.mkdirSync(home); link(home, alias);
  const bundle = path.join(root, 'history.cjs');
  await build({ stdin: { contents: `export * from './src/core/historyRepairIO.ts'; export * from './src/core/historyRepair.ts'; export * from './src/core/sessionIndexRepair.ts';`, resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  const id = '10000000-0000-4000-8000-000000000001';
  const rollout = path.join(home, 'sessions', 'rollout.jsonl'), aliasRollout = path.join(alias, 'sessions', 'rollout.jsonl');
  const event = (type, ordinal, fields = {}) => ({ type: 'event_msg', ordinal, timestamp: '2026-11-15T01:00:00Z', payload: { type, thread_id: id, ...fields } });
  const records = [
    { type: 'session_meta', ordinal: 0, payload: { id, model_provider: 'old', source: 'cli', cwd: root } },
    event('task_started', 1, { turn_id: 'turn', started_at: 100 }),
    event('user_message', 2, { turn_id: 'turn', message: '原始请求' }),
    { type: 'response_item', ordinal: 3, timestamp: '2026-11-15T01:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '原始请求' }], internal_chat_message_metadata_passthrough: { turn_id: 'turn', create_time: 100 } } },
    event('item_completed', 4, { turn_id: 'turn', item: { type: 'UserMessage', id: 'native-first', content: [{ type: 'text', text: '原始请求' }] } }),
    event('task_complete', 5, { turn_id: 'turn', started_at: 100, completed_at: 102, duration_ms: 2000 }),
  ];
  const source = records.map(record => JSON.stringify(record)).join('\n') + '\n';
  write(rollout, source);
  write(path.join(home, 'config.toml'), 'model_provider="aurora"\n[model_providers.aurora]\nname="Aurora"\n');
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite')); databases.push(state);
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,model_provider TEXT,rollout_path TEXT,cwd TEXT,title TEXT,archived INTEGER)');
  state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run(id, 'old', aliasRollout, root, 'Alias fixture', 0);
  const db = new DatabaseSync(path.join(home, 'thread_history_1.sqlite')); databases.push(db);
  db.exec(`CREATE TABLE thread_turns(thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,status TEXT NOT NULL,first_user_item_id TEXT,rollout_ordinal INTEGER,error_json TEXT,started_at INTEGER,completed_at INTEGER,duration_ms INTEGER,rollout_end_ordinal INTEGER,PRIMARY KEY(thread_id,turn_id));
CREATE TABLE thread_items(thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,item_id TEXT NOT NULL,rollout_ordinal INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,item_json TEXT NOT NULL,item_type TEXT NOT NULL,updated_at_ordinal INTEGER NOT NULL,PRIMARY KEY(thread_id,turn_id,item_id));
CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id,rollout_ordinal);`);
  const context = { home: alias, sqliteHome: alias, blockingProcesses: async () => [] };

  await test('canonical files remain valid when checked again through an aliased history root', () => {
    assert.equal(api.checkedFile(alias, aliasRollout), fs.realpathSync.native(rollout));
    assert.equal(api.checkedFile(alias, rollout), fs.realpathSync.native(rollout));
    assert.equal(api.sameHistoryFile(alias, aliasRollout, rollout), true);
    assert.equal(api.normalizeHistoryContext(context).home, home);
    assert.equal(api.historyLocation(path.join(alias, 'future', 'backup.json')), path.join(home, 'future', 'backup.json'));
  });
  await test('aliases share one history repair lock and cannot start a concurrent writer', () => {
    const unlock = api.acquireHistoryLock(context);
    try { assert.throws(() => api.acquireHistoryLock({ ...context, home, sqliteHome: home }), /正在执行/); }
    finally { unlock(); }
    const next = api.acquireHistoryLock({ ...context, home, sqliteHome: home }); next();
  });
  if (process.platform === 'win32') await test('Windows short paths and native long paths identify the same contained rollout', () => {
    const shortHome = execFileSync('cmd.exe', ['/d', '/u', '/c', 'for %I in ("%HISTORY_FIXTURE_HOME%") do @echo %~sI'], {
      env: { ...process.env, HISTORY_FIXTURE_HOME: home }, encoding: 'utf16le', windowsHide: true, windowsVerbatimArguments: true,
    }).trim();
    const longRollout = fs.realpathSync.native(rollout);
    assert.equal(api.checkedFile(shortHome, longRollout), longRollout);
    assert(api.sameHistoryFile(shortHome, path.join(shortHome, path.relative(home, rollout)), longRollout));
  });
  await test('provider repair accepts alias rollout ownership without rewriting its valid stored path', async () => {
    const service = api.createHistoryRepairService(context);
    const preview = await service.preview({}); assert.equal(preview.ok, true, preview.message); assert.equal(preview.summary.repairable, 1); assert.equal(preview.summary.pathChanges, 0);
    const result = await service.apply({ ...preview.options, revision: preview.revision }); assert.equal(result.ok, true, result.message);
    assert.equal(state.prepare('SELECT model_provider FROM threads').get().model_provider, 'aurora');
    assert.equal(state.prepare('SELECT rollout_path FROM threads').get().rollout_path, aliasRollout);
    const canonicalService = api.createHistoryRepairService({ ...context, home, sqliteHome: home });
    const restore = await canonicalService.restorePreview({ backupId: result.backupId }); assert.equal(restore.ok, true);
    assert.equal((await canonicalService.restore({ backupId: result.backupId, revision: restore.revision })).ok, true);
    assert.equal(fs.readFileSync(rollout, 'utf8'), source);
  });
  await test('native index repair proves aliased canonical ownership and can restore through the real root', async () => {
    const service = api.createSessionIndexRepairService(context);
    const preview = await service.preview({}); assert.equal(preview.changes, 1); assert.equal(preview.createdTurns, 1);
    const result = await service.apply({ revision: preview.revision }); assert.equal(result.applied, true);
    assert.equal(db.prepare('SELECT item_id FROM thread_items').get().item_id, 'native-first');
    assert.equal(fs.readFileSync(rollout, 'utf8'), source);
    const canonicalService = api.createSessionIndexRepairService({ ...context, home, sqliteHome: home });
    const restore = canonicalService.restorePreview({ backupId: result.backupId }); assert.equal(restore.canRestore, true);
    await canonicalService.restore({ backupId: result.backupId, revision: restore.revision });
    assert.equal(db.prepare('SELECT count(*) AS n FROM thread_items').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM thread_turns').get().n, 0);
  });
  await test('path aliases never authorize files whose canonical location is outside the client root', () => {
    const outside = path.join(root, 'outside'); write(path.join(outside, 'private.jsonl'), 'untouched');
    const externalLink = path.join(home, 'external'); link(outside, externalLink);
    assert.throws(() => api.checkedFile(alias, path.join(alias, 'external', 'private.jsonl')), /路径不属于/);
    assert.equal(api.sameHistoryFile(alias, rollout, path.join(outside, 'private.jsonl')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'private.jsonl'), 'utf8'), 'untouched');
  });
  console.log(`${passed} history path alias checks passed`);
} finally {
  for (const db of databases) db.close();
  for (const location of links.reverse()) fs.unlinkSync(location);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert(path.basename(root).startsWith('aurora-history-alias-'));
  fs.rmSync(root, { recursive: true, force: true });
}
