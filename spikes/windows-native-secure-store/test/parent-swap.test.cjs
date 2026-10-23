'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') {
  test('Windows parent-swap resistance', { skip: 'requires native Windows' }, () => {});
} else {
  const addon = require('../index-test.cjs');
  const junctionScript = path.join(__dirname, 'create-junction.ps1');

  function onceMessage(worker) {
    return new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
  }

  function createJunction(link, target) {
    execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', junctionScript, link, target], { stdio: 'pipe' });
  }

  for (const [kind, leaf] of [['file', 'swapped-file'], ['directory', 'swapped-directory']]) {
    test(`handle-relative ${kind} creation survives a parent junction swap`, async () => {
      const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-parent-swap-'));
      const rootPath = path.join(basePath, 'trusted-root');
      const movedPath = path.join(basePath, 'trusted-root-moved');
      const outsidePath = path.join(basePath, 'outside');
      fs.mkdirSync(rootPath);
      fs.mkdirSync(outsidePath);
      const sentinel = path.join(outsidePath, 'sentinel.txt');
      fs.writeFileSync(sentinel, 'outside-sentinel');
      const id = `Local\\\\xyva-barrier-${process.pid}-${Date.now()}-swap-${kind}`;
      const reached = `${id}-reached`;
      const proceed = `${id}-continue`;
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const addon = require(workerData.addon);
        const root = addon.openTrustedRoot(workerData.root);
        addon.configureTestBarrier(workerData.reached, workerData.proceed);
        parentPort.postMessage('configured');
        try {
          if (workerData.kind === 'file') addon.createPrivateFile(root, workerData.leaf, Buffer.from('synthetic-only'));
          else addon.createPrivateDirectory(root, workerData.leaf);
          parentPort.postMessage('ok');
        } catch (error) { parentPort.postMessage({ code: error.code }); }
      `, { eval: true, workerData: {
        addon: path.join(__dirname, '..', 'index-test.cjs'), root: rootPath, reached, proceed, kind, leaf,
      }});

      let configured = false;
      let released = false;
      let junctionCreated = false;
      try {
        assert.equal(await onceMessage(worker), 'configured');
        configured = true;
        addon.waitTestBarrier(reached, 10_000);
        assert.equal(fs.existsSync(path.join(rootPath, leaf)), false);
        fs.renameSync(rootPath, movedPath);
        createJunction(rootPath, outsidePath);
        junctionCreated = true;
        addon.signalTestBarrier(proceed);
        released = true;
        assert.equal(await onceMessage(worker), 'ok');
        assert.equal(fs.existsSync(path.join(movedPath, leaf)), true);
        assert.equal(fs.existsSync(path.join(outsidePath, leaf)), false);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside-sentinel');
      } finally {
        if (configured && !released) {
          try { addon.signalTestBarrier(proceed); }
          catch (error) { if (error?.code !== 'XYVA_TEST_EVENT_FAILED') throw error; }
        }
        await worker.terminate();
        if (junctionCreated) fs.rmdirSync(rootPath);
        fs.rmSync(basePath, { recursive: true, force: true });
      }
    });
  }
}
