// Copyright 2026 Silkweave
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {spawn} from 'node:child_process';
import {openSync, writeFileSync, mkdirSync, readFileSync, mkdtempSync} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';

// Usage: node check-agent-tabs.mjs <binary> [patched|baseline] [evidence-dir]
// Optional SHUTTLE_UA_KEEPER points to the installation's identity-keeper script.
const [binary, mode = 'patched', evidenceDir] = process.argv.slice(2);
if (!binary) throw Error('A disposable browser binary is required');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../test-data/agent-tabs');
const dir = evidenceDir || mkdtempSync(path.join(os.tmpdir(), 'shuttle-agent-tabs-'));
console.log('Evidence directory:', dir);
mkdirSync(dir, {recursive: true});
const port = mode === 'baseline' ? 19450 : 19451;
// Refuse a used port before launching or connecting to any browser.
const reservation = net.createServer();
await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(port,'127.0.0.1',resolve);});
await new Promise(resolve=>reservation.close(resolve));
const ext = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';
const checks = [], requests = [], sockets = [];
let browser, keeper, control, lane;
setTimeout(() => {browser?.kill('SIGTERM');keeper?.kill('SIGTERM');process.exit(1);},120000).unref();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function check(name, ok, detail) {
  checks.push({name, ok, detail});
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}: ${JSON.stringify(detail ?? '')}`);
}
async function until(fn, label) {
  for (let i = 0; i < 100; ++i) {
    try { const value = await fn(); if (value) return value; } catch {}
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}
async function connect(url) {
  const ws = new WebSocket(url), pending = new Map();
  sockets.push(ws);
  let id = 0;
  ws.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) {pending.delete(m.id); clearTimeout(p.t); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);}};
  await new Promise((resolve, reject) => {ws.onopen = resolve; ws.onerror = reject;});
  return {send(method, params = {}, sessionId) {return new Promise((resolve, reject) => {const i = ++id; const t = setTimeout(() => {pending.delete(i);reject(Error(`timeout ${method}`));}, 15000);pending.set(i,{resolve,reject,t});ws.send(JSON.stringify({id:i,method,params,...(sessionId ? {sessionId} : {})}));});}, close() {ws.close();}};
}
async function tool(name, args = {}, allowError = false) {
  const body = await (await fetch(`http://127.0.0.1:${port}/mcp`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json();
  if (body.error || body.result?.isError) {if (allowError) return body; throw Error(JSON.stringify(body));}
  return body.result.structuredContent;
}
async function attach(targetId, client = control) {return (await client.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;}
async function evaluate(sid, expression, client = control) {
  const r = await client.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true},sid);
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}
const site = http.createServer((req,res) => {
  requests.push({url:req.url, cookie:req.headers.cookie ?? '', brands:req.headers['sec-ch-ua'] ?? '', ua:req.headers['user-agent']});
  res.setHeader('content-type','text/html');
  if (req.url.startsWith('/slow')) {
    setTimeout(() => res.end('<title>Slow destination</title>'), 1200);return;
  }
  const child = req.url.startsWith('/child');
  res.end(`<script>window.atStart={main:!!window.syntheticMain,isolated:document.documentElement.getAttribute('data-synthetic-isolated')};${child ? "parent.postMessage({child:atStart,href:location.href},'*')" : "window.childResults=[];addEventListener('message',e=>{if(e.data.child)childResults.push(e.data)});"}</script><title>Local probe</title>${child ? '' : `<iframe src="/child-same"></iframe><iframe src="http://localhost:${site.address().port}/child-cross"></iframe>`}`);
});
await new Promise(r => site.listen(0,'0.0.0.0',r));
const url = p => `http://127.0.0.1:${site.address().port}${p}`;
try {
  const log = openSync(path.join(dir,'browser.log'),'w');
  browser = spawn(binary,['--headless',`--user-data-dir=${dir}/profile`,`--remote-debugging-port=${port}`,'--no-first-run','--no-default-browser-check','--disable-component-update',`--load-extension=${root}/synthetic-extension`,`--disable-extensions-except=${root}/synthetic-extension`,'about:blank'],{stdio:['ignore',log,log],env:process.env});
  const info = await until(async () => {if(browser.exitCode !== null)throw Error('browser died');return (await fetch(`http://127.0.0.1:${port}/json/version`)).json();},'browser');
  control = await connect(info.webSocketDebuggerUrl);
  const kl = openSync(path.join(dir,'keeper.log'),'w');
  if (process.env.SHUTTLE_UA_KEEPER) {
    keeper = spawn('python3',[process.env.SHUTTLE_UA_KEEPER,String(port),process.env.SHUTTLE_UA_VERSION || '158.0.8127.45'],{stdio:['ignore',kl,kl]});
    await until(() => readFileSync(path.join(dir,'keeper.log'),'utf8').includes('keeper attached'),'identity keeper');
  }
  const extensionPage = (await control.send('Target.createTarget',{url:`chrome-extension://${ext}/probe.html`})).targetId;
  const es = await attach(extensionPage);
  await until(() => evaluate(es,'typeof chrome.tabs?.create === "function"'),'extension');
  await tool('create-agent',{id:'probe-agent'});
  const session = await tool('open-session',{agent:'probe-agent',idleMinutes:0});
  lane = await connect(session.cdpEndpoint);
  const t1 = await tool('allocate-tab',{sessionId:session.sessionId,url:url('/parent-a')});
  const t2 = await tool('allocate-tab',{sessionId:session.sessionId,url:url('/parent-b')});
  const s1 = await attach(t1.targetId,lane);
  await until(() => evaluate(s1,'childResults.length === 2',lane),'frames');
  const initial = await evaluate(s1,'({atStart,childResults})',lane);
  check('initial injection in agent',mode === 'baseline' ? initial.atStart.main : !initial.atStart.main && !initial.atStart.isolated,initial);
  if(mode !== 'baseline') {
    check('same-site and cross-site child frames blocked',initial.childResults.length === 2 && initial.childResults.every(x=>!x.child.main&&!x.child.isolated),initial.childResults);
    const deniedInitial=await evaluate(es,`(async()=>chrome.scripting.executeScript({target:{tabId:(await chrome.tabs.query({})).find(t=>t.url===${JSON.stringify(url('/parent-a'))}).id,allFrames:true},world:'MAIN',func:()=>{window.deniedInitial=true;return true}}).then(r=>({r}),e=>({error:e.message})))()`);
    check('default-off programmatic injection blocked',!await evaluate(s1,'!!window.deniedInitial',lane),deniedInitial);
    const blank=await evaluate(s1,`new Promise(resolve=>{const f=document.createElement('iframe');f.srcdoc='<script>parent.postMessage({blankPolicy:!!window.syntheticMain},"*")<\/script>';addEventListener('message',function listener(e){if('blankPolicy' in e.data){removeEventListener('message',listener);f.remove();resolve(e.data.blankPolicy)} });document.body.append(f);})`,lane);
    check('srcdoc descendant blocked',blank===false);
    check('1Password default off in API',(await tool('list-agents')).agents.find(x=>x.id==='probe-agent').extensions[ext]===false);
  }
  const tabInfo = await evaluate(es,`chrome.tabs.query({}).then(t=>t.filter(x=>x.url?.includes('/parent-'))) `);
  console.log('agent chrome.tabs metadata',JSON.stringify(tabInfo.map(t=>({id:t.id,groupId:t.groupId,index:t.index,windowId:t.windowId}))));
  const first = tabInfo.find(t=>t.url===url('/parent-a'));
  // Open in the interior of the agent's group while the first request is pending.
  const seed = await evaluate(es,`chrome.tabs.create(${JSON.stringify({url:url('/userseed'),active:false,index:0,windowId:first.windowId})})`);
  await sleep(800);
  const seedTarget = (await control.send('Target.getTargets')).targetInfos.find(t=>t.url===url('/userseed'));
  const seedSession = await attach(seedTarget.targetId);
  await evaluate(seedSession,"document.cookie='lane=person;Path=/';true");
  await evaluate(s1,"document.cookie='lane=agent;Path=/';true",lane);
  const created = await evaluate(es,`chrome.tabs.create(${JSON.stringify({url:url('/slow-extension'),windowId:first.windowId,index:first.index+2,active:false})})`);
  await sleep(2500);
  const after = (await tool('list-sessions')).sessions.find(s=>s.sessionId===session.sessionId).tabs;
  const infos = (await control.send('Target.getTargets')).targetInfos.filter(x=>x.type==='page');
  check('extension new tab destination',mode==='baseline' ? after.some(x=>x.url==='about:blank') : after.some(x=>x.url===url('/slow-extension')),{created:created.url,tabs:after.map(x=>({url:x.url,targetId:x.targetId})),pages:infos.map(x=>({url:x.url,targetId:x.targetId}))});
  // A normal tab must retain both extension scripts and the requested URL.
  const normal = await evaluate(es,`chrome.tabs.create(${JSON.stringify({url:url('/normal'),active:false,index:0,windowId:first.windowId})})`);
  await sleep(1500);
  const normalTarget = (await control.send('Target.getTargets')).targetInfos.find(x=>x.url===url('/normal'));
  const ns = await attach(normalTarget.targetId);
  const ni = await evaluate(ns,'({atStart,childResults})');
  check('ordinary user tab injection unchanged',ni.atStart.main&&ni.atStart.isolated==='yes',ni);
  check('ordinary user tab URL retained',normalTarget.url===url('/normal'),normal.url);
  if(mode !== 'baseline') {
    const grant = await tool('update-agent',{id:'probe-agent',extensions:{[ext]:true}});
    check('grant exposed through API',grant.extensions[ext]===true&&grant.extensionChangesRequireNavigation===true);
    await lane.send('Page.navigate',{url:url('/granted')},s1);
    await until(()=>evaluate(s1,'location.pathname === "/granted" && childResults.length===2',lane),'granted navigation');
    const gi=await evaluate(s1,'({atStart,childResults})',lane);
    check('granted manifest scripts and descendants',gi.atStart.main&&gi.atStart.isolated==='yes'&&gi.childResults.every(x=>x.child.main&&x.child.isolated==='yes'),gi);
    const current=await evaluate(es,`chrome.tabs.query({}).then(ts=>ts.find(t=>t.url===${JSON.stringify(url('/granted'))}))`);
    const injected=await evaluate(es,`chrome.scripting.executeScript({target:{tabId:${current.id},allFrames:true},world:'MAIN',func:()=>{window.syntheticProgrammatic=true;return true}})`);
    check('granted programmatic injection',injected.length===3,injected.length);
    await tool('update-agent',{id:'probe-agent',extensions:{[ext]:false}});
    check('existing wrapper remains until fresh navigation',await evaluate(s1,'!!syntheticMain',lane));
    const denied=await evaluate(es,`chrome.scripting.executeScript({target:{tabId:${current.id},allFrames:true},world:'MAIN',func:()=>{window.deniedProgrammatic=true;return true}}).then(r=>({r}),e=>({error:e.message}))`);
    check('revoked programmatic injection blocked',!await evaluate(s1,'!!window.deniedProgrammatic',lane),denied);
    await lane.send('Page.navigate',{url:url('/revoked')},s1);
    await until(()=>evaluate(s1,'location.pathname === "/revoked" && childResults.length===2',lane),'revoked navigation');
    const revoked=await evaluate(s1,'({atStart,childResults})',lane);
    check('fresh navigation removes wrappers in all descendants',!revoked.atStart.main&&revoked.childResults.every(x=>!x.child.main&&!x.child.isolated),revoked);
    const bad=await tool('update-agent',{id:'probe-agent',extensions:{bad:true}},true);
    check('malformed extension IDs rejected',!!bad.result?.isError,bad.result?.content?.[0]?.text);
    const firstRequests = requests.filter(x=>x.url==='/slow-extension');
    if (keeper) check('extension first request uses Google Chrome identity',firstRequests.length===1&&firstRequests.every(x=>x.brands.includes('Google Chrome')),firstRequests);
    else console.log('SKIP browser brand check: set SHUTTLE_UA_KEEPER');
    check('extension first request uses agent cookies',firstRequests.length===1&&firstRequests[0].cookie==='lane=agent',firstRequests);
    const normalRequests=requests.filter(x=>x.url==='/normal');
    check('ordinary first request uses personal cookies',normalRequests.length===1&&normalRequests[0].cookie==='lane=person',normalRequests);
    if(keeper)check('ordinary first request uses Google Chrome identity',normalRequests.every(x=>x.brands.includes('Google Chrome')),normalRequests);
    await tool('create-agent',{id:'probe-granted',extensions:{[ext]:true}});
    const gs=await tool('open-session',{agent:'probe-granted',idleMinutes:0});
    const gt=await tool('allocate-tab',{sessionId:gs.sessionId,url:url('/grant-at-create')});
    const gc=await connect(gs.cdpEndpoint), gsid=await attach(gt.targetId,gc);
    await until(()=>evaluate(gsid,'!!window.atStart',gc),'grant at create');
    check('grant at create applies before first page script',await evaluate(gsid,'atStart.main && atStart.isolated==="yes"',gc));
    const popup=await evaluate(s1,`window.open(${JSON.stringify(url('/slow-popup'))},'_blank','noopener');true`,lane);
    await sleep(2000);
    check('agent window.open keeps URL',(await tool('list-sessions')).sessions.find(x=>x.sessionId===session.sessionId).tabs.some(t=>t.url===url('/slow-popup')));
  }
} catch(e) {check('probe completed',false,e.stack);}
finally {
  try {if(control)await control.send('Browser.close');}catch{}
  await sleep(500);
  for(const ws of sockets)ws.close();
  keeper?.kill('SIGTERM');
  if(browser?.exitCode===null) {await Promise.race([new Promise(r=>browser.once('exit',r)),sleep(5000)]);if(browser.exitCode===null)browser.kill('SIGTERM');}
  site.closeAllConnections();site.close();
  writeFileSync(path.join(dir,'results.json'),JSON.stringify({checks,requests,browserExit:browser?.exitCode},null,2)+'\n');
}
process.exit(checks.every(x=>x.ok)?0:1);
