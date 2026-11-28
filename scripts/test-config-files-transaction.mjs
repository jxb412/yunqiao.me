/** Real filesystem fault/race tests for shared client config transactions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-config-transaction-')));
const read = file => fs.readFileSync(file, 'utf8');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const injectedSecret = 'fixture-private-error-must-not-leak';
const external = 'external-private-secret-preserve';
const rawRename = fs.renameSync;
let api, passed = 0, sequence = 0;
const check = (label, fn) => { fn(); passed++; console.log(`PASS ${label}`); };
function fixture(count = 2, missing = []) {
  const root = path.join(scratch, `case-${++sequence}`), paths = Array.from({ length: count }, (_, i) => path.join(root, `config-${i}.json`));
  const original = paths.map((_, i) => `original-private-${i}\r\n`), installed = paths.map((_, i) => `installed-private-${i}\n`);
  paths.forEach((file, i) => { if (!missing.includes(i)) write(file, original[i]); });
  const plan = () => paths.map((file, i) => api.planned(file, installed[i]));
  return { root, paths, original, installed, plan };
}
function fault(fn, hook) {
  let caught;
  fs.renameSync = (from, to) => hook(from, to, () => rawRename(from, to));
  try { assert.throws(fn, error => { caught = error; return true; }); }
  finally { fs.renameSync = rawRename; }
  for (const secret of [injectedSecret, external, 'original-private', 'installed-private']) assert(!caught.message.includes(secret));
  return caught;
}
function manifests(f) {
  return fs.readdirSync(path.join(f.root, '.aurora-backups')).filter(name => name.endsWith('.json')).map(name => ({ file: path.join(f.root, '.aurora-backups', name), value: JSON.parse(read(path.join(f.root, '.aurora-backups', name))) }));
}
function assertOriginals(f, missing = []) {
  const list = manifests(f); assert(list.length > 0);
  for (const manifest of list) for (const [index, entry] of manifest.value.files.entries()) {
    if (missing.includes(index)) assert.equal(entry.backup, null);
    else assert.equal(read(entry.backup), f.original[index]);
  }
}
function installedFixture(count = 2, missing = []) {
  const f = fixture(count, missing); f.backup = api.applyPlan('fixture-client', f.plan()); return f;
}

try {
  const bundle = path.join(scratch, 'config-api.cjs');
  await build({ entryPoints: [path.join(workspace, 'src/core/agents/configFiles.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  api = createRequire(import.meta.url)(bundle);

  check('Equivalent spellings of a config path retain the first original and originally absent files', () => {
    const f = installedFixture(2, [1]);
    const aliases = f.paths.map(file => path.dirname(file) + path.sep + '.' + path.sep + path.basename(file));
    const backup = api.applyPlan('fixture-client', aliases.map(file => api.planned(file, 'second selection')), f.backup);
    api.restorePlan('fixture-client', backup, f.paths);
    assert.equal(read(f.paths[0]), f.original[0]); assert.equal(fs.existsSync(f.paths[1]), false);
  });
  if (process.platform === 'win32') check('Windows config directory case changes preserve the first connection backup', () => {
    const f = installedFixture(2, [1]);
    const root = path.join(path.dirname(f.root), path.basename(f.root).toUpperCase());
    const aliases = f.paths.map(file => path.join(root, path.basename(file)));
    assert.equal(fs.realpathSync.native(root), fs.realpathSync.native(f.root));
    const backup = api.applyPlan('fixture-client', aliases.map(file => api.planned(file, 'second selection')), f.backup);
    api.restorePlan('fixture-client', backup, f.paths);
    assert.equal(read(f.paths[0]), f.original[0]); assert.equal(fs.existsSync(f.paths[1]), false);
  });
  check('Restoring an unchanged config succeeds without replacing it', () => {
    const f = fixture(2);
    const backup = api.applyPlan('fixture-client', [api.planned(f.paths[0], f.installed[0]), api.planned(f.paths[1], f.original[1])]);
    fs.renameSync = (from, to) => { assert.notEqual(to, f.paths[1], 'locked file must not be rewritten'); return rawRename(from, to); };
    try { api.restorePlan('fixture-client', backup, f.paths); }
    finally { fs.renameSync = rawRename; }
    assert.equal(read(f.paths[0]), f.original[0]); assert.equal(read(f.paths[1]), f.original[1]);
  });
  check('A config link with an unavailable target survives preview and application', () => {
    const f = fixture(1, [0]); fs.mkdirSync(f.root);
    const [file] = f.paths, target = path.join(f.root, 'unavailable'), plan = f.plan();
    try { fs.symlinkSync(target, file, 'file'); }
    catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      fs.mkdirSync(target); fs.symlinkSync(target, file, 'junction'); fs.rmdirSync(target);
    }
    assert.equal(fs.existsSync(file), false); assert(fs.lstatSync(file).isSymbolicLink());
    assert.throws(() => api.planned(file, 'edited'), /不是普通文件/);
    assert.throws(() => api.applyPlan('fixture-client', plan), /不是普通文件/);
    assert(fs.lstatSync(file).isSymbolicLink()); assert.equal(fs.existsSync(target), false);
  });
  check('Codex desktop pipe rotation is tolerated, but every other byte remains protected', () => {
    const root = path.join(scratch, `runtime-${++sequence}`), file = path.join(root, 'config.toml');
    const first = 'model = "fixture-model"\n[mcp_servers.node_repl.env]\nSKY_CUA_NATIVE_PIPE_DIRECTORY = \'\\\\.\\pipe\\codex-computer-use-11111111-1111-4111-8111-111111111111\'\nOTHER = "keep"\n';
    write(file, first);
    const installed = first.replace('fixture-model', 'selected-model');
    const backup = api.applyPlan('codex-cli', [api.planned(file, installed)]);
    const rotated = installed.replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    write(file, rotated);
    assert(api.inspectAppliedPlan('codex-cli', backup, [file]).unchanged);
    const next = api.applyPlan('codex-cli', [api.planned(file, rotated)], backup);
    assert.equal(read(file), rotated);
    assert.equal(JSON.parse(read(next)).files[0].backup, JSON.parse(read(backup)).files[0].backup);
    for (const changed of [rotated.replace('selected-model', 'external-model'), rotated.replace('OTHER = "keep"', 'OTHER = "changed"'), rotated + '# unrelated edit\n', rotated.replace('codex-computer-use-', 'untrusted-pipe-')]) {
      write(file, changed);
      assert(!api.inspectAppliedPlan('codex-cli', next, [file]).unchanged);
      assert.throws(() => api.applyPlan('codex-cli', [api.planned(file, rotated)], next));
      assert.equal(read(file), changed);
    }
    assert.equal(api.codexRuntimeHash(file, 'not valid = ['), undefined);
    assert.equal(api.codexRuntimeHash(path.join(root, 'other.toml'), rotated), undefined);
  });

  check('Apply failure restores earlier existing/new files and retains every original backup', () => {
    const f = fixture(3, [1]);
    const error = fault(() => api.applyPlan('fixture-client', f.plan()), (_from, to, rename) => { if (to === f.paths[2]) throw Error(injectedSecret); return rename(); });
    assert.equal(read(f.paths[0]), f.original[0]); assert(!fs.existsSync(f.paths[1])); assert.equal(read(f.paths[2]), f.original[2]); assertOriginals(f, [1]); assert(error.message.includes('已撤回'));
  });
  check('Apply rollback preserves external replacement of an already written file and names its path', () => {
    const f = fixture();
    const error = fault(() => api.applyPlan('fixture-client', f.plan()), (from, to, rename) => {
      if (to === f.paths[1]) throw Error(injectedSecret);
      const result = rename(); if (to === f.paths[0] && read(to) === f.installed[0]) write(to, external); return result;
    });
    assert.equal(read(f.paths[0]), external); assert.equal(read(f.paths[1]), f.original[1]); assert(error.message.includes(f.paths[0])); assertOriginals(f);
  });
  check('Apply checks each next file again and never overwrites an intervening external edit', () => {
    const f = fixture(); let secondWrites = 0;
    const error = fault(() => api.applyPlan('fixture-client', f.plan()), (_from, to, rename) => {
      if (to === f.paths[1]) secondWrites++;
      const result = rename(); if (to === f.paths[0] && read(to) === f.installed[0]) write(f.paths[1], external); return result;
    });
    assert.equal(secondWrites, 0); assert.equal(read(f.paths[0]), f.original[0]); assert.equal(read(f.paths[1]), external); assertOriginals(f);
    assert(error.message.includes('外部修改')); assert(error.message.includes(f.paths[1]));
  });
  check('Apply keeps recovering other files after one rollback write also fails', () => {
    const f = fixture(3); let rollingBack = false;
    const error = fault(() => api.applyPlan('fixture-client', f.plan()), (_from, to, rename) => {
      if (to === f.paths[2]) { rollingBack = true; throw Error(injectedSecret); }
      if (rollingBack && to === f.paths[1]) throw Error(injectedSecret);
      return rename();
    });
    assert.equal(read(f.paths[0]), f.original[0]); assert.equal(read(f.paths[1]), f.installed[1]); assert.equal(read(f.paths[2]), f.original[2]); assert(error.message.includes(f.paths[1])); assertOriginals(f);
  });
  check('Apply never deletes a newly created file after another program replaces its content', () => {
    const f = fixture(2, [0]);
    const error = fault(() => api.applyPlan('fixture-client', f.plan()), (_from, to, rename) => {
      if (to === f.paths[1]) throw Error(injectedSecret);
      const result = rename(); if (to === f.paths[0]) write(to, external); return result;
    });
    assert.equal(read(f.paths[0]), external); assert(error.message.includes(f.paths[0])); assertOriginals(f, [0]);
  });
  check('A failed later switch returns to the previous selection while preserving the first originals', () => {
    const f = installedFixture(); const next = f.paths.map((file, i) => api.planned(file, `second-${i}`));
    fault(() => api.applyPlan('fixture-client', next, f.backup), (_from, to, rename) => { if (to === f.paths[1]) throw Error(injectedSecret); return rename(); });
    f.paths.forEach((file, i) => assert.equal(read(file), f.installed[i])); assertOriginals(f);
    api.restorePlan('fixture-client', f.backup, f.paths); f.paths.forEach((file, i) => assert.equal(read(file), f.original[i]));
  });
  check('Restore failure reinstalls all previously restored/deleted files and keeps original backups', () => {
    const f = installedFixture(3, [1]);
    const error = fault(() => api.restorePlan('fixture-client', f.backup, f.paths), (_from, to, rename) => { if (to === f.paths[2]) throw Error(injectedSecret); return rename(); });
    f.paths.forEach((file, i) => assert.equal(read(file), f.installed[i])); assertOriginals(f, [1]); assert(error.message.includes('已撤回'));
  });
  check('Restore rollback preserves an external replacement of an already restored file and reports its path', () => {
    const f = installedFixture();
    const error = fault(() => api.restorePlan('fixture-client', f.backup, f.paths), (_from, to, rename) => {
      if (to === f.paths[1]) throw Error(injectedSecret);
      const result = rename(); if (to === f.paths[0] && read(to) === f.original[0]) write(to, external); return result;
    });
    assert.equal(read(f.paths[0]), external); assert.equal(read(f.paths[1]), f.installed[1]); assert(error.message.includes(f.paths[0])); assertOriginals(f);
  });
  check('Restore rechecks the next installed file before replacing it', () => {
    const f = installedFixture(); let secondWrites = 0;
    const error = fault(() => api.restorePlan('fixture-client', f.backup, f.paths), (_from, to, rename) => {
      if (to === f.paths[1]) secondWrites++;
      const result = rename(); if (to === f.paths[0] && read(to) === f.original[0]) write(f.paths[1], external); return result;
    });
    assert.equal(secondWrites, 0); assert.equal(read(f.paths[0]), f.installed[0]); assert.equal(read(f.paths[1]), external); assert(error.message.includes('外部修改')); assert(error.message.includes(f.paths[1])); assertOriginals(f);
  });
  check('Restore rollback keeps recovering earlier files after one rollback fails', () => {
    const f = installedFixture(3); let rollingBack = false;
    const error = fault(() => api.restorePlan('fixture-client', f.backup, f.paths), (_from, to, rename) => {
      if (to === f.paths[2]) { rollingBack = true; throw Error(injectedSecret); }
      if (rollingBack && to === f.paths[1]) throw Error(injectedSecret);
      return rename();
    });
    assert.equal(read(f.paths[0]), f.installed[0]); assert.equal(read(f.paths[1]), f.original[1]); assert.equal(read(f.paths[2]), f.installed[2]); assert(error.message.includes(f.paths[1])); assertOriginals(f);
  });
  check('Restore preserves an external file recreated after deleting an originally absent file', () => {
    const f = installedFixture(2, [0]);
    const error = fault(() => api.restorePlan('fixture-client', f.backup, f.paths), (_from, to, rename) => {
      if (to === f.paths[1]) { write(f.paths[0], external); throw Error(injectedSecret); }
      return rename();
    });
    assert.equal(read(f.paths[0]), external); assert.equal(read(f.paths[1]), f.installed[1]); assert(error.message.includes(f.paths[0])); assertOriginals(f, [0]);
  });
  check('A manifest outside the client backup directory cannot restore arbitrary paths', () => {
    const f = installedFixture(); const externalManifest = path.join(scratch, 'not-a-client-backup.json');
    write(externalManifest, read(f.backup));
    assert.throws(() => api.restorePlan('fixture-client', externalManifest, f.paths), /备份路径不属于/);
    f.paths.forEach((file, i) => assert.equal(read(file), f.installed[i])); assertOriginals(f);
  });
  check('A linked backup directory cannot redirect original credentials outside the client folder', () => {
    const f = fixture(1), outside = path.join(scratch, 'external-backup-target'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(f.root, '.aurora-backups'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => api.applyPlan('fixture-client', f.plan()), /备份目录/);
    assert.equal(read(f.paths[0]), f.original[0]); assert.deepEqual(fs.readdirSync(outside), []);
  });
  check('A nested backup-directory link cannot supply an external original during restore or switching', () => {
    const f = installedFixture(1), outside = path.join(scratch, 'external-original-target'); fs.mkdirSync(outside);
    const linked = path.join(f.root, '.aurora-backups', 'redirected'); fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    write(path.join(outside, 'external.original'), 'must-not-restore-external-original');
    const manifest = JSON.parse(read(f.backup)); manifest.files[0].backup = path.join(linked, 'external.original'); write(f.backup, JSON.stringify(manifest));
    assert.throws(() => api.restorePlan('fixture-client', f.backup, f.paths), /备份.*目录/);
    assert.throws(() => api.applyPlan('fixture-client', f.paths.map(file => api.planned(file, 'next-selection')), f.backup), /备份.*目录/);
    assert.equal(read(f.paths[0]), f.installed[0]);
  });
  if (process.platform !== 'win32') check('Native Unix reapplies private permissions to an existing backup directory', () => {
    const f = fixture(1), root = path.join(f.root, '.aurora-backups'); fs.mkdirSync(root, { mode: 0o755 }); fs.chmodSync(root, 0o755);
    const manifest = api.applyPlan('fixture-client', f.plan());
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(manifest).mode & 0o777, 0o600);
    const original = JSON.parse(read(manifest)).files[0].backup; assert.equal(fs.statSync(original).mode & 0o777, 0o600);
  });
  check('Malformed backup JSON never exposes parser source content during apply or restore', () => {
    const f = installedFixture(), originalManifest = JSON.parse(read(f.backup));
    const secret = 'sk-fixture', malformed = `${secret}-private-invalid-json`;
    assert.throws(() => JSON.parse(malformed), error => error.message.includes(secret));
    write(f.backup, malformed);
    for (const operation of [() => api.applyPlan('fixture-client', f.plan(), f.backup), () => api.restorePlan('fixture-client', f.backup, f.paths)]) {
      assert.throws(operation, error => error.message.includes('无法读取有效的配置备份') && error.message.includes(f.backup) && !error.message.includes(secret));
      f.paths.forEach((file, i) => assert.equal(read(file), f.installed[i]));
      assert.equal(read(f.backup), malformed);
      originalManifest.files.forEach((entry, i) => assert.equal(read(entry.backup), f.original[i]));
      assert.equal(fs.readdirSync(path.join(f.root, '.aurora-backups')).filter(name => name.endsWith('.json')).length, 1);
    }
  });
  check('Failed atomic writes leave no credential-containing temporary files', () => {
    const remaining = [];
    function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.tmp')) remaining.push(file); } }
    walk(scratch); assert.deepEqual(remaining, []);
  });
  console.log(`\nConfig file transactions: ${passed} checks passed.`);
} finally {
  fs.renameSync = rawRename;
  assert(path.basename(scratch).startsWith('aurora-config-transaction-'));
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
