/** Real delayed HTTP responses must not overwrite concurrent local provider edits. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunqiao-model-sync-')));
const bundle = path.join(scratch, 'core.cjs');
await build({ stdin: { contents: "export { fetchProviderModels } from './src/core/actions.ts'; export { AuroraStore } from './src/core/store/index.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
const { fetchProviderModels, AuroraStore } = createRequire(import.meta.url)(bundle);
let received, reply, requests = 0, passed = 0;
const server = http.createServer((_request, response) => {
  requests++;
  reply = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  received();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const store = new AuroraStore(path.join(scratch, 'data'));
async function check(name, mutate, verify, response = { data: [{ id: 'existing', context_window: 999 }, { id: 'remove-me' }, { id: 'discovered', context_window: 128000 }] }) {
  const provider = store.saveProvider({ name: 'before', baseUrl: endpoint, format: 'openai-chat', models: [{ id: 'existing', inputPrice: 2 }, { id: 'remove-me' }], apiKeys: [{ id: 'fixture', key: 'test-only-not-a-secret', enabled: true, weight: 1, label: 'test' }] });
  const ready = new Promise(resolve => { received = resolve; });
  const pending = fetchProviderModels({ store }, { providerId: provider.id });
  await ready;
  await mutate(provider);
  reply(response);
  const result = await pending;
  verify(result, store.getProvider(provider.id), provider);
  passed++; console.log('PASS', name);
}
try {
  await check('Deleted providers stay deleted after a delayed models response', p => store.deleteProvider(p.id), (result, current) => { assert.equal(result.ok, false); assert.equal(current, undefined); });
  await check('Concurrent model deletion and price/name edits survive synchronization', p => store.saveProvider({ ...p, name: 'edited', models: [{ id: 'existing', inputPrice: 9, capabilities: { tools: true } }] }), (result, current) => {
    assert.equal(result.ok, true); assert.equal(result.added, 1); assert.equal(current.name, 'edited');
    assert.deepEqual(current.models.map(m => m.id), ['existing', 'discovered']);
    assert.equal(current.models[0].inputPrice, 9); assert.equal(current.models[0].contextWindow, undefined); assert.equal(current.models[0].capabilities.tools, true);
  });
  await check('Changing the API endpoint discards the previous service response', p => store.saveProvider({ ...p, baseUrl: endpoint + '/changed' }), (result, current) => { assert.equal(result.ok, false); assert.match(result.message, /连接配置已变化/); assert.equal(current.models.length, 2); });
  await check('Rotating API credentials discards the previous account response', p => store.saveProvider({ ...p, apiKeys: [{ ...p.apiKeys[0], key: 'rotated-test-only-key' }] }), (result, current) => { assert.equal(result.ok, false); assert.equal(current.apiKeys[0].key, 'rotated-test-only-key'); assert.equal(current.models.length, 2); });
  await check('Mixed invalid model records do not discard valid models or save invalid limits', () => {}, (result, current) => {
    assert.equal(result.ok, true); assert.equal(result.added, 2);
    assert.deepEqual(current.models.map(m => m.id), ['existing', 'remove-me', 'good', 'bounded']);
    assert.equal(current.models[2].contextWindow, undefined); assert.equal(current.models[3].contextWindow, 32000);
  }, { data: [null, 5, { id: 12 }, { id: 'bad\nid' }, { id: 'good', context_window: -1 }, { id: 'good' }, { name: 'models/bounded', inputTokenLimit: 32000 }] });
  await check('显式 reasoning 元数据规范化且不覆盖本地或并发能力设置', p => store.saveProvider({ ...p,
    models: [{ id: 'existing', capabilities: { tools: true, thinking: false } }, { id: 'remove-me' }] }), (result, current) => {
    assert.equal(result.ok, true);
    const models = Object.fromEntries(current.models.map(model => [model.id, model]));
    assert.deepEqual(models.existing.capabilities, { tools: true, thinking: false });
    assert.equal(models['remove-me'].capabilities.thinking, true);
    assert.equal(models['gpt-6.2-sol'].capabilities.thinking, true);
    assert.equal(models['explicit-off'].capabilities.thinking, false);
    assert.equal(models['capability-off'].capabilities.thinking, false);
    assert.equal(models['unknown-reasoning'].capabilities, undefined);
  }, { data: [
    { id: 'existing', reasoning: true }, { id: 'remove-me', capabilities: { reasoning: true } },
    { id: 'gpt-6.2-sol', reasoning: true }, { id: 'explicit-off', reasoning: false },
    { id: 'capability-off', capabilities: { thinking: false, reasoning: true }, reasoning: true },
    { id: 'unknown-reasoning', reasoning: 'true' },
  ] });
  const original = store.saveProvider.bind(store);
  await check('Image capability metadata preserves explicit and concurrent local choices', p => store.saveProvider({ ...p,
    models: [{ id: 'existing', capabilities: { tools: true, vision: false } }, { id: 'remove-me' }] }), (result, current) => {
    assert.equal(result.ok, true);
    const models = Object.fromEntries(current.models.map(model => [model.id, model]));
    assert.deepEqual(models.existing.capabilities, { tools: true, vision: false });
    assert.equal(models['remove-me'].capabilities.vision, true);
    assert.equal(models['modality-image'].capabilities.vision, true);
    assert.equal(models['modality-text'].capabilities.vision, false);
    assert.equal(models['explicit-off'].capabilities.vision, false);
    assert.equal(models['nested-image'].capabilities.vision, true);
    for (const id of ['unknown', 'invalid', 'empty']) assert.equal(models[id].capabilities, undefined);
  }, { data: [
    { id: 'existing', vision: true }, { id: 'remove-me', capabilities: { vision: true } },
    { id: 'modality-image', input_modalities: ['text', 'image'] }, { id: 'modality-text', input_modalities: ['text'] },
    { id: 'explicit-off', capabilities: { vision: false }, input_modalities: ['text', 'image'] },
    { id: 'nested-image', architecture: { input_modalities: ['text', 'image'] } },
    { id: 'unknown' }, { id: 'invalid', vision: 'true', input_modalities: [null] }, { id: 'empty', input_modalities: [] },
  ] });
  try {
    await check('Local persistence errors remain explicit without retrying another endpoint', () => { store.saveProvider = () => { throw new Error('fixture full disk'); }; }, (result, current) => {
      assert.equal(result.ok, false); assert.match(result.message, /本地保存失败/); assert.equal(current.models.length, 2);
    });
  } finally { store.saveProvider = original; }
  await check('Discovery skips explicit non-chat primary endpoints and keeps unclassified or vision-capable chat models', () => {}, (result, current) => {
    assert.equal(result.ok, true);
    assert.deepEqual(current.models.map(model => model.id), ['existing', 'remove-me', 'vision-chat', 'unlabelled', 'unknown-type', 'wrong-shape', 'empty-types']);
    assert.equal(current.models[0].inputPrice, 2);
    assert.equal(current.models[0].capabilities, undefined);
    assert.equal(current.models[2].capabilities.vision, true);
  }, { data: [
    { id: 'existing', supported_endpoint_types: ['image-generation'], vision: true },
    { id: 'gemini-nano-banana', supported_endpoint_types: ['image-generation', 'openai'] },
    { id: 'seedance', supported_endpoint_types: ['openai-video'] },
    { id: 'vectors', supported_endpoint_types: ['embeddings'] },
    { id: 'ranker', supported_endpoint_types: ['jina-rerank'] },
    { id: 'vision-chat', supported_endpoint_types: ['openai', 'image-generation'], vision: true },
    { id: 'unlabelled' }, { id: 'unknown-type', supported_endpoint_types: ['future-protocol'] },
    { id: 'wrong-shape', supported_endpoint_types: 'embeddings' }, { id: 'empty-types', supported_endpoint_types: [] },
  ] });
  await check('A non-chat-only list reports the reason and preserves concurrent edits', p => store.saveProvider({
    ...p, models: [{ id: 'existing', displayName: 'Manually edited' }],
  }), (result, current) => {
    assert.equal(result.ok, false);
    assert.match(result.message, /对话模型/);
    assert.deepEqual(result.models, current.models);
    assert.deepEqual(current.models.map(model => model.id), ['existing']);
    assert.equal(current.models[0].displayName, 'Manually edited');
  }, { data: [{ id: 'seedance', supported_endpoint_types: ['openai-video'] }] });
  assert.equal(requests, passed);
  const observed = [];
  const destination = http.createServer((request, response) => {
    observed.push(request.headers);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'fixture-destination' }] }));
  });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  try {
    const newBase = `http://127.0.0.1:${destination.address().port}`;
    const key = (id, value) => ({ id, key: value, label: id, enabled: true, weight: 1 });
    const args = { name: 'origin fixture', baseUrl: endpoint, apiKeys: [key('one', 'old-one'), key('two', 'old-two')],
      headers: { Authorization: 'Bearer old-auth', 'X-Custom': 'old-header' }, balanceQuery: { adapter: 'custom',
        url: endpoint + '/balance', auth: 'token', token: 'old-balance', balancePath: 'remaining', headers: { Cookie: 'old-cookie' } } };
    for (const fullDraft of [true, false]) {
      const source = store.saveProvider(args);
      const retained = store.saveProvider({ id: source.id, baseUrl: endpoint + '/v1' });
      assert.deepEqual(retained.apiKeys, source.apiKeys); assert.deepEqual(retained.headers, source.headers); assert.deepEqual(retained.balanceQuery, source.balanceQuery);
      const saved = store.saveProvider({ ...(fullDraft ? retained : { id: source.id }), baseUrl: newBase });
      assert(saved.apiKeys.every(item => !item.key)); assert.equal(saved.headers, undefined); assert.equal(saved.balanceQuery, undefined);
      const discovered = await fetchProviderModels({ store }, { providerId: saved.id });
      assert.equal(discovered.ok, true); assert(!JSON.stringify(observed.at(-1)).includes('old-'));
    }
    const source = store.saveProvider(args);
    const saved = store.saveProvider({ ...source, baseUrl: newBase, apiKeys: [key('replacement', 'new-key'), key('copied', 'old-two')],
      headers: { authorization: 'Bearer old-auth', 'X-Old-Under-Another-Name': 'old-header', 'X-New': 'new-header' } });
    assert.deepEqual(saved.apiKeys.map(item => item.key), ['new-key', '']); assert.deepEqual(saved.headers, { 'X-New': 'new-header' });
    const discovered = await fetchProviderModels({ store }, { providerId: saved.id });
    assert.equal(discovered.ok, true); assert.equal(observed.at(-1).authorization, 'Bearer new-key'); assert.equal(observed.at(-1)['x-new'], 'new-header');
    assert(!JSON.stringify(observed.at(-1)).includes('old-')); assert.equal(observed.length, 3);
    passed += 3; console.log('PASS origin isolation for full drafts, partial saves and explicit replacement credentials');
  } finally { destination.closeAllConnections(); await new Promise(resolve => destination.close(resolve)); }
  async function checkPages(format, pageResponse, verify, { pathname = '/relay', key = 'paging-fixture' } = {}) {
    const pages = [];
    const upstream = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost');
      pages.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers });
      const { body, status = 200 } = pageResponse(pages.length);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const provider = store.saveProvider({ name: 'paged catalog', format,
        baseUrl: `http://127.0.0.1:${upstream.address().port}${pathname}`, models: [{ id: 'kept', inputPrice: 3 }],
        apiKeys: [{ id: 'fixture', key, label: '', enabled: true, weight: 1 }] });
      const result = await fetchProviderModels({ store }, { providerId: provider.id });
      verify({ result, pages, saved: store.getProvider(provider.id).models });
      passed++;
    } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  }
  for (const [format, operation, expected] of [
    ['openai-chat', '/relay/v2/chat/completions', '/relay/v2/models'],
    ['openai-responses', '/relay/v1/responses', '/relay/v1/models'],
    ['anthropic', '/relay/v1/messages', '/relay/v1/models'],
    ['gemini', '/relay/v1alpha/models/gemini-model:streamGenerateContent', '/relay/v1alpha/models'],
  ]) {
    await checkPages(format, () => ({ body: { data: [{ id: 'discovered' }] } }), ({ result, pages }) => {
      assert(result.ok, result.message); assert.deepEqual(pages.map(page => page.path), [expected]);
      for (const header of ['authorization', 'x-api-key', 'x-goog-api-key']) assert.equal(pages[0].headers[header], undefined);
    }, { pathname: operation, key: '' });
  }
  {
    const p = store.saveProvider({ name: 'legacy endpoint', format: 'openai-chat', baseUrl: endpoint, models: [{ id: 'kept' }] });
    const originalGet = store.getProvider.bind(store);
    try {
      for (const baseUrl of ['malformed', null, 'https://user:private@localhost/v1/responses', 'ftp://localhost']) {
        store.getProvider = id => id === p.id ? { ...p, baseUrl } : originalGet(id);
        const result = await fetchProviderModels({ store }, { providerId: p.id });
        assert.equal(result.ok, false); assert.deepEqual(result.models, p.models); assert(!result.message.includes('private'));
      }
      passed++; console.log('PASS invalid legacy endpoints retain configured models and return a result');
    } finally { store.getProvider = originalGet; }
  }
  const token = 'opaque/+&=?%';
  await checkPages('gemini', page => ({ body: page === 1 ? { models: [], nextPageToken: token }
    : { models: [{ name: 'models/gemini-page-two', inputTokenLimit: 48000 }, { name: 'models/kept' }] } }), ({ result, pages, saved }) => {
    assert.equal(result.ok, true); assert.equal(result.added, 1);
    assert.deepEqual(saved.map(m => m.id), ['kept', 'gemini-page-two']); assert.equal(saved[0].inputPrice, 3);
    assert.equal(saved[1].contextWindow, 48000); assert.deepEqual(pages.map(p => p.query), [{}, { pageToken: token }]);
    assert(pages.every(p => p.path === '/relay/v1beta/models' && p.headers['x-goog-api-key'] === 'paging-fixture'));
  });
  await checkPages('anthropic', page => ({ body: page === 1 ? { data: [{ id: 'claude-first' }], has_more: true, last_id: token }
    : { data: [{ id: 'claude-first' }, { id: 'claude-second' }], has_more: false, last_id: 'unused' } }), ({ result, pages, saved }) => {
    assert.equal(result.ok, true); assert.equal(result.added, 2); assert.deepEqual(saved.map(m => m.id), ['kept', 'claude-first', 'claude-second']);
    assert.deepEqual(pages.map(p => p.query), [{}, { after_id: token }]);
    assert(pages.every(p => p.path === '/relay/v1/models' && p.headers['x-api-key'] === 'paging-fixture'));
  });
  function incomplete({ result, saved }) {
    assert.equal(result.ok, false); assert.match(result.message, /模型列表/); assert.deepEqual(saved, [{ id: 'kept', inputPrice: 3 }]); assert.deepEqual(result.models, saved);
  }
  await checkPages('gemini', page => ({ body: { models: [{ name: 'models/partial' }], nextPageToken: String(page % 2) } }), context => {
    incomplete(context); assert.equal(context.pages.length, 3);
  });
  await checkPages('anthropic', page => page === 1 ? { body: { data: [{ id: 'partial' }], has_more: true, last_id: 'next' } }
    : { status: 503, body: { error: 'unavailable' } }, context => {
    incomplete(context); assert.equal(context.pages.length, 2); assert.match(context.result.message, /2/);
  });
  await checkPages('anthropic', () => ({ body: { data: [{ id: 'partial' }], has_more: true } }), context => {
    incomplete(context); assert.equal(context.pages.length, 1);
  });
  await checkPages('anthropic', () => ({ body: { data: [{ id: 'partial' }], has_more: 'true', last_id: 'invalid' } }), context => {
    incomplete(context); assert.equal(context.pages.length, 1);
  });
  await checkPages('gemini', page => ({ body: page === 1 ? { models: Array(10000).fill({ name: 'models/partial' }), nextPageToken: 'next' }
    : { models: [{ name: 'models/overflow' }] } }), context => {
    incomplete(context); assert.equal(context.pages.length, 2);
  });
  for (const complete of [false, true]) {
    await checkPages('gemini', page => ({ body: { models: [{ name: 'models/page-' + page }],
      nextPageToken: complete && page === 100 ? '' : String(page) } }), context => {
      assert.equal(context.pages.length, 100);
      if (complete) { assert.equal(context.result.ok, true); assert.equal(context.result.added, 100); }
      else incomplete(context);
    });
  }
  console.log('PASS Gemini and Anthropic catalog pagination, escaping, atomic failure and final-page bounds');
  console.log(`Model synchronization: ${passed} checks passed.`);
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert(path.basename(scratch).startsWith('yunqiao-model-sync-') && fs.realpathSync(path.dirname(scratch)) === fs.realpathSync(os.tmpdir()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
