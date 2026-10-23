'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
if (process.platform !== 'win32') test('Windows named-event barriers', { skip: 'requires native Windows' }, () => {}); else {
 const addon = require('../index-test.cjs');
 for (const [kind, leaf] of [['file','barrier-file'],['directory','barrier-dir']]) test(`barrier releases ${kind} creation`, async () => {
  const rootPath=fs.mkdtempSync(path.join(os.tmpdir(),'xyva-barrier-')); const id=`Local\\xyva-${process.pid}-${Date.now()}-${kind}`; const reached=`${id}-reached`, proceed=`${id}-continue`;
  const w=new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const a=require(workerData.addon); const r=a.openTrustedRoot(workerData.root); a.configureTestBarrier(workerData.reached,workerData.proceed); parentPort.postMessage('configured'); try { workerData.kind==='file'?a.createPrivateFile(r,workerData.leaf,Buffer.from('x')):a.createPrivateDirectory(r,workerData.leaf); parentPort.postMessage('ok'); } catch(e){parentPort.postMessage({code:e.code}); }`,{eval:true,workerData:{addon:path.join(__dirname,'..','index-test.cjs'),root:rootPath,reached,proceed,kind,leaf}});
  try { assert.equal(await new Promise((res,rej)=>{w.once('message',res);w.once('error',rej)}),'configured'); addon.waitTestBarrier(reached,10000); assert.equal(fs.existsSync(path.join(rootPath,leaf)),false); addon.signalTestBarrier(proceed); assert.equal(await new Promise((res,rej)=>{w.once('message',res);w.once('error',rej)}),'ok'); assert.equal(fs.existsSync(path.join(rootPath,leaf)),true); } finally { try { addon.signalTestBarrier(proceed); } catch {} await w.terminate(); fs.rmSync(rootPath,{recursive:true,force:true}); }
 });
}
