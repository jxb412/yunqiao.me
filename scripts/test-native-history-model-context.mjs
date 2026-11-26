/** Opt-in real Codex binary integration: fake OAuth, disposable homes, loopback-only services. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

const workspace = path.resolve(import.meta.dirname, '..');
const candidates = process.env.AURORA_NATIVE_CODEX ? [process.env.AURORA_NATIVE_CODEX] : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'));
const cli = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
assert.ok(cli, 'Set AURORA_NATIVE_CODEX to an installed Codex executable; this optional test never downloads or installs one.');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-coexist-native-')));
const clientHome = path.join(scratch, 'client'), codexHome = path.join(clientHome, '.codex'), work = path.join(scratch, 'work');
for (const dir of [codexHome, work, path.join(clientHome, 'AppData', 'Roaming'), path.join(clientHome, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
const originalClientHome = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = clientHome;
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())));
Object.assign(childEnv, { CODEX_HOME: codexHome, USERPROFILE: clientHome, HOME: clientHome, APPDATA: path.join(clientHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(clientHome, 'AppData', 'Local'), TEMP: scratch, TMP: scratch });
const blocked = [], supplierCalls = [], officialCalls = [];
const denyProxy = http.createServer((req, res) => { blocked.push(String(req.url).split('?')[0]); res.writeHead(403); res.end('External network blocked by isolated test'); });
denyProxy.on('connect', (req, socket) => { socket.on('error',()=>{}); blocked.push(String(req.url)); socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
await new Promise(resolve => denyProxy.listen(0, '127.0.0.1', resolve));
const proxy = `http://127.0.0.1:${denyProxy.address().port}`;
Object.assign(childEnv, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' });
const version = spawnSync(cli, ['--version'], { cwd: work, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 15000 });
assert.equal(version.status, 0, version.stderr); console.log(version.stdout.trim());
let gateway;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const claims = { sub: 'fixture-user', email: 'fixture@example.test', exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_user_id: 'fixture-user', chatgpt_plan_type: 'pro' } };
const fakeToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.fixture-signature`;
const authFile = path.join(codexHome, 'auth.json');
const authText = JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: fakeToken, access_token: fakeToken, refresh_token: 'fixture-refresh-not-valid', account_id: 'fixture-account' }, last_refresh: new Date().toISOString() });
fs.writeFileSync(authFile, authText);
const nativeModel = { slug: 'gpt-fixture', display_name: 'Fixture Model', description: 'Isolated fixture model', base_instructions: 'Return the fixture response. Do not call tools.', default_reasoning_level: 'none', supported_reasoning_levels: [{ effort: 'none', description: 'Fixture' }], shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1, additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null, truncation_policy: { mode: 'tokens', limit: 10000 }, context_window: 65536, max_context_window: 65536, effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ['text'], supports_search_tool: false, supports_parallel_tool_calls: false, supports_reasoning_summaries: false, prefer_websockets: false, available_in_plans: ['pro'] };
fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({ fetched_at: new Date().toISOString(), client_version: version.stdout.trim().replace(/^codex-cli /, ''), models: [nativeModel] }));
const sendResponse = (res, model, answer) => {
  const response = { id: 'resp_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'in_progress', output: [] };
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: answer, annotations: [] }] };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({ type: 'response.created', response });
  event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  event({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  event({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer });
  event({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: answer });
  event({ type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  event({ type: 'response.output_item.done', output_index: 0, item });
  event({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 } } } });
  res.end();
};
const mock = (calls, answer) => http.createServer(async (req, res) => { try { const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); calls.push({ path: req.url, headers: req.headers, body }); sendResponse(res, body.model, answer); } catch { res.writeHead(400); res.end(); } });
const supplierMock = mock(supplierCalls, 'RELAY_NATIVE_OK'), officialMock = mock(officialCalls, 'OFFICIAL_NATIVE_OK');
await Promise.all([new Promise(resolve => supplierMock.listen(0, '127.0.0.1', resolve)), new Promise(resolve => officialMock.listen(0, '127.0.0.1', resolve))]);

let client;
function startApp() {
  const child = spawn(cli, ['app-server'], { cwd: work, env: childEnv, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  let next=1, buffer='', stderr=''; const pending=new Map(), events=[];
  child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-50000));
  child.stdout.on('data',chunk=>{ buffer+=chunk; let i; while((i=buffer.indexOf('\n'))>=0) { const line=buffer.slice(0,i);buffer=buffer.slice(i+1); try { const msg=JSON.parse(line);if(msg.id!==undefined&&pending.has(msg.id)){const item=pending.get(msg.id);pending.delete(msg.id);clearTimeout(item.timer);msg.error?item.reject(new Error(JSON.stringify(msg.error))):item.resolve(msg.result);}else events.push(msg); }catch{} }});
  return { child,events,stderr:()=>stderr,rpc(method,params){return new Promise((resolve,reject)=>{const id=next++, timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout: '+stderr.slice(-2000)))},30000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});}, notify(method,params){child.stdin.write(JSON.stringify({method,...(params?{params}:{})})+'\n');}, async stop(){child.stdin.end();await new Promise(resolve=>{const t=setTimeout(()=>child.kill(),4000);child.once('close',()=>{clearTimeout(t);resolve();});});}};
}
async function initialized(){client=startApp();await client.rpc('initialize',{clientInfo:{name:'yunqiao-resume-fixture',version:'0.0.0'},capabilities:{experimentalApi:true}});client.notify('initialized');return client;}
async function completedTurn(id,text){const start=await client.rpc('turn/start',{threadId:id,input:[{type:'text',text,textElements:[]}]});const deadline=Date.now()+30000;while(Date.now()<deadline){const found=client.events.find(x=>x.method==='turn/completed'&&x.params?.threadId===id&&x.params?.turn?.id===start.turn.id);if(found)return found.params.turn;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('turn complete timeout '+client.stderr());}
function allLogs(dir){if(!fs.existsSync(dir))return[];return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?allLogs(path.join(dir,e.name)):e.name.endsWith('.jsonl')?[path.join(dir,e.name)]:[]);}

const mode = process.argv[2] || 'api';
assert(['api', 'deferred-api'].includes(mode), 'Usage: node scripts/test-native-history-model-context.mjs [api|deferred-api]');
const deferred=mode.startsWith('deferred'), coexist=mode.includes('coexist'), official=mode==='coexist-official';
const sourceNames=['src/core/actions.ts','src/core/agentHistory.ts','src/core/historyRepair.ts','src/core/historyRepairIO.ts','src/core/agents/adapters.ts','src/core/agents/historyProviders.ts','src/core/gateway/server.ts','src/core/gateway/router.ts','src/core/gateway/coexist.ts','src/core/gateway/historyRoute.ts','src/core/agents/historyModelCoverage.ts','src/core/agents/modelCatalog.ts'];
const sourceFingerprints=Object.fromEntries(sourceNames.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(workspace,file))).digest('hex')]));
const report={mode,passed:false,applicationVersion:JSON.parse(fs.readFileSync(path.join(workspace,'package.json'),'utf8')).version,nativeVersion:version.stdout.trim(),desktopResumeAcceptance:'native-persisted-resume-fixed-route',sourceFingerprints};
const output=process.env.AURORA_NATIVE_REPORT || path.join(workspace, `tmp/native-history-model-context-${mode}.json`);
fs.mkdirSync(path.dirname(output), { recursive: true });
function nativeRows(id) {
 const rows=[];
 for(const entry of fs.readdirSync(codexHome)) {
  if(!/^state_\d+\.sqlite$/.test(entry))continue;
  const file=path.join(codexHome,entry),db=new DatabaseSync(file,{readOnly:true});
  try {for(const row of db.prepare('SELECT id,model,model_provider,rollout_path FROM threads WHERE id=?').all(id))rows.push({database:file,...row});}finally{db.close();}
 }
 return rows;
}
try {
 const bundle=path.join(scratch,'core.cjs');
 await build({stdin:{contents:['./src/core/actions.ts','./src/core/agents/adapters.ts','./src/core/agents/historyProviders.ts','./src/core/store/index.ts','./src/core/gateway/server.ts','./src/core/gateway/coexist.ts','./src/core/gateway/upstream.ts','./src/core/agents/modelCatalog.ts','./src/core/agents/historyModelCoverage.ts'].map(file=>`export * from '${file}';`).join('\n'),resolveDir:workspace,loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'silent'});
 const m=createRequire(import.meta.url)(bundle),store=new m.AuroraStore(path.join(scratch,'data'));
 store.saveSettings({gatewayToken:'fixture-gateway-secret',autoTrimContext:false,maskSecrets:false,maxRetries:0});
 const provider=store.saveProvider({name:'Selected supplier',format:'openai-responses',baseUrl:`http://127.0.0.1:${supplierMock.address().port}/v1`,enabled:true,models:[{id:'gpt-fixture',contextWindow:64000}],apiKeys:[{id:'key',label:'fixture',key:'fixture-provider-secret',enabled:true,weight:1}]});
 gateway=new m.GatewayServer({store,officialTransport:(url,options)=>{assert(['https://chatgpt.com/backend-api/codex/responses','https://chatgpt.com/backend-api/codex/responses/compact'].includes(url));return m.openUpstream(`http://127.0.0.1:${officialMock.address().port}${new URL(url).pathname}`,options);}});
 await gateway.start('127.0.0.1',0);const port=gateway.getStatus().port;store.saveSettings({gatewayPort:port});
 const catalog=path.join(store.dir,'codex-model-catalog.json'),config=path.join(codexHome,'config.toml');
 fs.writeFileSync(catalog,JSON.stringify({models:[nativeModel,{...nativeModel,slug:'retired-model',display_name:'Retired model'}]}));
 fs.writeFileSync(config,stringifyToml({cli_auth_credentials_store:'file',model:'retired-model',model_provider:'retired-provider',model_catalog_json:catalog,approval_policy:'never',sandbox_mode:'read-only',model_providers:{'retired-provider':{name:'Retired',base_url:`http://127.0.0.1:${supplierMock.address().port}/v1`,wire_api:'responses',requires_openai_auth:false,experimental_bearer_token:'fixture-provider-secret'}}}));
 await initialized();
 const started=await client.rpc('thread/start',{cwd:work,approvalPolicy:'never',sandbox:'read-only'}),id=started.thread.id;
 const original=await completedTurn(id,'Return fixture answer without tools');assert.equal(original.status,'completed');
 assert.equal(started.model,'retired-model');assert.equal(started.modelProvider,'retired-provider');
 assert(supplierCalls.length&&supplierCalls.every(call=>call.body.model==='retired-model'));
 if(!deferred){await client.stop();client=undefined;}
 const beforeRows=nativeRows(id);assert.equal(beforeRows.length,1);assert.equal(beforeRows[0].model,'retired-model');assert.equal(beforeRows[0].model_provider,'retired-provider');
 const rollout=beforeRows[0].rollout_path,originalLog=fs.readFileSync(rollout);
 const originalParsed=parseToml(fs.readFileSync(config,'utf8'));delete originalParsed.model_providers['retired-provider'];fs.writeFileSync(config,stringifyToml(originalParsed));
 // The selected original provider has already vanished. The app must recover it from real persisted history.
 fs.writeFileSync(path.join(codexHome,'models_cache.json'),JSON.stringify({fetched_at:new Date().toISOString(),client_version:version.stdout.trim().replace(/^codex-cli /,''),models:[{...nativeModel,slug:'official/gpt-fixture'}]}));
 const deps={store,dataDir:store.dir,gatewayStatus:()=>gateway.getStatus(),gatewayUrl:()=>`http://127.0.0.1:${port}`,historyContext:{home:codexHome,sqliteHome:codexHome,blockingProcesses:async()=>deferred?[`isolated-native-app-server-${client.child.pid}`]:[]}};
 const payload={agentId:'codex-cli',providerId:official?'official':provider.id,model:'gpt-fixture',mode:'gateway',authMode:coexist?'coexist':'api'};
 const candidate=m.buildGatewayModelCatalog(provider);
 assert(candidate?.models.some(model=>model.slug===`${provider.id}/gpt-fixture`), 'Fixture must have complete exact native metadata; otherwise this would only test missing-template fallback');
 const coverage=m.readHistoryModelCoverage(fs.readFileSync(config,'utf8'),codexHome,codexHome,candidate,`${provider.id}/gpt-fixture`);
 assert.equal(coverage.safe,false,'Historical retired-model must reject clearing its root context');
 report.completeTemplateAvailable=true;report.coverage=coverage;
 const preview=await m.runAction(deps,'agent.preview',payload);assert(preview.ok,JSON.stringify(preview));
 const connected=await m.runAction(deps,'agent.connect',{...payload,revision:preview.revision});assert(connected.ok,JSON.stringify(connected));
 const appliedText=fs.readFileSync(config,'utf8'),applied=parseToml(appliedText),target=m.getManagedHistoryTarget(appliedText);assert(target);
 assert.equal(applied.model_provider,coexist?'openai':'yunqiao');
 assert.equal(applied.model_context_window, 64000, 'Unknown history models must retain the selected upstream window');
 assert.equal(applied.model_auto_compact_token_limit, 57600, 'Fallback keeps the selected upstream 90% trigger');
 assert.equal(applied.model_catalog_json, undefined, 'Incomplete history coverage must not install a partial native catalog');
 assert.equal(applied.model,`${official?'official':provider.id}/gpt-fixture`);
 assert(applied.model_providers['retired-provider']);
 const afterRows=nativeRows(id);assert.equal(afterRows.length,1);assert.equal(afterRows[0].model,'retired-model');
 if(deferred){
  assert.equal(connected.history.status,'deferred');assert.equal(connected.history.backedUp,0);assert.equal(afterRows[0].model_provider,'retired-provider');assert.deepEqual(afterRows,beforeRows);assert(fs.readFileSync(rollout).equals(originalLog));
  await client.stop();client=undefined;
 } else {
  assert.equal(connected.history.status,'completed',JSON.stringify(connected.history));assert.equal(afterRows[0].model_provider,target);assert(connected.history.repaired>=1);assert(connected.history.backedUp>=1);assert(connected.history.indexBackedUp>=1);
  const manifest=JSON.parse(fs.readFileSync(path.join(connected.history.backupPath,'manifest.json'),'utf8'));assert.equal(manifest.status,'complete');assert.equal(manifest.targetProvider,target);
  const raw=manifest.files.find(file=>fs.realpathSync.native(file.path)===fs.realpathSync.native(rollout));assert(raw&&fs.readFileSync(raw.original).equals(originalLog));
  const backup=manifest.databases.find(database=>fs.realpathSync.native(database.path)===fs.realpathSync.native(beforeRows[0].database));assert(backup);
  const db=new DatabaseSync(backup.backup,{readOnly:true});try{const row=db.prepare('SELECT model,model_provider FROM threads WHERE id=?').get(id);assert.equal(row.model,'retired-model');assert.equal(row.model_provider,'retired-provider');}finally{db.close();}
 }
 assert.equal(fs.readFileSync(authFile,'utf8'),authText);
 supplierCalls.length=0;officialCalls.length=0;
 await initialized();
 if(coexist){const menu=await client.rpc('model/list',{});const serialized=JSON.stringify(menu);assert(serialized.includes('official/gpt-fixture'),serialized);assert(serialized.includes(`${provider.id}/gpt-fixture`),serialized);report.nativeMenuPreserved=true;}
 const resumed=await client.rpc('thread/resume',{threadId:id});
 assert.equal(resumed.model,'retired-model');assert.equal(resumed.modelProvider,deferred?'retired-provider':target);
 const turn=await completedTurn(id,'Continue the stored conversation without tools');assert.equal(turn.status,'completed',JSON.stringify(turn));
 const sent=official?officialCalls:supplierCalls;assert(sent.length>0);assert.equal((official?supplierCalls:officialCalls).length,0);
 assert(sent.every(call=>call.body.model==='gpt-fixture'));
 if(!official)assert(sent.every(call=>call.headers.authorization==='Bearer fixture-provider-secret'&&!call.headers['chatgpt-account-id']&&!JSON.stringify(call).includes(fakeToken)&&!JSON.stringify(call).includes('fixture-refresh-not-valid')));
 else assert(sent.every(call=>call.headers.authorization===`Bearer ${fakeToken}`&&call.headers['chatgpt-account-id']==='fixture-account'));
 assert.equal(fs.readFileSync(authFile,'utf8'),authText);
 const usageEvents=client.events.filter(event=>event.method==='thread/tokenUsage/updated');
 const effectiveWindow=usageEvents.at(-1)?.params?.tokenUsage?.modelContextWindow;
 assert.equal(effectiveWindow, 60800, 'Native history resume must use the selected 64000 window with its 95% effective budget');
 Object.assign(report,{selectedContextWindow:64000,autoCompactTokenLimit:57600,effectiveWindow,passed:true,threadId:id,historyStatus:connected.history.status,automaticHistoryProvider:target,persistedProvider:afterRows[0].model_provider,persistedModel:afterRows[0].model,resumedProvider:resumed.modelProvider,resumedModel:resumed.model,turnStatus:turn.status,upstreamModels:sent.map(call=>call.body.model),originalHistoryBackedUp:!deferred,historyPreservedWhileDeferred:deferred,officialAuthPreserved:true,officialCredentialsNotForwardedToThirdParty:official?null:true,thirdPartyCalls:supplierCalls.length,officialCalls:officialCalls.length,officialTokenSentOnlyToOfficialTransport:official,rootModelProvider:applied.model_provider,primaryModel:applied.model,externalConnectionsBlocked:blocked.length,isolatedFixture:scratch});
 for(const [file,digest] of Object.entries(sourceFingerprints))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(workspace,file))).digest('hex'),digest,'Source changed during native probe');
 console.log(JSON.stringify(report));
} catch(error) {report.error=String(error.stack||error);throw error;}
finally {
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 if(client)await client.stop();if(gateway)await gateway.stop();
 for(const server of [supplierMock,officialMock,denyProxy]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 if(originalClientHome===undefined)delete process.env.AURORA_CLIENT_HOME;else process.env.AURORA_CLIENT_HOME=originalClientHome;
 console.log('Isolated native fixture: '+scratch);
}
