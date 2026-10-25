'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

if (process.platform !== 'win32') {
  test('Windows native parent-swap integration', { skip: 'requires native Windows' }, () => {});
} else {
  const addonPath = path.join(__dirname, '..', 'build', 'Release', 'xyva_windows_secure_store_test.node');
  const addon = require(addonPath);

  function message(worker) {
    return new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
  }

  function swapRoot(root, moved, outside) {
    const script = path.join(__dirname, 'swap-parent.ps1');
    const output = execFileSync('pwsh.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
      '-Root', root, '-Moved', moved, '-Outside', outside,
    ], { windowsHide: true, timeout: 10_000, stdio: 'pipe' }).toString('utf8');
    assert.match(output, /XYVA_PARENT_SWAP_OK/);
    assert.equal(fs.realpathSync(root), fs.realpathSync(outside));
    assert.equal(fs.existsSync(path.join(root, 'sentinel.txt')), true);
  }

  async function exerciseSwap(operation) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `xyva-secure-store-${operation}-swap-`));
    const root = path.join(base, 'trusted-root');
    const moved = path.join(base, 'trusted-root-moved');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'synthetic-sentinel');
    const trusted = addon.ensureTrustedRoot(root);
    addon.createPrivateFile(trusted, 'private.json', Buffer.from('synthetic-only'));
    const prefix = `Local\\xyva-secure-store-${process.pid}-${Date.now()}-${operation}`;
    const reached = `${prefix}-reached`;
    const proceed = `${prefix}-proceed`;
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const addon = require(workerData.addonPath);
      const root = addon.openTrustedRoot(workerData.root);
      addon.configureTestBarrier(workerData.reached, workerData.proceed);
      parentPort.postMessage('ready');
      try {
        const result = workerData.operation === 'read'
          ? addon.readPrivateFile(root, 'private.json').toString('utf8')
          : (addon.deletePrivateFile(root, 'private.json'), 'deleted');
        parentPort.postMessage({ result });
      } catch (error) { parentPort.postMessage({ code: error.code || 'UNKNOWN' }); }
    `, { eval: true, workerData: { addonPath, root, reached, proceed, operation } });

    let swapped = false;
    try {
      assert.equal(await message(worker), 'ready');
      addon.waitTestBarrier(reached, 10_000);
      swapRoot(root, moved, outside);
      swapped = true;
      addon.signalTestBarrier(proceed);
      const outcome = await message(worker);
      assert.deepEqual(outcome, { result: operation === 'read' ? 'synthetic-only' : 'deleted' });
      assert.equal(fs.existsSync(path.join(outside, 'private.json')), false);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'synthetic-sentinel');
      assert.equal(fs.existsSync(path.join(moved, 'private.json')), operation === 'read');
    } finally {
      try {
        addon.signalTestBarrier(proceed);
      } catch (error) {
        if (error?.code !== 'XYVA_TEST_EVENT_FAILED') throw error;
      }
      await worker.terminate();
      if (swapped) fs.rmdirSync(root);
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  test('handle-relative create and replace stay in the opened root across a junction swap', { timeout: 30_000 }, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-secure-store-swap-'));
    const root = path.join(base, 'trusted-root');
    const moved = path.join(base, 'trusted-root-moved');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'synthetic-sentinel');
    const prefix = `Local\\xyva-secure-store-${process.pid}-${Date.now()}`;
    const reached = `${prefix}-reached`;
    const proceed = `${prefix}-proceed`;
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const addon = require(workerData.addonPath);
      const root = addon.ensureTrustedRoot(workerData.root);
      addon.configureTestBarrier(workerData.reached, workerData.proceed);
      parentPort.postMessage('ready');
      try {
        addon.createPrivateFile(root, 'pending.tmp', Buffer.from('synthetic-only'));
        addon.replacePrivateFile(root, 'pending.tmp', 'private.json');
        parentPort.postMessage('ok');
      } catch (error) { parentPort.postMessage({ code: error.code || 'UNKNOWN' }); }
    `, { eval: true, workerData: { addonPath, root, reached, proceed } });

    let swapped = false;
    try {
      assert.equal(await message(worker), 'ready');
      addon.waitTestBarrier(reached, 10_000);
      assert.equal(fs.existsSync(root), true);
      swapRoot(root, moved, outside);
      swapped = true;
      addon.signalTestBarrier(proceed);
      assert.equal(await message(worker), 'ok');
      assert.equal(fs.readFileSync(path.join(moved, 'private.json'), 'utf8'), 'synthetic-only');
      assert.equal(fs.existsSync(path.join(outside, 'private.json')), false);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'synthetic-sentinel');
    } finally {
      try {
        addon.signalTestBarrier(proceed);
      } catch (error) {
        if (error?.code !== 'XYVA_TEST_EVENT_FAILED') throw error;
      }
      await worker.terminate();
      if (swapped) fs.rmdirSync(root);
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  test('handle-relative read stays in the opened root across a junction swap', { timeout: 30_000 }, () => exerciseSwap('read'));
  test('handle-relative delete stays in the opened root across a junction swap', { timeout: 30_000 }, () => exerciseSwap('delete'));
}
