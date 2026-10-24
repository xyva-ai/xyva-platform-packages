'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

if (process.platform !== 'win32') test('Windows-only adapter', { skip: 'requires native Windows' }, () => {});
else {
  const addon = require('../index.cjs');
  let rootPath, root;
  test.beforeEach(() => { rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-native-store-')); root = addon.openTrustedRoot(rootPath); });
  test.afterEach(() => { root = null; global.gc?.(); fs.rmSync(rootPath, { recursive: true, force: true }); });
  test('creates, verifies, and preserves a private file', () => {
    addon.createPrivateFile(root, 'secret.bin', Buffer.from('synthetic-only'));
  });
  test('creates and verifies private directory', () => {
    addon.createPrivateDirectory(root, 'private');
  });
  test('fails closed for duplicate and unsafe leaf input', () => {
    addon.createPrivateFile(root, 'once', Buffer.from('x'));
    assert.throws(() => addon.createPrivateFile(root, 'once', Buffer.from('x')), { code: 'XYVA_ALREADY_EXISTS' });
    assert.throws(() => addon.createPrivateFile(root, '..', Buffer.from('x')), { code: 'XYVA_INVALID_INPUT' });
    assert.throws(() => addon.createPrivateFile(root, 'nested\\leaf', Buffer.from('x')), { code: 'XYVA_INVALID_INPUT' });
    assert.throws(() => addon.createPrivateFile(root, 'alternate:stream', Buffer.from('x')), { code: 'XYVA_INVALID_INPUT' });
  });

  test('fails closed for a junction root without following its target', () => {
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-reparse-root-'));
    const targetPath = path.join(basePath, 'target');
    const junctionPath = path.join(basePath, 'junction');
    try {
      fs.mkdirSync(targetPath);
      fs.writeFileSync(path.join(targetPath, 'sentinel.bin'), 'synthetic-sentinel');
      fs.symlinkSync(targetPath, junctionPath, 'junction');
      assert.throws(() => addon.openTrustedRoot(junctionPath), { code: 'XYVA_UNTRUSTED_ROOT' });
      assert.equal(fs.readFileSync(path.join(targetPath, 'sentinel.bin'), 'utf8'), 'synthetic-sentinel');
      assert.deepEqual(fs.readdirSync(targetPath), ['sentinel.bin']);
    } finally {
      if (fs.existsSync(junctionPath)) fs.rmdirSync(junctionPath);
      fs.rmSync(basePath, { recursive: true, force: true });
    }
  });

  test('releases a root capability before controlled cleanup', () => {
    const cleanupPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-root-cleanup-'));
    let cleanupRoot = addon.openTrustedRoot(cleanupPath);
    addon.createPrivateFile(cleanupRoot, 'synthetic.bin', Buffer.from('x'));
    cleanupRoot = null;
    global.gc?.();
    assert.doesNotThrow(() => fs.rmSync(cleanupPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    assert.equal(fs.existsSync(cleanupPath), false);
  });

  test('separate non-admin process proves kernel access denials', { timeout: 60000 }, () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xyva-second-user-'));
    const controlDirectory = path.join(testRoot, 'control');
    const privateFile = path.join(testRoot, 'private.bin');
    const privateDirectory = path.join(testRoot, 'private-directory');
    const evidencePath = path.join(controlDirectory, 'second-user-evidence.json');
    let testRootCapability;
    try {
      fs.mkdirSync(controlDirectory);
      testRootCapability = addon.openTrustedRoot(testRoot);
      addon.createPrivateFile(testRootCapability, 'private.bin', Buffer.from('synthetic-private-content'));
      addon.createPrivateDirectory(testRootCapability, 'private-directory');
      testRootCapability = null;
      global.gc?.();

      const run = childProcess.spawnSync(
        'pwsh.exe',
        [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'run-second-user.ps1'),
          '-NodeExe', process.execPath,
          '-ChildScript', path.join(__dirname, 'second-user-child.cjs'),
          '-Addon', path.join(__dirname, '..', 'index-test.cjs'),
          '-Root', testRoot,
          '-ControlDirectory', controlDirectory,
          '-PrivateFile', privateFile,
          '-PrivateDirectory', privateDirectory,
          '-EvidencePath', evidencePath,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 45000 },
      );
      assert.equal(run.error, undefined, run.error?.message);
      assert.equal(run.status, 0, `${run.stderr || run.stdout || 'second-user harness failed'}`);
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      assert.equal(evidence.status, 'PASS');
      assert.ok(Number.isInteger(evidence.childPid) && evidence.childPid > 0);
      assert.notEqual(evidence.childPid, process.pid);
      assert.match(evidence.childSid, /^S-1-5-21-/);
      assert.equal(evidence.administrator, false);
      assert.deepEqual(evidence.phases, ['token-probed', 'identity-verified', 'positive-addon-control', 'node-denials-verified', 'kernel-denials-verified']);
      if (process.env.XYVA_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.XYVA_EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.XYVA_EVIDENCE_DIR, 'second-user-process.json'), JSON.stringify({
          status: evidence.status,
          childPid: evidence.childPid,
          childSid: evidence.childSid,
          administrator: evidence.administrator,
          phases: evidence.phases,
          node: process.version,
        }));
      }
    } finally {
      testRootCapability = null;
      global.gc?.();
      fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
}
