import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { parse } from 'smol-toml';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunqiao-api-model-catalog-'));
const priorHome = process.env.AURORA_CLIENT_HOME;
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const native = (slug, overrides = {}) => ({ slug, display_name: slug, base_instructions: `Native ${slug} coding instructions.`,
  model_messages: { instructions_template: 'Native {personality} coding instructions.', instructions_variables: { personality: { default: 'default' } } },
  shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1, support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [],
  supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map(effort => ({ effort, description: effort })),
  default_reasoning_level: 'medium', input_modalities: ['text'], context_window: 272000, supports_parallel_tool_calls: true, ...overrides });
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log('PASS', name); };
try {
  const bundle = path.join(scratch, 'core.cjs');
  await build({ stdin: { contents: [
    "export * from './src/core/actions.ts';", "export * from './src/core/store/index.ts';",
    "export * from './src/core/agents/modelCatalog.ts';", "export * from './src/core/extensions/models.ts';",
  ].join('\n'), resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  function fixture(name, configText = 'model_reasoning_effort = "xhigh"\nmodel_context_window = 123\nmodel_auto_compact_token_limit = 100\n', options = {}) {
    const root = path.join(scratch, name), client = path.join(root, 'client');
    process.env.AURORA_CLIENT_HOME = client;
    const config = path.join(client, '.codex', 'config.toml');
    write(config, configText);
    const cache = path.join(client, '.codex', 'models_cache.json');
    if (!options.noMetadata) write(cache, JSON.stringify({ models: ['gpt-5.4', 'custom-text', 'custom-vision', 'no-thinking', 'new-text', 'direct-only-new'].map(id =>
      native(id, id === 'custom-text' ? { default_reasoning_level: null, supported_reasoning_levels: [] } : {})) }));
    const store = new api.AuroraStore(path.join(root, 'store'));
    store.saveSettings({ gatewayToken: 'fixture-gateway-secret', gatewayPort: 3425 });
    const provider = store.saveProvider({ name: '当前供应商', enabled: true, format: 'openai-responses', baseUrl: 'https://fixture.invalid/v1',
      apiKeys: [{ id: 'key', key: 'fixture-provider-secret', enabled: true, weight: 1 }],
      models: [{ id: 'gpt-5.4', contextWindow: 272000 }, { id: 'custom-text', contextWindow: 64000 }, { id: 'custom-vision', capabilities: { vision: true } },
        { id: 'no-thinking', capabilities: { thinking: false } }, { id: 'gpt-image-1' }, { id: 'text-embedding-3-large' }, { id: 'whisper-1' }] });
    store.saveProvider({ ...provider, id: undefined, name: '其他供应商', models: [{ id: 'not-current' }] });
    const deps = { store, dataDir: store.dir, gatewayUrl: () => 'http://127.0.0.1:3425', gatewayStatus: () => ({ running: true }),
      historyContext: { home: path.dirname(config), sqliteHome: path.dirname(config), blockingProcesses: async () => options.busy ? ['fixture-client-running'] : [] } };
    const payload = { agentId: 'codex-cli', providerId: provider.id, model: 'gpt-5.4', authMode: 'api', mode: 'gateway' };
    const call = (action, patch = {}) => api.runAction(deps, action, { ...payload, ...patch });
    const catalogDefault = path.join(store.dir, 'codex-api-model-catalog.json');
    const connect = async patch => { const preview = await call('agent.preview', patch); assert(preview.ok, preview.message); return call('agent.connect', { ...patch, revision: preview.revision }); };
    return { root, config, configText, cache, catalogDefault, get catalog() {
      const current = parse(read(config)).model_catalog_json;
      return typeof current === 'string' && /^codex-api-model-catalog(?:-\d+)?\.json$/.test(path.basename(current)) ? current : catalogDefault;
    }, store, provider, deps, payload, call, connect };
  }
  const noSecrets = value => { for (const secret of ['fixture-gateway-secret', 'fixture-provider-secret']) assert(!JSON.stringify(value).includes(secret)); };
  const guardOfficialFiles = async run => {
    const originalRead = fs.readFileSync, originalStat = fs.lstatSync; let attempts = 0;
    const guard = file => { if (typeof file === 'string' && /(?:^|[/\\])auth\.json$/.test(file)) { attempts++; throw new Error('API 模式不得读取官方身份'); } };
    fs.readFileSync = function(file, ...args) { guard(file); return originalRead.call(this, file, ...args); };
    fs.lstatSync = function(file, ...args) { guard(file); return originalStat.call(this, file, ...args); };
    try { const result = await run(); assert.equal(attempts, 0, 'API 模式不得尝试读取官方身份'); return result; }
    finally { fs.readFileSync = originalRead; fs.lstatSync = originalStat; }
  };
  await check('诊断识别已应用的 API 模型目录，并报告目录或配置的实际变更', async () => {
    const f = fixture('diagnose');
    write(f.catalogDefault, '{"outside":true}');
    const connected = await f.connect(); assert(connected.ok, connected.message);
    const config = read(f.config), file = f.catalog, original = read(file);
    assert.notEqual(file, f.catalogDefault);
    const parameters = async () => {
      const report = await api.runAction(f.deps, 'agent.diagnose', { agentId: 'codex-cli' });
      assert(report.ok, report.message); noSecrets(report);
      return report.checks.find(check => check.id === 'parameters').status;
    };
    assert.equal(await parameters(), 'ok');
    fs.unlinkSync(file); assert.equal(await parameters(), 'warning'); assert(!fs.existsSync(file));
    write(file, original.replace('Native gpt-5.4', 'Edited gpt-5.4')); assert.equal(await parameters(), 'warning');
    write(file, original); write(f.config, config.replace('fixture-gateway-secret', 'changed-gateway-secret'));
    assert.equal(await parameters(), 'warning');
    assert.equal(read(file), original); assert(read(f.config).includes('changed-gateway-secret'));
  });
  await check('API 网关无需官方身份，挂载当前供应商全部文本模型并保留 xhigh', async () => {
    const f = fixture('basic');
    await guardOfficialFiles(async () => {
      const preview = await f.call('agent.preview'); assert(preview.ok, preview.message); noSecrets(preview);
      assert.equal(read(f.config), f.configText); assert(!fs.existsSync(f.catalog));
      const connected = await f.call('agent.connect', { revision: preview.revision }); assert(connected.ok, connected.message); noSecrets(connected);
      const config = parse(read(f.config)), catalog = json(f.catalog);
      assert.equal(config.model_catalog_json, f.catalog); assert.equal(config.model, `${f.provider.id}/gpt-5.4`);
      assert.equal(config.model_reasoning_effort, 'xhigh'); assert.equal(config.model_context_window, undefined); assert.equal(config.model_auto_compact_token_limit, undefined);
      assert.equal(config.model_providers.yunqiao.requires_openai_auth, false);
      assert.deepEqual(catalog.models.map(m => m.slug), ['gpt-5.4', 'custom-text', 'custom-vision', 'no-thinking'].map(id => `${f.provider.id}/${id}`));
      assert.deepEqual(catalog.models[0].supported_reasoning_levels.map(x => x.effort), ['low', 'medium', 'high', 'xhigh']);
      assert.equal(catalog.models[0].auto_compact_token_limit, 244800);
      assert.equal(catalog.models[1].default_reasoning_level, null); assert.deepEqual(catalog.models[1].supported_reasoning_levels, []);
      assert.deepEqual(catalog.models[2].input_modalities, ['text', 'image']);
      for (const model of catalog.models) { assert.equal(model.supports_parallel_tool_calls, true); assert(model.base_instructions.startsWith('Native ')); assert(model.model_messages.instructions_template); }
      assert.equal(catalog.models[3].default_reasoning_level, null); assert.deepEqual(catalog.models[3].supported_reasoning_levels, []);
      assert.equal(catalog.yunqiao.storageVersion, 1); assert.match(catalog.yunqiao.contentSha256, /^[a-f0-9]{64}$/);
      const desktop = api.desktopModelCatalog(f.store); assert.deepEqual(desktop.models, catalog.models.map(m => m.slug));
      assert(desktop.modelMetadata[`${f.provider.id}/gpt-5.4`].supportedReasoningEfforts.some(x => x.reasoningEffort === 'xhigh')); noSecrets(desktop);
      const disconnected = await f.call('agent.disconnect'); assert(disconnected.ok, disconnected.message); assert.equal(read(f.config), f.configText);
    });
  });
  await check('缺少原生资料或客户端运行中时继续保存配置与 90% 压缩阈值', async () => {
    for (const options of [{ noMetadata: true }, { busy: true }]) {
      const f = fixture('fallback-' + Object.keys(options)[0], undefined, options);
      await guardOfficialFiles(async () => {
        const result = await f.connect(); assert(result.ok, result.message);
        const config = parse(read(f.config));
        assert.equal(config.model_catalog_json, undefined); assert(!fs.existsSync(f.catalog));
        assert.equal(config.model_context_window, 272000); assert.equal(config.model_auto_compact_token_limit, 244800);
        assert.equal(config.model_provider, 'yunqiao'); assert.equal(config.model, `${f.provider.id}/gpt-5.4`);
        if (options.busy) { assert.equal(result.history.status, 'deferred'); assert.equal(result.history.code, 'CLIENT_HISTORY_BUSY'); }
        const restored = await f.call('agent.disconnect'); assert(restored.ok, restored.message); assert.equal(read(f.config), f.configText);
      });
    }
  });
  await check('未知历史模型仍保留所选模型预算，配置可以保存', async () => {
    const f = fixture('history-fallback');
    const file = path.join(path.dirname(f.config), 'sessions', 'unindexed.jsonl');
    const original = JSON.stringify({ type: 'turn_context', payload: { model: 'retired-model' } }) + '\n';
    write(file, original);
    const result = await f.connect(); assert(result.ok, result.message);
    const config = parse(read(f.config)); assert.equal(config.model_catalog_json, undefined);
    assert.equal(config.model_context_window, 272000); assert.equal(config.model_auto_compact_token_limit, 244800);
    assert.equal(read(file), original);
  });
  await check('预览后客户端退出不会阻止已预览的兼容配置保存', async () => {
    const f = fixture('busy-preview-idle-connect', undefined, { busy: true });
    const preview = await f.call('agent.preview'); assert(preview.ok, preview.message);
    f.deps.historyContext.blockingProcesses = async () => [];
    const result = await f.call('agent.connect', { revision: preview.revision });
    assert(result.ok, result.message);
    assert.equal(parse(read(f.config)).model_context_window, 272000);
    assert.equal(parse(read(f.config)).model_catalog_json, undefined);
  });
  await check('预览后客户端启动仍可保存，历史新增时仅降级目录优化', async () => {
    for (const changedHistory of [false, true]) {
      const f = fixture('idle-preview-running-' + changedHistory);
      const preview = await f.call('agent.preview'); assert(preview.ok, preview.message);
      f.deps.historyContext.blockingProcesses = async () => ['fixture-running-after-preview'];
      if (changedHistory) write(path.join(path.dirname(f.config), 'sessions', 'new-unindexed.jsonl'),
        JSON.stringify({ type: 'turn_context', payload: { model: 'new-retired-model' } }) + '\n');
      const result = await f.call('agent.connect', { revision: preview.revision }); assert(result.ok, result.message);
      const config = parse(read(f.config));
      if (changedHistory) { assert.equal(config.model_context_window, 272000); assert.equal(config.model_auto_compact_token_limit, 244800); assert.equal(config.model_catalog_json, undefined); }
      else assert.equal(config.model_catalog_json, f.catalog);
      assert.equal(result.history.code, 'CLIENT_HISTORY_BUSY');
    }
  });
  await check('目录辅助降级不会绕过配置、权限或供应商变更校验', async () => {
    for (const kind of ['config', 'permission', 'provider', 'catalog']) {
      const f = fixture('downgrade-validation-' + kind), preview = await f.call('agent.preview'); assert(preview.ok);
      write(path.join(path.dirname(f.config), 'sessions', 'unindexed.jsonl'), JSON.stringify({ type: 'turn_context', payload: { model: 'retired-model' } }) + '\n');
      if (kind === 'config') write(f.config, f.configText + '# outside edit\n');
      if (kind === 'provider') f.store.saveProvider({ id: f.provider.id, name: 'changed outside preview' });
      if (kind === 'catalog') write(f.catalogDefault, '{"outside":true}');
      const before = read(f.config);
      const result = await f.call('agent.connect', { revision: preview.revision, ...(kind === 'permission' ? { permissionMode: 'full-access' } : {}) });
      assert.equal(result.ok, false, kind); assert.equal(read(f.config), before); assert(!f.store.listAgents()['codex-cli']?.connected);
    }
  });
  await check('目录内容或供应商列表在预览后变化时拒绝写入', async () => {
    for (const kind of ['catalog', 'models']) {
      const f = fixture('stale-' + kind), preview = await f.call('agent.preview'); assert(preview.ok);
      if (kind === 'catalog') write(f.catalog, '{"models":[],"external":"保留"}\n');
      else f.store.saveProvider({ id: f.provider.id, models: [...f.provider.models, { id: 'later-text' }] });
      const beforeCatalog = fs.existsSync(f.catalog) ? read(f.catalog) : null;
      const result = await f.call('agent.connect', { revision: preview.revision }); assert.equal(result.ok, false); assert.equal(read(f.config), f.configText);
      assert.equal(fs.existsSync(f.catalog) ? read(f.catalog) : null, beforeCatalog);
    }
  });
  await check('配置写入失败和连接状态保存失败均回滚目录与配置', async () => {
    for (const kind of ['write', 'state']) {
      const f = fixture('failure-' + kind), originalWrite = fs.writeFileSync;
      write(f.catalog, '{"models":[],"prior":true}\n'); const before = read(f.catalog);
      if (kind === 'state') f.store.saveAgentsIfUnchanged = () => { throw new Error('fixture-state-failure'); };
      else fs.writeFileSync = function(file, ...args) { if (String(file).startsWith(f.config + '.aurora-')) throw Object.assign(new Error('fixture-write-failure'), { code: 'EACCES' }); return originalWrite.call(this, file, ...args); };
      let result; try { result = await f.connect(); } finally { fs.writeFileSync = originalWrite; }
      assert.equal(result.ok, false); assert.equal(read(f.config), f.configText); assert.equal(read(f.catalog), before);
      assert(!fs.existsSync(path.join(f.store.dir, 'codex-api-model-catalog-2.json')));
      assert(!f.store.listAgents()['codex-cli']?.connected); noSecrets(result);
    }
  });
  await check('数据目录经系统别名访问时，失败回滚仍识别规范化模型目录', async () => {
    for (const kind of ['write', 'state']) {
      const f = fixture('aliased-rollback-' + kind), originalWrite = fs.writeFileSync;
      const physical = path.join(f.root, 'physical-data'), alias = path.join(f.root, 'data-alias');
      fs.mkdirSync(physical);
      fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const store = new api.AuroraStore(alias);
      store.saveSettings({ gatewayToken: 'fixture-gateway-secret', gatewayPort: 3425 });
      const provider = store.saveProvider({ ...f.provider, id: undefined });
      const deps = { ...f.deps, store, dataDir: alias };
      const payload = { ...f.payload, providerId: provider.id };
      const reserved = path.join(alias, 'codex-api-model-catalog.json'), original = '{"models":[],"external":true}';
      write(reserved, original);
      if (kind === 'state') store.saveAgentsIfUnchanged = () => { throw new Error('fixture-state-failure'); };
      else fs.writeFileSync = function(file, ...args) { if (String(file).startsWith(f.config + '.aurora-')) throw Object.assign(new Error('fixture-write-failure'), { code: 'EACCES' }); return originalWrite.call(this, file, ...args); };
      let result;
      try {
        const preview = await api.runAction(deps, 'agent.preview', payload); assert(preview.ok, preview.message);
        result = await api.runAction(deps, 'agent.connect', { ...payload, revision: preview.revision });
      } finally { fs.writeFileSync = originalWrite; }
      assert.equal(result.ok, false); assert.equal(result.recoveryRequired, false);
      assert.equal(read(f.config), f.configText); assert.equal(read(reserved), original);
      assert(!fs.existsSync(path.join(physical, 'codex-api-model-catalog-2.json')));
      assert(!store.listAgents()['codex-cli']?.connected);
      fs.unlinkSync(alias);
    }
  });
  await check('目录原子写 CAS 保留写入期间出现的外部修改', async () => {
    const f = fixture('catalog-cas'), preview = await f.call('agent.preview'); assert(preview.ok);
    const originalWrite = fs.writeFileSync; let raced = false;
    fs.writeFileSync = function(file, ...args) {
      const result = originalWrite.call(this, file, ...args);
      if (!raced && String(file).startsWith(f.catalog + '.aurora-')) { raced = true; originalWrite.call(this, f.catalog, '{"external":"保留并发修改"}'); }
      return result;
    };
    let result; try { result = await f.call('agent.connect', { revision: preview.revision }); } finally { fs.writeFileSync = originalWrite; }
    assert(raced); assert.equal(result.ok, false); assert.equal(read(f.config), f.configText);
    assert.equal(read(f.catalog), '{"external":"保留并发修改"}'); assert(!f.store.listAgents()['codex-cli']?.connected);
  });
  await check('既有根目录或 profile 目录成功切换且恢复后原文件不动', async () => {
    for (const kind of ['root', 'profile', 'reserved', 'legacy-shared']) {
      const f = fixture('external-' + kind);
      const originalFile = kind === 'reserved' ? f.catalogDefault : kind === 'legacy-shared' ? path.join(f.store.dir, 'codex-model-catalog.json') : path.join(f.root, 'custom-models.json');
      const original = '{"models":[{"slug":"original-model"}],"custom":true}\n';
      write(originalFile, original);
      const source = (kind === 'profile' ? 'profile = "work"\n[profiles.work]\n' : '') + `model_catalog_json = ${JSON.stringify(originalFile)}\n`;
      write(f.config, source);
      const preview = await f.call('agent.preview'); assert(preview.ok, preview.message); assert.equal(read(originalFile), original);
      const result = await f.call('agent.connect', { revision: preview.revision }); assert(result.ok, result.message);
      assert.notEqual(parse(read(f.config)).model_catalog_json, originalFile); assert.equal(read(originalFile), original);
      const restored = await f.call('agent.disconnect'); assert(restored.ok, restored.message);
      assert.equal(read(f.config), source); assert.equal(read(originalFile), original);
      const direct = await f.connect({ mode: 'direct' }); assert(direct.ok, direct.message);
      const parsed = parse(read(f.config));
      if (kind !== 'legacy-shared') assert.equal(parsed.profiles?.work?.model_catalog_json ?? parsed.model_catalog_json, originalFile);
      assert.equal(read(originalFile), original);
    }
  });
  await check('刷新反映模型新增删除，且不会覆盖外部目录或直连', async () => {
    const f = fixture('refresh'), result = await f.connect(); assert(result.ok, result.message);
    f.store.saveProvider({ id: f.provider.id, models: [{ id: 'gpt-5.4', contextWindow: 128000 }, { id: 'new-text' }] });
    await guardOfficialFiles(() => api.refreshGatewayModelCatalog(f.store));
    assert.deepEqual(json(f.catalog).models.map(m => m.slug), [`${f.provider.id}/gpt-5.4`, `${f.provider.id}/new-text`]);
    assert.equal(json(f.catalog).models[0].context_window, 128000);
    const priorFile = f.catalog, prior = read(priorFile);
    const direct = await f.connect({ mode: 'direct' }); assert(direct.ok, direct.message); assert.equal(parse(read(f.config)).model_catalog_json, undefined);
    f.store.saveProvider({ id: f.provider.id, models: [{ id: 'gpt-5.4' }, { id: 'direct-only-new' }] });
    api.refreshGatewayModelCatalog(f.store); assert.equal(read(priorFile), prior);
    const again = await f.connect(); assert(again.ok, again.message);
    const externalFile = f.catalog, external = '{"models":[],"external":true}';
    write(externalFile, external); api.refreshGatewayModelCatalog(f.store); assert.equal(read(externalFile), external);
    const recovered = await f.connect(); assert(recovered.ok, recovered.message);
    assert.notEqual(f.catalog, externalFile); assert.equal(read(externalFile), external);
  });
  await check('刷新清理已停用或删除供应商，不泄露其他供应商模型', async () => {
    for (const action of ['disable', 'delete']) {
      const f = fixture('unavailable-' + action), connected = await f.connect(); assert(connected.ok, connected.message);
      if (action === 'disable') f.store.saveProvider({ id: f.provider.id, enabled: false });
      else f.store.providers.write(f.store.listProviders().filter(provider => provider.id !== f.provider.id));
      api.refreshGatewayModelCatalog(f.store); assert.deepEqual(json(f.catalog).models, []);
    }
  });
  await check('原生目录、直连与官方共存切换后恢复首次配置，目录和身份互不覆盖', async () => {
    const f = fixture('native-direct-coexist');
    const first = await f.connect(); assert(first.ok, first.message);
    const apiFile = f.catalog, apiText = read(apiFile);
    const direct = await f.connect({ mode: 'direct' }); assert(direct.ok, direct.message);
    assert.equal(parse(read(f.config)).model_catalog_json, undefined); assert.equal(read(apiFile), apiText);
    const token = `${Buffer.from('{"alg":"fixture"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`;
    const authFile = path.join(path.dirname(f.config), 'auth.json');
    const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'fixture-refresh', account_id: 'fixture-account' } });
    write(authFile, auth);
    const cached = json(f.cache); write(f.cache, JSON.stringify({ ...cached, models: cached.models.map(model => ({ ...model, slug: 'official/' + model.slug })) }));
    const coexist = await f.connect({ authMode: 'coexist' }); assert(coexist.ok, coexist.message);
    const coexistFile = parse(read(f.config)).model_catalog_json;
    assert.equal(coexistFile, path.join(f.store.dir, 'codex-model-catalog.json')); assert.notEqual(coexistFile, apiFile);
    assert.equal(read(apiFile), apiText); assert.equal(read(authFile), auth);
    const coexistText = read(coexistFile);
    const again = await f.connect(); assert(again.ok, again.message); assert.notEqual(f.catalog, coexistFile);
    assert.equal(read(coexistFile), coexistText); assert.equal(read(authFile), auth);
    const restored = await f.call('agent.disconnect'); assert(restored.ok, restored.message);
    assert.equal(read(f.config), f.configText); assert.equal(read(apiFile), apiText); assert.equal(read(coexistFile), coexistText); assert.equal(read(authFile), auth);
  });
  await check('原生资料消失后刷新保留已用目录，重新保存降级且恢复原配置', async () => {
    const f = fixture('metadata-disappears');
    const connected = await f.connect(); assert(connected.ok, connected.message);
    const catalogFile = f.catalog, originalCatalog = read(catalogFile);
    fs.unlinkSync(f.cache);
    assert.throws(() => api.refreshGatewayModelCatalog(f.store), /原生模型资料/);
    assert.equal(read(catalogFile), originalCatalog);
    const fallback = await f.connect(); assert(fallback.ok, fallback.message);
    const config = parse(read(f.config)); assert.equal(config.model_catalog_json, undefined);
    assert.equal(config.model_context_window, 272000); assert.equal(config.model_auto_compact_token_limit, 244800);
    assert.equal(read(catalogFile), originalCatalog);
    const restored = await f.call('agent.disconnect'); assert(restored.ok, restored.message); assert.equal(read(f.config), f.configText);
  });
  await check('已连接目录损坏或缺失时兼容配置解除引用，保留外部目录内容', async () => {
    for (const kind of ['missing', 'invalid-json', 'external-edit', 'busy']) {
      const f = fixture('broken-mounted-' + kind), connected = await f.connect(); assert(connected.ok, connected.message);
      const catalogFile = f.catalog;
      if (kind === 'missing') fs.unlinkSync(catalogFile);
      else write(catalogFile, kind === 'external-edit' ? '{"models":[],"external":"preserve"}' : '{broken catalog');
      const preserved = fs.existsSync(catalogFile) ? read(catalogFile) : undefined;
      if (kind === 'busy') f.deps.historyContext.blockingProcesses = async () => ['fixture-client-running'];
      else fs.unlinkSync(f.cache);
      const fallback = await f.connect(); assert(fallback.ok, fallback.message);
      const config = parse(read(f.config)); assert.equal(config.model_catalog_json, undefined);
      assert.equal(config.model_context_window, 272000); assert.equal(config.model_auto_compact_token_limit, 244800);
      assert.equal(fs.existsSync(catalogFile) ? read(catalogFile) : undefined, preserved);
      const restored = await f.call('agent.disconnect'); assert(restored.ok, restored.message); assert.equal(read(f.config), f.configText);
      assert.equal(fs.existsSync(catalogFile) ? read(catalogFile) : undefined, preserved);
    }
  });
  await check('profile 网关目录仅写根级且清除旧的全局窗口覆盖', async () => {
    const f = fixture('profile', 'profile = "work"\n[profiles.work]\nmodel_context_window = 99\nmodel_auto_compact_token_limit = 90\n');
    const result = await f.connect(); assert(result.ok, result.message);
    const parsed = parse(read(f.config)); assert.equal(parsed.model_catalog_json, f.catalog); assert.equal(parsed.profiles.work.model_catalog_json, undefined);
    assert.equal(parsed.profiles.work.model_context_window, undefined); assert.equal(parsed.profiles.work.model_auto_compact_token_limit, undefined);
  });
  console.log(`API 原生模型目录：${passed} 项隔离检查通过`);
} finally {
  if (priorHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = priorHome;
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir())); fs.rmSync(scratch, { recursive: true, force: true });
}
