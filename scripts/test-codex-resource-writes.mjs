import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { parse as parseToml } from 'smol-toml';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'yunqiao-codex-write-')),previous=process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME=root;
const home=path.join(root,'.codex'),config=path.join(home,'config.toml'),prompt=path.join(home,'AGENTS.md');fs.mkdirSync(path.join(home,'skills','fixture'),{recursive:true});fs.writeFileSync(path.join(home,'skills','fixture','SKILL.md'),'# Fixture');
await build({entryPoints:['src/core/codex.ts'],outfile:path.join(root,'api.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const api=createRequire(import.meta.url)(path.join(root,'api.cjs'));
const baseline='model = "fixture"\n# provider credentials must survive\n[model_providers.fixture]\nexperimental_bearer_token = "fixture-secret-keep"\n[mcp_servers.fixture]\ncommand = "fixture"\n';
let passed=0;const check=(label,fn)=>{fn();passed++;console.log(`PASS ${label}`);};
const read=file=>fs.readFileSync(file,'utf8'),write=(file,text)=>fs.writeFileSync(file,text);
const operations=[['Codex setting',config,()=>api.writeCodexFlag('model_context_window','32000')],['MCP toggle',config,()=>api.toggleCodexAsset('mcp:fixture',false)],['skill toggle',config,()=>api.toggleCodexAsset('skill:fixture',false)],['global prompt',prompt,()=>api.writeAgentsMd('new instructions')]];
try{
  for(const[label,file,run]of operations){
    check(`${label} refuses concurrent edits made while saving its recovery record`,()=>{
      write(config,baseline);write(prompt,'original instructions');const original=read(file),external=original+'\n# EXTERNAL_CHANGE\n',rename=fs.renameSync;let injected=false;
      fs.renameSync=(from,to)=>{const result=rename(from,to);if(!injected&&path.dirname(to)===path.join(home,'.aurora-backups')&&String(to).endsWith('.json')){injected=true;write(file,external);}return result;};
      let result;try{result=run();}finally{fs.renameSync=rename;}assert(injected);assert.equal(result.ok,false);assert.equal(read(file),external);assert.match(result.message,/外部修改|其他程序修改/);assert.ok(!result.message.includes('fixture-secret-keep'));
    });
    check(`${label} retains original bytes when its final file replacement fails`,()=>{
      write(config,baseline);write(prompt,'original instructions');const original=read(file),rename=fs.renameSync;
      fs.renameSync=(from,to)=>{if(to===file)throw Error('fixture secret in filesystem error');return rename(from,to);};let result;try{result=run();}finally{fs.renameSync=rename;}assert.equal(result.ok,false);assert.equal(read(file),original);assert.ok(!result.message.includes('fixture secret'));
    });
  }
  check('Skill toggle rejects malformed TOML instead of appending another configuration block',()=>{const invalid=baseline+'secret = "unterminated-secret';write(config,invalid);const result=api.toggleCodexAsset('skill:fixture',false);assert.equal(result.ok,false);assert.equal(read(config),invalid);assert.ok(!result.message.includes('unterminated-secret'));});
  check('MCP inventory uses direct server keys and only changes the selected boolean',()=>{
    const text=[
      '\uFEFFnote = """', '[mcp_servers.phantom]', 'enabled = false', '"""',
      '["mcp_servers"."company.tools"] # selected', 'command = "demo"', '"enabled"   = false  # preserve spacing',
      '[mcp_servers."company.tools".env]', 'COLOR = "green"', '[mcp_servers.other]', 'command = "other"',
    ].join('\r\n');
    write(config,text);
    const servers=api.listCodexAssets().filter(asset=>asset.kind==='mcp');
    assert.deepEqual(servers.map(asset=>asset.id),['mcp:company.tools','mcp:other']);
    assert.equal(servers[0].enabled,false);assert.equal(servers[0].mutable,true);
    const result=api.toggleCodexAsset('mcp:company.tools',true);assert.equal(result.ok,true,result.message);
    assert.equal(read(config),text.replace('false  # preserve','true  # preserve'));
    assert.equal(api.listCodexAssets().find(asset=>asset.id==='mcp:company.tools').enabled,true);
  });
  check('Skill toggle preserves multiline content, quoted keys, comments, CRLF and unrelated array entries',()=>{
    const file=path.join(home,'skills','fixture','SKILL.md'),text=[
      '\uFEFFexample = """','[[skills.config]]','enabled = false','"""',
      '[["skills"."config"]] # selected', "'path' = "+JSON.stringify(file), "'enabled' = false   # keep",
      '[[skills.config]] # unrelated', 'path = "other/SKILL.md"', 'enabled = false', '',
    ].join('\r\n');
    write(config,text);
    assert.equal(api.listCodexAssets().find(asset=>asset.id==='skill:fixture').enabled,false);
    const result=api.toggleCodexAsset('skill:fixture',true);assert.equal(result.ok,true,result.message);
    assert.equal(read(config),text.replace('false   # keep','true   # keep'));
    assert.equal(api.listCodexAssets().find(asset=>asset.id==='skill:fixture').enabled,true);
  });
  check('Inline TOML resource settings are listed with their actual state and are read-only',()=>{
    const file=path.join(home,'skills','fixture','SKILL.md'),text='mcp_servers = { local = { enabled = false } }\nskills.config = [{ path = '+JSON.stringify(file)+', enabled = false }]\n';
    write(config,text);
    const assets=api.listCodexAssets();
    for(const id of ['mcp:local','skill:fixture']){
      const asset=assets.find(entry=>entry.id===id);assert.equal(asset.enabled,false);assert.equal(asset.mutable,false);
      assert.equal(api.toggleCodexAsset(id,true).ok,false);assert.equal(read(config),text);
    }
  });
  check('Missing flags are added once to the correct explicit table, including a header at EOF',()=>{
    const file=path.join(home,'skills','fixture','SKILL.md'),text='[[skills.config]]\r\npath = '+JSON.stringify(file)+'\r\n[mcp_servers.demo]';
    write(config,text);
    let result=api.toggleCodexAsset('skill:fixture',false);assert.equal(result.ok,true,result.message);
    const skillText=text.replace('[[skills.config]]\r\n','[[skills.config]]\r\nenabled = false\r\n');assert.equal(read(config),skillText);
    result=api.toggleCodexAsset('mcp:demo',false);assert.equal(result.ok,true,result.message);
    assert.equal(read(config),skillText+'\r\nenabled = false');
  });
  check('Config and prompt mutators refuse oversized existing files',()=>{for(const file of [config,prompt]){write(file,'');fs.truncateSync(file,4*1024*1024+1);}assert.equal(api.writeCodexFlag('model_context_window','1000').ok,false);assert.equal(api.toggleCodexAsset('skill:fixture',false).ok,false);assert.equal(api.writeAgentsMd('small replacement').ok,false);assert.equal(fs.statSync(config).size,4*1024*1024+1);assert.equal(fs.statSync(prompt).size,4*1024*1024+1);});
  check('Successful prompt and flag writes expose recoverable original files in their manifests',()=>{write(config,baseline);write(prompt,'original instructions');assert.equal(api.writeCodexFlag('model_context_window','32000').ok,true);const saved=api.writeAgentsMd('new instructions');assert.equal(saved.ok,true);const manifest=JSON.parse(read(saved.backup));assert.equal(read(manifest.files[0].backup),'original instructions');assert.ok(read(config).includes('fixture-secret-keep'));assert.ok(read(config).includes('model_context_window = 32000'));});
  check('Context and its 90 percent compact threshold replace together once with one recoverable original',()=>{
    const original='model_context_window = 500000\nmodel_auto_compact_token_limit = 499999\n'+baseline+'\n[profiles.keep]\nmodel_context_window = 8000\nmodel_auto_compact_token_limit = 7000\n';
    write(config,original);const rename=fs.renameSync;let replacements=0,manifestPath;
    fs.renameSync=(from,to)=>{
      if(to===config){replacements++;assert.equal(read(config),original);const pending=parseToml(read(from));assert.equal(pending.model_context_window,272000);assert.equal(pending.model_auto_compact_token_limit,244800);}
      const result=rename(from,to);if(path.dirname(to)===path.join(home,'.aurora-backups')&&path.basename(to).startsWith('codex-setting-')&&String(to).endsWith('.json'))manifestPath=to;return result;
    };
    let result;try{result=api.writeCodexFlag('model_context_window','272000');}finally{fs.renameSync=rename;}
    assert.equal(result.ok,true,result.message);assert.equal(replacements,1);assert(manifestPath);
    const saved=parseToml(read(config));assert.equal(saved.model_context_window,272000);assert.equal(saved.model_auto_compact_token_limit,244800);assert.deepEqual({...saved.profiles.keep},{model_context_window:8000,model_auto_compact_token_limit:7000});assert.equal(saved.model_providers.fixture.experimental_bearer_token,'fixture-secret-keep');
    const manifest=JSON.parse(read(manifestPath));assert.equal(manifest.files.length,1);assert.equal(manifest.files[0].path,config);assert.equal(read(manifest.files[0].backup),original);
  });
  check('A compact threshold stays manually editable until another context save reapplies 90 percent',()=>{
    write(config,'model_context_window = 1000\nmodel_auto_compact_token_limit = 900\n'+baseline);
    const manual=api.writeCodexFlag('model_auto_compact_token_limit','777');assert.equal(manual.ok,true,manual.message);
    let saved=parseToml(read(config));assert.equal(saved.model_context_window,1000);assert.equal(saved.model_auto_compact_token_limit,777);
    const linked=api.writeCodexFlag('model_context_window','101');assert.equal(linked.ok,true,linked.message);
    saved=parseToml(read(config));assert.equal(saved.model_context_window,101);assert.equal(saved.model_auto_compact_token_limit,90);
    assert.equal(api.writeCodexFlag('model_auto_compact_token_limit','').ok,true);saved=parseToml(read(config));assert.equal(saved.model_context_window,101);assert.equal(saved.model_auto_compact_token_limit,undefined);
  });
  check('Clearing context removes both root overrides in one replacement and leaves profile fields alone',()=>{
    const original='model_context_window = 1000\nmodel_auto_compact_token_limit = 777\n'+baseline+'\n[profiles.keep]\nmodel_context_window = 8000\nmodel_auto_compact_token_limit = 7000\n';
    write(config,original);const rename=fs.renameSync;let replacements=0;
    fs.renameSync=(from,to)=>{if(to===config){replacements++;assert.equal(read(config),original);const pending=parseToml(read(from));assert.equal(pending.model_context_window,undefined);assert.equal(pending.model_auto_compact_token_limit,undefined);}return rename(from,to);};
    let result;try{result=api.writeCodexFlag('model_context_window','  ');}finally{fs.renameSync=rename;}
    assert.equal(result.ok,true,result.message);assert.equal(replacements,1);const saved=parseToml(read(config));assert.equal(saved.model_context_window,undefined);assert.equal(saved.model_auto_compact_token_limit,undefined);assert.deepEqual({...saved.profiles.keep},{model_context_window:8000,model_auto_compact_token_limit:7000});
  });
  check('Invalid context values and invalid TOML cannot partially update a compact threshold',()=>{
    const original='model_context_window = 1000\nmodel_auto_compact_token_limit = 777\n'+baseline;
    for(const value of ['0','-1','1.5','NaN','Infinity','9007199254740992']){write(config,original);assert.equal(api.writeCodexFlag('model_context_window',value).ok,false,value);assert.equal(read(config),original);}
    const invalid=original+'\n[broken\n';write(config,invalid);assert.equal(api.writeCodexFlag('model_context_window','272000').ok,false);assert.equal(read(config),invalid);
  });
  console.log(`Codex resource writes: ${passed} checks passed`);
}finally{
  if(previous===undefined)delete process.env.AURORA_CLIENT_HOME;else process.env.AURORA_CLIENT_HOME=previous;
  if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('yunqiao-codex-write-'))fs.rmSync(root,{recursive:true,force:true});
}
