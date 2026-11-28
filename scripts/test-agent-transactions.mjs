/** Agent configuration/state failure injection. No real client paths or model requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-agent-transaction-')));
const originalClientHome = process.env.AURORA_CLIENT_HOME;
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const snapshot = files => files.map(file => ({ file, content: fs.existsSync(file) ? read(file) : null }));
const assertSnapshot = expected => { for (const { file, content } of expected) assert.equal(fs.existsSync(file) ? read(file) : null, content, `Unexpected content at ${file}`); };
const configOriginal = '# original preferences\nmodel_provider = "openai"\nmodel = "official-fixture"\napproval_policy = "on-request"\n[mcp_servers.keep]\ncommand = "fixture"\n';
const secretFault = 'fixture-storage-error-must-not-escape';
let passed = 0;
const failures = [];
const check = async (label, fn) => {
  try { await fn(); passed++; console.log(`PASS ${label}`); }
  catch (error) { failures.push({ label, error }); console.error(`FAIL ${label}\n${error.stack}`); }
};
const aliases = ['codex-cli', 'chatgpt-desktop', 'codex-desktop'];

try {
  const bundle = path.join(scratch, 'core.cjs');
  await build({ stdin: { contents: [
    "export * from './src/core/store/index.ts';", "export * from './src/core/actions.ts';", "export * from './src/core/agents/adapters.ts';",
    "export { Router } from './src/core/gateway/router.ts';", "export { nativeDirectParameters } from './src/core/agents/directConnection.ts';",
    "export { buildUpstreamHttp, parseClientRequest } from './src/core/protocol/index.ts';",
  ].join('\n'), resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  for (const [input, output] of [['src/core/readOnlyWorker.ts', 'read-only-worker.cjs'], ['src/core/agents/detectionWorker.ts', 'detection-worker.cjs']]) {
    await build({ entryPoints: [path.join(workspace, input)], outfile: path.join(scratch, output), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  }
  const api = createRequire(import.meta.url)(bundle);
  function fixture(label, original = configOriginal) {
    const root = path.join(scratch, label), client = path.join(root, 'client');
    process.env.AURORA_CLIENT_HOME = client;
    const store = new api.AuroraStore(path.join(root, 'store'));
    store.saveSettings({ gatewayHost: '127.0.0.1', gatewayPort: 3425, gatewayToken: 'fixture-gateway-token', maskSecrets: false });
    const provider = store.saveProvider({ name: 'Fixture API', format: 'openai-responses', baseUrl: 'https://fixture.invalid/v1', enabled: true,
      models: [{ id: 'model-one' }, { id: 'model-two' }, { id: 'claude-sonnet-4-6' }], apiKeys: [{ id: 'fixture-key', label: 'Fixture', key: 'fixture-provider-key', enabled: true, weight: 1 }] });
    const config = path.join(client, '.codex', 'config.toml'), auth = path.join(client, '.codex', 'auth.json'), catalog = path.join(store.dir, 'codex-model-catalog.json');
    if (original !== null) write(config, original);
    const token = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
    const authBytes = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'fixture-refresh-private', account_id: 'fixture-account' } });
    write(auth, authBytes);
    write(path.join(client, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'official-fixture', display_name: 'Official fixture', visibility: 'list', context_window: 64000, base_instructions: 'fixture' }] }));
    const home = path.join(client, '.codex');
    const deps = { store, dataDir: store.dir, gatewayStatus: () => ({ running: true }), gatewayUrl: () => 'http://127.0.0.1:3425',
      historyContext: { home, sqliteHome: home, blockingProcesses: async () => [] } };
    const call = (action, patch = {}) => api.runAction(deps, action, { agentId: 'codex-cli', providerId: provider.id, model: 'model-one', authMode: 'coexist', ...patch });
    return { root, client, store, provider, config, auth, authBytes, catalog, deps, call };
  }
  await check('Applying a gateway connection can start it on demand; previews do not start it', async () => {
    const f = fixture('start-on-connect');
    const selection = { agentId: 'claude-code', providerId: f.provider.id, model: 'model-one', mode: 'gateway' };
    let running = false, starts = 0;
    const deps = { ...f.deps, gatewayStatus: () => ({ running }), startGateway: async () => { starts++; running = true; } };
    const preview = await api.runAction(deps, 'agent.preview', selection);
    assert.equal(preview.ok, true); assert.equal(starts, 0);
      const stale = await api.runAction(deps, 'agent.connect', { ...selection, revision: 'outdated' });
      assert.equal(stale.ok, false); assert.equal(starts, 0);
    const saved = await api.runAction(deps, 'agent.connect', { ...selection, revision: preview.revision });
    assert.equal(saved.ok, true, saved.message); assert.equal(starts, 1);
    assert.equal(JSON.parse(read(saved.path)).env.ANTHROPIC_MODEL, f.provider.id + '/model-one');
  });
  await check('When gateway startup fails, an actionable error leaves client files untouched', async () => {
    const f = fixture('gateway-port-busy'), config = path.join(f.client, '.claude', 'settings.json');
    write(config, '{"env":{"KEEP":"original"}}');
    const before = read(config), deps = { ...f.deps, gatewayStatus: () => ({running: false}),
      startGateway: async () => { throw new Error(secretFault); } };
    const r = await api.runAction(deps, 'agent.connect', { agentId: 'claude-code', providerId: f.provider.id, model: 'model-one' });
    assert.equal(r.ok, false); assert.match(r.message, /端口/); assert(!r.message.includes(secretFault));
    assert.equal(read(config), before);
  });
  await check('Private model services with no API key agree across preview and routing', async () => {
    const f = fixture('anonymous');
    for (const [hostname, allowed] of [['127.0.2.3', true], ['10.0.0.2', true], ['172.31.1.1', true],
      ['192.168.5.3', true], ['[::1]', true], ['172.32.0.1', false], ['10.relay.example', false]]) {
      const p = f.store.saveProvider({id: f.provider.id, baseUrl: 'http://' + hostname, apiKeys: []});
      const r = await f.call('agent.preview', { agentId: 'claude-code', authMode: 'api' });
      assert.equal(r.ok, allowed, hostname);
      assert.equal(new api.Router(f.store).resolveProviderModel(p.id, 'model-one').candidates.length > 0, allowed, hostname);
    }
    f.store.saveProvider({id: f.provider.id, baseUrl: 'http://127.0.0.1', apiKeys: [{id:'off',weight:1,label:'off',enabled:false,key:'disabled'}]});
    assert.equal((await f.call('agent.preview', { agentId: 'claude-code', authMode: 'api' })).ok, false);
    assert.equal(new api.Router(f.store).resolveProviderModel(f.provider.id, 'model-one').candidates.length, 0);
  });
  await check('A pasted versioned API operation keeps its relay prefix for native and gateway requests', () => {
    const ir = api.parseClientRequest('openai-chat', {model: 'sample', messages:[{role:'user',content:'hi'}]});
    for (const [format, suffix, sdkBase] of [['openai-chat','/v1/chat/completions','/v1'],
      ['openai-responses','/v1/responses','/v1'], ['anthropic','/v1/messages',''],
      ['gemini','/v1beta/models/sample:generateContent','']]) {
      const relay = 'https://relay.example/prefix', baseUrl = relay + suffix + '/';
      const req = api.buildUpstreamHttp(ir, {format,baseUrl,model:'sample',apiKey:'fixture'}, 'openai-chat');
      assert.equal(req.url, relay + suffix);
      assert.equal(api.nativeDirectParameters(baseUrl, format).baseUrl, relay + sdkBase);
      const anonymous = api.buildUpstreamHttp(ir, { format, baseUrl: 'http://v1', model: 'sample', apiKey: '' }, 'openai-chat');
      assert.equal(anonymous.url, 'http://v1' + suffix);
      for (const name of ['authorization', 'x-api-key', 'x-goog-api-key']) assert.equal(anonymous.headers[name], undefined);
    }
  });
  const stateSnapshot = fixture => ({ cached: JSON.stringify(fixture.store.listAgents()), disk: snapshot([path.join(fixture.store.dir, 'agents.json')]) });
  const assertStates = (fixture, before) => { assert.equal(JSON.stringify(fixture.store.listAgents()), before.cached); assertSnapshot(before.disk); };
  const assertNoSecrets = result => { const value = JSON.stringify(result); for (const secret of [secretFault, 'fixture-provider-key', 'fixture-gateway-token', 'fixture-refresh-private', 'fixture-external-private']) assert(!value.includes(secret)); };
  const assertAuth = fixture => assert.equal(read(fixture.auth), fixture.authBytes);
  async function failState(fixture, operation, during = () => {}) {
    const saveAgents = fixture.store.saveAgents, saveAgentsIfUnchanged = fixture.store.saveAgentsIfUnchanged;
    let calls = 0;
    const rejectCommit = states => { calls++; during(states); throw new Error(secretFault); };
    fixture.store.saveAgents = rejectCommit;
    fixture.store.saveAgentsIfUnchanged = rejectCommit;
    try {
      const result = await operation();
      assert.equal(calls, 1, 'Failure must reach the state commit, not an earlier validation guard');
      assert.equal(result.ok, false); assertNoSecrets(result); assertAuth(fixture);
      return result;
    } finally { fixture.store.saveAgents = saveAgents; fixture.store.saveAgentsIfUnchanged = saveAgentsIfUnchanged; }
  }
  function assertOriginalBackup(result, original) {
    assert(result.backup && fs.existsSync(result.backup));
    const manifest = json(result.backup);
    assert.equal(manifest.format, 'aurora-client-backup-v1');
    if (original === null) assert.equal(manifest.files[0].backup, null);
    else assert.equal(read(manifest.files[0].backup), original);
  }
  async function blockAgentFile(fixture, operation) {
    const target = path.join(fixture.store.dir, 'agents.json'), saved = path.join(fixture.store.dir, 'agents.before-test.json');
    assert(path.resolve(target).startsWith(path.resolve(scratch) + path.sep));
    const original = read(target), cached = JSON.stringify(fixture.store.listAgents());
    fs.renameSync(target, saved);
    fs.mkdirSync(target);
    try {
      const result = await operation();
      assert.equal(result.ok, false); assertNoSecrets(result); assertAuth(fixture);
      assert.equal(JSON.stringify(fixture.store.listAgents()), cached);
      assert.equal(read(saved), original); assert(fs.statSync(target).isDirectory());
      assert(!fs.readdirSync(fixture.store.dir).some(name => /^agents\.json\..*\.tmp$/.test(name)), 'Failed atomic write left a temporary state file');
      return result;
    } finally {
      fs.rmdirSync(target);
      fs.renameSync(saved, target);
      fixture.store.agents.flush();
      assert.equal(read(target), original, 'Failed write remained dirty and later committed partial state');
    }
  }
  async function failAtomicAgentRename(fixture, operation) {
    const target = path.join(fixture.store.dir, 'agents.json'), saved = path.join(fixture.store.dir, 'agents.before-rename-test.json');
    assert(path.resolve(target).startsWith(path.resolve(scratch) + path.sep));
    const original = read(target), cached = JSON.stringify(fixture.store.listAgents()), rename = fs.renameSync;
    let calls = 0;
    fs.renameSync = function(source, destination, ...args) {
      if (path.resolve(String(destination)) !== path.resolve(target) || !String(source).startsWith(target + '.') || !String(source).endsWith('.tmp')) return rename.call(this, source, destination, ...args);
      calls++; rename.call(fs, target, saved); fs.mkdirSync(target);
      try { return rename.call(this, source, destination, ...args); }
      finally { fs.rmdirSync(target); rename.call(fs, saved, target); }
    };
    try {
      const result = await operation();
      assert.equal(calls, 1, 'The native atomic agent-state commit must actually be attempted');
      assert.equal(result.ok, false); assert.equal(result.rolledBack, true); assertNoSecrets(result); assertAuth(fixture);
      assert.equal(read(target), original); assert.equal(JSON.stringify(fixture.store.listAgents()), cached);
      assert(!fs.readdirSync(fixture.store.dir).some(name => /^agents\.json\..*\.tmp$/.test(name)), 'Failed atomic write left a temporary state file');
      fixture.store.agents.flush(); assert.equal(read(target), original, 'A failed commit remained dirty');
      return result;
    } finally { fs.renameSync = rename; }
  }

  await check('first coexistence state failure removes new config/catalog and retains its undo manifest', async () => {
    const f = fixture('first-missing', null), before = stateSnapshot(f);
    const result = await failState(f, () => f.call('agent.connect'), states => assert.deepEqual(states.map(state => state.id), aliases));
    assert.equal(fs.existsSync(f.config), false); assert.equal(fs.existsSync(f.catalog), false); assertStates(f, before); assertOriginalBackup(result, null);
  });

  await check('first connection state failure restores original bytes and an existing catalog', async () => {
    const f = fixture('first-existing'); write(f.catalog, '{"models":[],"fixture":"original catalog"}\n');
    const files = snapshot([f.config, f.catalog]), before = stateSnapshot(f);
    const result = await failState(f, () => f.call('agent.connect'));
    assertSnapshot(files); assertStates(f, before); assertOriginalBackup(result, configOriginal);
  });

  await check('failed repeated switch returns to the previous selection and retains the first undo backup', async () => {
    const f = fixture('repeated'); const initial = await f.call('agent.connect'); assert(initial.ok, initial.message);
    const before = stateSnapshot(f), files = snapshot([f.config, f.catalog]);
    f.store.saveProvider({ id: f.provider.id, models: [...f.provider.models, { id: 'new-catalog-model' }] });
    const result = await failState(f, () => f.call('agent.connect', { model: 'model-two' }));
    assertSnapshot(files); assertStates(f, before); assertOriginalBackup(result, configOriginal);
    assert.equal(json(result.backup).files[0].backup, json(initial.backup).files[0].backup);
    assert.notEqual(read(f.config), configOriginal);
    const next = await f.call('agent.connect', { model: 'model-two' }); assert(next.ok, next.message);
    const restore = await f.call('agent.disconnect'); assert(restore.ok, restore.message); assert.equal(read(f.config), configOriginal);
  });

  await check('failed disconnect reestablishes the connected config and leaves shared state unchanged', async () => {
    const f = fixture('disconnect'); const first = await f.call('agent.connect'); assert(first.ok, first.message);
    const files = snapshot([f.config, f.catalog]), before = stateSnapshot(f);
    const result = await failState(f, () => f.call('agent.disconnect'));
    assertSnapshot(files); assertStates(f, before); assertOriginalBackup(result, configOriginal);
    assert(aliases.every(id => f.store.listAgents()[id].connected));
    const restore = await f.call('agent.disconnect'); assert(restore.ok, restore.message); assert.equal(read(f.config), configOriginal);
  });

  await check('connect conflict preserves the entire transaction and external edit for explicit recovery', async () => {
    const f = fixture('external-connect'), before = stateSnapshot(f);
    const external = '# external config\nsecret = "fixture-external-private"\n';
    const result = await failState(f, () => f.call('agent.connect'), () => write(f.config, external));
    assert.equal(read(f.config), external); assert.equal(result.recoveryRequired, true); assert.equal(result.rolledBack, false);
    assert(result.recoveryPath && fs.existsSync(result.recoveryPath)); assert.equal(json(result.recoveryPath).status, 'needs-recovery');
    assert.equal(fs.existsSync(f.catalog), true); assertStates(f, before); assertOriginalBackup(result, configOriginal);
  });

  await check('disconnect rollback keeps edits made after native restoration and retains the original backup', async () => {
    const f = fixture('external-disconnect'); const first = await f.call('agent.connect'); assert(first.ok, first.message);
    const before = stateSnapshot(f), external = '# third-party changed restored file\nsecret = "fixture-external-private"\n';
    const result = await failState(f, () => f.call('agent.disconnect'), () => write(f.config, external));
    assert.equal(read(f.config), external); assert.equal(result.recoveryRequired, true); assert.equal(result.rolledBack, false);
    assert(result.recoveryPath && fs.existsSync(result.recoveryPath)); assert.equal(json(result.recoveryPath).status, 'needs-recovery');
    assertStates(f, before); assertOriginalBackup(result, configOriginal);
  });

  await check('catalog conflict preserves the external edit and complete transaction without partially restoring client config', async () => {
    const f = fixture('external-catalog'), before = stateSnapshot(f), external = '{"fixture":"fixture-external-private"}\n';
    const result = await failState(f, () => f.call('agent.connect'), () => write(f.catalog, external));
    assert.equal(read(f.catalog), external); assert.notEqual(read(f.config), configOriginal);
    assert.equal(result.recoveryRequired, true); assert.equal(result.rolledBack, false);
    assert(result.recoveryPath && fs.existsSync(result.recoveryPath)); assert.equal(json(result.recoveryPath).status, 'needs-recovery'); assertStates(f, before);
  });

  function claudeFixture(label) {
    const f = fixture(label), files = api.getAdapter('claude-desktop').configPaths();
    write(files[0], '{"deploymentMode":"1p","userPreference":true}\n');
    write(files[2], '{"appliedId":"existing","entries":[{"id":"existing","name":"Keep"}]}\n');
    return { ...f, files, connect: () => f.call('agent.connect', { agentId: 'claude-desktop', model: 'claude-sonnet-4-6', authMode: 'api' }), disconnect: () => f.call('agent.disconnect', { agentId: 'claude-desktop' }) };
  }
  await check('Claude Desktop multi-file first connection rolls back existing and newly created files together', async () => {
    const f = claudeFixture('claude-connect'), files = snapshot(f.files), before = stateSnapshot(f);
    const result = await failState(f, f.connect);
    assertSnapshot(files); assertStates(f, before); assert.equal(json(result.backup).files.length, 4);
  });
  await check('Claude Desktop failed disconnect restores all four connected files and shared profile metadata', async () => {
    const f = claudeFixture('claude-disconnect'); const first = await f.connect(); assert(first.ok, first.message);
    const files = snapshot(f.files), before = stateSnapshot(f);
    await failState(f, f.disconnect); assertSnapshot(files); assertStates(f, before);
  });
  await check('Claude Desktop partial external conflict preserves that file while recovering the other three', async () => {
    const f = claudeFixture('claude-conflict'); const first = await f.connect(); assert(first.ok, first.message);
    const before = stateSnapshot(f), remaining = snapshot(f.files.slice(1)), external = '{"external":"fixture-external-private"}\n';
    const result = await failState(f, f.disconnect, () => write(f.files[0], external));
    assert.equal(read(f.files[0]), external); assertSnapshot(remaining); assertStates(f, before); assert(result.message.includes(f.files[0]));
  });

  if (process.platform === 'win32') for (const originalSource of ['standard', 'msix']) await check(`Claude Desktop ${originalSource} undo snapshots its original root after another installation appears`, async () => {
    const f = fixture(`claude-root-change-${originalSource}`), base = path.join(f.client, 'AppData', 'Local');
    const msix = path.join(base, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Local');
    if (originalSource === 'msix') fs.mkdirSync(msix, { recursive: true });
    const adapter = api.getAdapter('claude-desktop'), files = adapter.configPaths();
    write(files[0], '{"deploymentMode":"1p","originalInstallation":true}\n');
    write(files[2], '{"appliedId":"original","entries":[{"id":"original","name":"Keep"}]}\n');
    const originals = snapshot(files);
    const connect = () => f.call('agent.connect', { agentId: 'claude-desktop', model: 'claude-sonnet-4-6', authMode: 'api' });
    const disconnect = () => f.call('agent.disconnect', { agentId: 'claude-desktop' });
    const first = await connect(); assert(first.ok, first.message);
    const otherFile = path.join(originalSource === 'standard' ? msix : base, 'Claude-3p', 'configLibrary', 'other-installation.json');
    write(otherFile, '{"fixture":"other-installation-must-stay-unchanged"}\n');
    assert.deepEqual(adapter.configPaths(), [], 'Discovery must not pick a root when both installations have configuration');
    assert.deepEqual(adapter.restorePaths(first.backup), files);
    const connected = snapshot([...files, otherFile]), before = stateSnapshot(f);
    await failState(f, disconnect); assertSnapshot(connected); assertStates(f, before);
    assert.equal(f.store.listAgents()['claude-desktop'].backupPath, first.backup);
    const restored = await disconnect(); assert(restored.ok, restored.message); assertSnapshot(originals); assert.equal(read(otherFile), connected.at(-1).content);
  });

  await check('real agents.json rename failure keeps every existing shared state and rolls back a switch', async () => {
    const f = fixture('disk-connect'); const first = await f.call('agent.connect'); assert(first.ok, first.message);
    const files = snapshot([f.config, f.catalog]), before = stateSnapshot(f);
    await failAtomicAgentRename(f, () => f.call('agent.connect', { model: 'model-two' }));
    assertSnapshot(files); assertStates(f, before);
    const reopened = new api.AuroraStore(f.store.dir); assert(aliases.every(id => reopened.listAgents()[id].connected && reopened.listAgents()[id].model === 'model-one'));
  });
  await check('real agents.json rename failure during disconnect restores native files without partial alias changes', async () => {
    const f = fixture('disk-disconnect'); const first = await f.call('agent.connect'); assert(first.ok, first.message);
    const files = snapshot([f.config, f.catalog]), before = stateSnapshot(f);
    await failAtomicAgentRename(f, () => f.call('agent.disconnect'));
    assertSnapshot(files); assertStates(f, before);
    assert(aliases.every(id => new api.AuroraStore(f.store.dir).listAgents()[id].connected));
  });
  for (const action of ['agent.connect', 'agent.disconnect']) await check(`Unavailable agent-state storage rejects ${action} before any configuration change`, async () => {
    const f = fixture('unreadable-' + action); const first = await f.call('agent.connect'); assert(first.ok, first.message);
    const files = snapshot([f.config, f.catalog]), before = stateSnapshot(f);
    await blockAgentFile(f, () => f.call(action, { model: 'model-two' })); assertSnapshot(files); assertStates(f, before);
  });
  await check('coexistence connection parameters cannot export gateway or OAuth credentials', async () => {
    const f = fixture('parameters'), files = snapshot([f.config, f.catalog]), before = stateSnapshot(f);
    for (const providerId of [f.provider.id, 'official']) {
      const result = await f.call('agent.parameters', { providerId });
      assert.equal(result.ok, false); assert.equal(result.apiKey, undefined); assert.equal(result.script, undefined); assertNoSecrets(result);
    }
    assertSnapshot(files); assertStates(f, before); assertAuth(f);
  });
  assert.equal(failures.length, 0, failures.map(item => item.label).join('\n'));
  console.log(`\nAgent transactions: ${passed} checks passed.`);
} finally {
  if (originalClientHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = originalClientHome;
  assert(path.basename(scratch).startsWith('aurora-agent-transaction-'));
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
