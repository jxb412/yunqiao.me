/** Offline integration regressions. Uses temporary state and mock servers; no real credentials or client files. */
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-gateway-test-'));
const bundle = path.join(scratch, 'core.cjs');
await build({ stdin: { contents: [
  'src/core/store/index.ts', 'src/core/gateway/server.ts', 'src/core/gateway/router.ts',
  'src/core/cloud.ts', 'src/core/plugins/masking.ts', 'src/core/plugins/middleware.ts', 'src/core/protocol/index.ts',
].map((file) => `export * from ${JSON.stringify(path.join(root, file).replaceAll('\\', '/'))};`).join('\n'),
  resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { AuroraStore, GatewayServer, Router, fetchCloudCatalog, validateCloudCatalog, importCloudProviders, applyMiddleware, parseClientRequest,
  encodeAnthropicRequest, createEncoder, buildUpstreamHttp, parseUpstreamJson, buildClientJson } = createRequire(import.meta.url)(bundle);
let checks = 0;
const check = (name, assertion) => { assertion(); checks++; console.log(`PASS ${name}`); };
let requests = [];
let catalogMode = 'valid';
const catalog = { version: 7, updatedAt: '2026-11-15T00:00:00Z', providers: [
  { key: 'mock-catalog', name: 'Test catalog', format: 'openai-chat', baseUrl: 'https://example.com/v1', models: [{ id: 'test-model' }] },
] };
const citedText = { type: 'output_text', text: 'Cited answer', annotations: [
  { type: 'url_citation', url: 'https://source.example', title: 'Source', start_index: 0, end_index: 5 },
], vendor_extension: 'keep' };
const refusal = { type: 'refusal', refusal: 'Unrelated content part' };
const upstream = http.createServer(async (req, res) => {
  if (req.url === '/catalog') {
    res.writeHead(catalogMode === 'offline' ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(catalogMode === 'invalid' ? { ...catalog, providers: [{ ...catalog.providers[0], format: 'execute-js' }] } : catalog));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  requests.push({ body, key: req.headers.authorization });
  if (body.model === 'header-error' || body.model === 'header-stream-error') {
    const message = ['Rejected', req.headers.authorization, String(req.headers.authorization).replace(/^Bearer\s+/i, ''),
      req.headers['x-vendor-secret'], req.headers['x-custom-auth'], String(req.headers['x-custom-auth']).replace(/^Basic\s+/i, ''), req.headers['x-short']].join(' ');
    if (body.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ error: { message } })}\n\n`); }
    else { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message } })); }
    return;
  }
  if (req.headers.authorization === 'Bearer mock-bad-key') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Rejected mock-bad-key' } }));
    return;
  }
  if (req.url === '/v1/responses') {
    const nativeResponse = { id: 'resp-native', status: 'completed', model: body.model,
      output: [{ id: 'ctc-native', type: 'custom_tool_call', call_id: 'call-native', name: 'apply_patch', input: '*** Begin Patch' },
        { id: 'rs-native', type: 'reasoning', encrypted_content: 'opaque-encrypted-state', summary: [] },
        { id: 'msg-native', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Plain answer' }, citedText, refusal] }],
      usage: { input_tokens: 4, output_tokens: 3 } };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { ...nativeResponse, status: 'in_progress', output: [] } })}\n\n`
        + 'event: response.vendor_extension\ndata: {"type":"response.vendor_extension","opaque":"preserve-this"}\n\n'
        + `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: nativeResponse })}\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(nativeResponse));
    }
    return;
  }
  const text = body.messages?.at(-1)?.content || '中文片段🌏';
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`;
    const bytes = Buffer.from(sse);
    const split = Math.max(1, bytes.indexOf(Buffer.from('中')) + 1);
    res.write(bytes.subarray(0, split));
    setTimeout(() => {
      res.write(bytes.subarray(split));
      if (body.model !== 'truncated-model') res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
      res.end();
    }, 5);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'mock', model: body.model, choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3 } }));
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
const store = new AuroraStore(path.join(scratch, 'state'));
store.providers.write([]);
store.saveSettings({ gatewayToken: 'test-gateway-secret', maskSecrets: true, logRequests: true, maxRetries: 3 });
const provider = store.saveProvider({ name: 'Mock', baseUrl: upstreamUrl + '/v1', format: 'openai-chat', enabled: true,
  apiKeys: [{ id: 'bad', label: 'bad', key: 'mock-bad-key', enabled: true, weight: 1 }, { id: 'good', label: 'good', key: 'mock-good-key', enabled: true, weight: 1 }],
  models: [{ id: 'test-model', capabilities: { tools: true } }, { id: 'truncated-model' }] });
const gateway = new GatewayServer({ store, actions: async (action, payload) => {
  if (action === 'state.get') return { settings: store.getSettings(), providers: store.listProviders(), plugins: [{ code: 'secret source' }] };
  if (action === 'cloud.catalog') return { ok: true, ...catalog };
  if (action === 'codex.flags') return { schema: [{ key: 'model_reasoning_effort', label: 'Reasoning effort' }], flags: {} };
  if (action === 'provider.save') return store.saveProvider(payload);
  return null;
} });
const status = await gateway.start('127.0.0.1', 0);
const gatewayUrl = `http://127.0.0.1:${status.port}`;
const call = (endpoint, options = {}) => fetch(gatewayUrl + endpoint, {
  ...options, headers: { authorization: 'Bearer test-gateway-secret', 'content-type': 'application/json', ...options.headers },
});
const post = (endpoint, body, headers = {}) => call(endpoint, { method: 'POST', body: JSON.stringify(body), headers });
const chat = (model = 'test-model', content = '中文片段🌏', stream = false) => ({ model, messages: [{ role: 'user', content }], stream });

try {
  let response = await fetch(gatewayUrl + '/health');
  check('health is public and contains no host configuration', () => assert.equal(response.status, 200));
  for (const endpoint of ['/v1/models', '/api/state', '/claude-desktop/v1/models', '/v1beta/models']) {
    response = await fetch(gatewayUrl + endpoint);
    check(`missing token rejected: ${endpoint}`, () => assert.equal(response.status, 401));
  }
  response = await post('/api/rpc', { action: 'state.get' }, { authorization: '' });
  check('RPC without token rejected', () => assert.equal(response.status, 401));
  response = await post('/api/rpc', { action: 'state.get' }, { origin: 'https://attacker.example' });
  check('foreign browser origin rejected', () => assert.equal(response.status, 403));
  response = await post('/api/rpc', { action: 'state.get' }, { origin: 'capacitor://localhost' });
  const state = await response.json();
  check('Capacitor origin and authenticated RPC work', () => assert.equal(response.status, 200));
  check('RPC never returns keys, gateway token or executable plugin source', () => {
    assert.equal(state.result.settings.gatewayToken, '');
    assert.equal(state.result.providers[0].apiKeys[0].key, '');
    assert.equal(state.result.providers[0].apiKeys[0].hasKey, true);
    assert.equal(state.result.plugins[0].code, '');
  });
  response = await post('/api/rpc', { action: 'cloud.catalog' });
  const publicCatalog = await response.json();
  check('RPC preserves public catalog keys used for UI identity and selection', () => {
    assert.equal(publicCatalog.result.providers[0].key, 'mock-catalog');
    assert.equal(publicCatalog.result.providers[0].hasKey, undefined);
  });
  response = await post('/api/rpc', { action: 'codex.flags' });
  const flagMetadata = await response.json();
  check('RPC preserves non-secret setting schema keys', () => assert.equal(flagMetadata.result.schema[0].key, 'model_reasoning_effort'));
  response = await post('/api/rpc', { action: 'inject.run', payload: {} });
  check('remote code execution action rejected', () => assert.equal(response.status, 403));
  for (const action of ['agent.lifecycle', 'agent.restart']) {
    response = await post('/api/rpc', { action, payload: { agentId: 'claude-desktop' } });
    check(`desktop client lifecycle is not exposed through gateway RPC: ${action}`, () => assert.equal(response.status, 403));
  }
  response = await post('/api/rpc', { action: 'provider.save', payload: { id: provider.id, enabled: true, apiKeys: [] } });
  check('remote toggle cannot overwrite stored keys', () => assert.ok((response.status === 200)));
  assert.ok((await response.json()).error);
  response = await post('/api/rpc', { action: 'provider.toggle', payload: { id: provider.id, enabled: true } });
  check('remote provider toggle preserves credentials', () => assert.equal(store.getProvider(provider.id).apiKeys[1].key, 'mock-good-key'));

  response = await post('/v1/chat/completions', chat());
  const first = await response.json();
  check('401 fails over to another key within the same provider', () => {
    assert.equal(response.status, 200); assert.equal(requests[0].key, 'Bearer mock-bad-key'); assert.equal(requests[1].key, 'Bearer mock-good-key');
  });
  check('chat response contains Chinese without corruption', () => assert.equal(first.choices[0].message.content, '中文片段🌏'));
  const router = new Router(store);
  check('cooling keys are not used again', () => assert.ok(router.resolveModel(`${provider.id}/test-model`).candidates.every((c) => c.key.id !== 'bad')));
  store.saveProvider({ id: provider.id, enabled: false });
  check('explicit disabled provider does not fall back', () => assert.equal(router.resolveModel(`${provider.id}/test-model`).candidates.length, 0));
  store.saveProvider({ id: provider.id, enabled: true });
  check('unknown model is not sent to unrelated configured providers', () => assert.equal(router.resolveModel('unknown-model').candidates.length, 0));

  const colonModel = 'org/model:1';
  const colonProvider = store.saveProvider({ name: 'Gemini colon route', enabled: true, format: 'openai-chat', baseUrl: upstreamUrl + '/v1',
    apiKeys: [{ id: 'colon-key', key: 'mock-colon-key', enabled: true, weight: 1 }], models: [{ id: colonModel }] });
  for (const encoded of [false, true]) {
    for (const stream of [false, true]) {
      const qualified = `${colonProvider.id}/${colonModel}`;
      const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
      response = await post(`/v1beta/models/${encoded ? encodeURIComponent(qualified) : qualified}:${action}`, { contents: [{ role: 'user', parts: [{ text: 'Verify colon model' }] }] });
      const body = await response.text();
      check(`Gemini ${encoded ? 'encoded' : 'native SDK'} ${stream ? 'streaming' : 'JSON'} URL preserves model namespace and colon`, () => {
        assert.equal(response.status, 200, body); assert.equal(requests.at(-1).body.model, colonModel);
        assert.equal(response.headers.get('x-aurora-model'), encodeURIComponent(colonModel)); assert(body.includes('Verify colon model'));
      });
    }
  }

  const headerSecrets = ['mock-custom-bearer-private', 'mock-vendor-header-private', 'bW9jay1jdXN0b20tcHJpdmF0ZTpwYXNzd29yZA=='];
  const headerProvider = store.saveProvider({ name: 'Header authentication', enabled: true, format: 'openai-chat', baseUrl: upstreamUrl + '/v1',
    apiKeys: [{ id: 'header-key', key: 'mock-header-provider-key', enabled: true, weight: 1 }],
    headers: { authorization: `Bearer ${headerSecrets[0]}`, 'x-vendor-secret': headerSecrets[1], 'x-custom-auth': `Basic ${headerSecrets[2]}`, 'x-short': 'abc' },
    models: [{ id: 'header-error' }, { id: 'header-stream-error' }] });
  for (const stream of [false, true]) {
    const model = stream ? 'header-stream-error' : 'header-error';
    response = await post('/v1/chat/completions', chat(`${headerProvider.id}/${model}`, 'test header authentication', stream));
    const wire = await response.text();
    const record = store.recentRequests().find(item => item.providerId === headerProvider.id && item.model === model);
    check(`custom authentication header errors are hidden from ${stream ? 'converted SSE' : 'HTTP'} responses and logs`, () => {
      assert.equal(response.status, stream ? 200 : 400); assert(record?.error);
      for (const output of [wire, record.error, ...(stream ? [] : [gateway.getStatus().lastError])]) {
        for (const secret of headerSecrets) assert.equal(output.includes(secret), false, 'A custom header credential escaped');
        assert(output.includes('[已隐藏密钥]')); assert(output.includes('abc'), 'Short strings should retain the existing redaction policy');
      }
    });
  }

  response = await post('/v1/chat/completions', chat('test-model', '中文片段🌏', true));
  const streamed = await response.text();
  check('SSE preserves UTF-8 split inside a Chinese character', () => assert.ok(streamed.includes('中文片段🌏') && !streamed.includes('�')));
  response = await post('/v1beta/models/test-model:streamGenerateContent', { contents: [{ role: 'user', parts: [{ text: '中文片段🌏' }] }] });
  check('Gemini streaming mode derives from endpoint', () => assert.ok(response.headers.get('content-type').includes('text/event-stream')));
  await response.text();
  response = await post('/v1/chat/completions', chat('truncated-model', '中文', true));
  const truncated = await response.text();
  check('truncated stream returns an error, not a fake completion', () => assert.ok(truncated.includes('upstream_error') && !truncated.includes('[DONE]')));

  const privateText = '-----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----';
  response = await post('/v1/chat/completions', chat('test-model', privateText));
  check('multiline masked content is restored before JSON serialization', () => assert.equal((requests.at(-1).body.messages.at(-1).content).includes('PRIVATE KEY'), false));
  const restored = await response.json();
  check('masked JSON response remains valid', () => assert.equal(restored.choices[0].message.content, privateText));

  store.savePlugin({ id: 'word-guard', name: 'Guard', builtin: true, enabled: true, options: { words: ['do-not-send'], action: 'block' } });
  const before = requests.length;
  response = await post('/v1/chat/completions', chat('test-model', 'do-not-send'));
  check('guard blocks before upstream transmission', () => { assert.equal(response.status, 403); assert.equal(requests.length, before); });
  const loopPlugin = store.savePlugin({ name: 'Loop', enabled: true, code: 'function onRequest(){ while(true){} }' });
  const started = Date.now();
  const middleware = applyMiddleware(store, parseClientRequest('openai-chat', chat()), { agent: 'test', protocol: 'openai-chat', requestId: 't' });
  check('custom plugin infinite loops have a bounded execution time', () => { assert.ok(Date.now() - started < 3000); assert.ok(middleware.notes.some((n) => n.includes('timed out')), JSON.stringify(middleware.notes)); });
  store.savePlugin({ id: loopPlugin.id, enabled: false });
  store.savePlugin({ id: 'word-guard', enabled: false });

  store.saveAgent({ id: 'claude-desktop', connected: true, providerId: provider.id, model: 'test-model' });
  response = await call('/claude-desktop/v1/models');
  check('Claude Desktop model discovery returns Anthropic schema', () => assert.equal(response.status, 200));
  assert.equal((await response.json()).data[0].id, 'claude-sonnet-aurora');
  response = await post('/claude-desktop/v1/messages', { model: 'claude-sonnet-aurora', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] });
  const desktop = await response.json();
  check('Claude Desktop aliases route to selected provider and model', () => { assert.equal(response.status, 200); assert.equal(requests.at(-1).body.model, 'test-model'); assert.equal(desktop.model, 'claude-sonnet-aurora'); });

  const fresh = await fetchCloudCatalog(upstreamUrl + '/catalog', store);
  check('remote catalog validates and caches', () => { assert.equal(fresh.source, 'remote'); assert.equal(fresh.providers.length, 1); });
  catalogMode = 'offline';
  const cached = await fetchCloudCatalog(upstreamUrl + '/catalog', store);
  check('offline catalog uses last known valid data with an explicit warning', () => { assert.equal(cached.source, 'cache'); assert.ok(cached.warning); });
  catalogMode = 'invalid';
  const invalid = await fetchCloudCatalog(upstreamUrl + '/catalog', store);
  check('invalid remote catalog does not replace trusted cache', () => assert.equal(invalid.providers[0].format, 'openai-chat'));
  check('non-HTTP provider addresses are rejected', () => assert.throws(() => validateCloudCatalog({ ...catalog, providers: [{ ...catalog.providers[0], baseUrl: 'file:///secret' }] })));
  store.saveProvider({ name: 'Test catalog', baseUrl: 'https://other.example/v1', apiKeys: [{ id: 'local', key: 'keep-this', label: '', weight: 1, enabled: true }] });
  const imported = importCloudProviders(store, catalog.providers);
  check('same name from another endpoint cannot overwrite local provider', () => assert.equal(imported.added, 1));

  const ir = parseClientRequest('openai-chat', chat());
  ir.messages = [{ role: 'assistant', blocks: [{ type: 'thinking', text: 'unsigned reasoning' }, { type: 'text', text: 'answer' }] }];
  const anthropic = encodeAnthropicRequest(ir, { model: 'claude' });
  check('gateway never forges Anthropic thinking signatures', () => assert.ok(!JSON.stringify(anthropic).includes('signature')));
  const encoder = createEncoder('anthropic', { requestId: 'test', model: 'claude', clientModel: 'claude', upstreamFormat: 'anthropic' });
  encoder.push({ type: 'thinking_delta', index: 0, text: 'reasoning' });
  const signatureEvent = encoder.push({ type: 'thinking_delta', index: 0, text: '', signature: 'authentic-signature' });
  check('native thinking signatures are preserved', () => assert.ok(signatureEvent.includes('authentic-signature')));

  const eventsFrom = (text) => text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  const responsesEncoder = createEncoder('openai-responses', { requestId: 'resp-test', model: 'model', clientModel: 'model' });
  let responseEvents = responsesEncoder.push({ type: 'start', id: 'upstream', model: 'model' });
  responseEvents += responsesEncoder.push({ type: 'start', id: 'duplicate', model: 'model' });
  responseEvents += responsesEncoder.push({ type: 'tool_start', index: 1, id: 'call-123', name: 'read_file' });
  responseEvents += responsesEncoder.push({ type: 'tool_delta', index: 1, json: '{"path":' });
  responseEvents += responsesEncoder.push({ type: 'tool_delta', index: 1, json: '"文件.txt"}' });
  responseEvents += responsesEncoder.end();
  const responseData = eventsFrom(responseEvents);
  check('Responses sends exactly one creation event', () => assert.equal(responseData.filter((item) => item.type === 'response.created').length, 1));
  const completedTool = responseData.find((item) => item.type === 'response.completed').response.output[0];
  check('Responses final tool output preserves call_id/name/arguments', () => {
    assert.equal(completedTool.call_id, 'call-123'); assert.equal(completedTool.name, 'read_file');
    assert.deepEqual(JSON.parse(completedTool.arguments), { path: '文件.txt' }); assert.equal(completedTool.buf, undefined);
  });
  const geminiEncoder = createEncoder('gemini', { requestId: 'gem-test', model: 'model', clientModel: 'model' });
  let geminiEvents = geminiEncoder.push({ type: 'text_delta', index: 0, text: '只出现一次' });
  geminiEvents += geminiEncoder.push({ type: 'tool_start', index: 1, id: 'call-456', name: 'write_file' });
  geminiEvents += geminiEncoder.push({ type: 'tool_delta', index: 1, json: '{"text":"中' });
  geminiEvents += geminiEncoder.push({ type: 'tool_delta', index: 1, json: '文"}' });
  geminiEvents += geminiEncoder.end();
  const geminiData = eventsFrom(geminiEvents);
  check('Gemini stream does not repeat accumulated text at completion', () => assert.equal(geminiData.flatMap((item) => item.candidates[0].content.parts).map((part) => part.text || '').join(''), '只出现一次'));
  check('Gemini stream assembles fragmented tool arguments', () => assert.deepEqual(geminiData.at(-1).candidates[0].content.parts[0].functionCall.args, { text: '中文' }));
  const geminiThinking = parseUpstreamJson('gemini', { candidates: [{ content: { parts: [{ text: 'private reasoning', thought: true }, { text: 'visible answer' }] }, finishReason: 'STOP' }] });
  check('Gemini non-streaming parser distinguishes thoughts from final answer text', () => assert.deepEqual(geminiThinking.blocks, [{ type: 'thinking', text: 'private reasoning' }, { type: 'text', text: 'visible answer' }]));
  check('Gemini thought-only conversions never fabricate final answer text', () => {
    for (const protocol of ['anthropic', 'openai-responses', 'openai-chat', 'gemini']) {
      const context = { requestId: 'gemini-thought-test', model: 'model', clientModel: 'model', upstreamFormat: 'gemini' };
      const onlyThoughts = { ...geminiThinking, blocks: geminiThinking.blocks.filter(block => block.type === 'thinking') };
      const parsed = parseUpstreamJson(protocol, buildClientJson(protocol, onlyThoughts, context));
      assert.equal(parsed.blocks.some(block => block.type === 'text' && block.text.trim()), false, protocol);
      const answered = parseUpstreamJson(protocol, buildClientJson(protocol, geminiThinking, context));
      assert.deepEqual(answered.blocks.filter(block => block.type === 'text'), [{ type: 'text', text: 'visible answer' }], protocol);
    }
  });
  for (const protocol of ['anthropic', 'openai-chat', 'openai-responses', 'gemini']) {
    const errorEncoder = createEncoder(protocol, { requestId: 'error', model: 'model', clientModel: 'model' });
    check(`${protocol} exposes upstream stream errors`, () => assert.ok(errorEncoder.push({ type: 'error', message: 'visible-error' }).includes('visible-error')));
  }
  const requiredTool = parseClientRequest('openai-chat', { ...chat(), tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }], tool_choice: 'required' });
  for (const format of ['openai-responses', 'gemini']) {
    const request = JSON.parse(buildUpstreamHttp(requiredTool, { format, baseUrl: 'https://example.com', apiKey: 'mock', model: 'test' }, 'openai-chat').body);
    check(`${format} retains required tool choice`, () => assert.equal(format === 'gemini' ? request.toolConfig.functionCallingConfig.mode : request.tool_choice, format === 'gemini' ? 'ANY' : 'required'));
  }

  store.saveSettings({ maskSecrets: false });
  store.saveProvider({ id: provider.id, format: 'openai-responses' });
  const nativeInput = { model: 'test-model', input: 'native request', tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }], include: ['reasoning.encrypted_content'] };
  response = await post('/v1/responses', nativeInput);
  const nativeOutput = await response.json();
  check('native Responses preserves custom tool request definitions', () => assert.deepEqual(requests.at(-1).body.tools, nativeInput.tools));
  check('native Responses preserves custom tool output and encrypted reasoning', () => {
    assert.equal(nativeOutput.output[0].input, '*** Begin Patch'); assert.equal(nativeOutput.output[1].encrypted_content, 'opaque-encrypted-state');
  });
  check('native Responses JSON supplies omitted text annotations and preserves citations and other parts', () => {
    assert.deepEqual(nativeOutput.output[2].content, [{ type: 'output_text', text: 'Plain answer', annotations: [] }, citedText, refusal]);
  });
  response = await post('/v1/responses', { ...nativeInput, stream: true });
  const nativeStream = await response.text();
  check('native SSE forwards opaque vendor events without data loss', () => assert.ok(nativeStream.includes('preserve-this') && nativeStream.includes('opaque-encrypted-state')));
  console.log(`\n${checks} gateway/cloud/plugin regressions passed.`);
} finally {
  await gateway.stop();
  await new Promise((resolve) => upstream.close(resolve));
  // Only the absolute temporary directory created by this test is removed.
  if (path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(scratch, { recursive: true, force: true });
}
