'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  });
}
