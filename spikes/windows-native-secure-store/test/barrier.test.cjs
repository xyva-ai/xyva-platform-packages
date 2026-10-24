'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') {
  test('Windows named-event barriers', { skip: 'requires native Windows' }, () => {});
} else {
  const addon = require('../index-test.cjs');

  function onceMessage(worker) {
    return new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
  }

  for (const [kind, leaf] of [['file', 'barrier-file'], ['directory', 'barrier-dir']]) {
    test(`barrier releases ${kind} creation`, async () => {
      const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-barrier-'));
      const id = `Local\\xyva-barrier-${process.pid}-${Date.now()}-${kind}`;
      const reached = `${id}-reached`;
      const proceed = `${id}-continue`;
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const addon = require(workerData.addon);
        const root = addon.openTrustedRoot(workerData.root);
        addon.configureTestBarrier(workerData.reached, workerData.proceed);
        parentPort.postMessage('configured');
        try {
          if (workerData.kind === 'file') {
            addon.createPrivateFile(root, workerData.leaf, Buffer.from('x'));
          } else {
            addon.createPrivateDirectory(root, workerData.leaf);
          }
          parentPort.postMessage('ok');
        } catch (error) {
          parentPort.postMessage({ code: error.code });
        }
      `, {
        eval: true,
        workerData: {
          addon: path.join(__dirname, '..', 'index-test.cjs'),
          root: rootPath,
          reached,
          proceed,
          kind,
          leaf,
        },
      });

      let configured = false;
      let released = false;
      try {
        assert.equal(await onceMessage(worker), 'configured');
        configured = true;
        addon.waitTestBarrier(reached, 10_000);
        assert.equal(fs.existsSync(path.join(rootPath, leaf)), false);
        addon.signalTestBarrier(proceed);
        released = true;
        assert.equal(await onceMessage(worker), 'ok');
        assert.equal(fs.existsSync(path.join(rootPath, leaf)), true);
      } finally {
        if (configured && !released) {
          try {
            addon.signalTestBarrier(proceed);
          } catch (error) {
            if (error?.code !== 'XYVA_TEST_EVENT_FAILED') throw error;
          }
        }
        await worker.terminate();
        fs.rmSync(rootPath, { recursive: true, force: true });
      }
    });
  }
}
