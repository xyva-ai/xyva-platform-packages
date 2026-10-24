'use strict';

const fs = require('node:fs');

function readArguments(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error('XYVA_CHILD_INVALID_ARGUMENTS');
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  return values;
}

function assertNodeDenied(operation, name) {
  try {
    operation();
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return;
    throw new Error(`XYVA_CHILD_${name}_UNEXPECTED_${error?.code || 'ERROR'}`);
  }
  throw new Error(`XYVA_CHILD_${name}_UNEXPECTED_SUCCESS`);
}

function assertNativeAccessDenied(error, name) {
  if (error !== 5) throw new Error(`XYVA_CHILD_${name}_NATIVE_PROBE_ERROR_${error}`);
}

function main() {
  const args = readArguments(process.argv);
  const evidencePath = args.get('evidence');
  const phases = [];
  const addon = require(args.get('addon'));
  const token = addon.testCurrentToken();
  phases.push('token-probed');
  if (token.sid !== args.get('expected-sid') || token.administrator) throw new Error('XYVA_CHILD_UNTRUSTED_TOKEN');
  phases.push('identity-verified');

  const controlRoot = addon.openTrustedRoot(args.get('control-directory'));
  addon.createPrivateFile(controlRoot, 'child-positive.bin', Buffer.from('synthetic-child-control'));
  if (fs.readFileSync(`${args.get('control-directory')}\\child-positive.bin`, 'utf8') !== 'synthetic-child-control') {
    throw new Error('XYVA_CHILD_POSITIVE_CONTROL_FAILED');
  }
  phases.push('positive-addon-control');

  assertNodeDenied(() => fs.readFileSync(args.get('private-file')), 'PRIVATE_READ');
  assertNodeDenied(() => fs.appendFileSync(args.get('private-file'), 'x'), 'PRIVATE_WRITE');
  assertNodeDenied(() => fs.writeFileSync(`${args.get('private-directory')}\\child-create.bin`, 'x'), 'PRIVATE_DIRECTORY_CREATE');
  phases.push('node-denials-verified');
  // Test-only exports are absent from the production build. These calls execute
  // CreateFileW/CreateDirectoryW in this alternate token and assert the kernel's
  // ERROR_ACCESS_DENIED, avoiding ambiguity in high-level error translation.
  assertNativeAccessDenied(addon.testProbeRead(args.get('private-file')), 'PRIVATE_READ');
  assertNativeAccessDenied(addon.testProbeWrite(args.get('private-file')), 'PRIVATE_WRITE');
  assertNativeAccessDenied(addon.testProbeCreateDirectory(`${args.get('private-directory')}\\child-create.bin`), 'PRIVATE_DIRECTORY_CREATE');
  phases.push('kernel-denials-verified');

  fs.writeFileSync(evidencePath, JSON.stringify({
    status: 'PASS',
    pid: process.pid,
    sid: token.sid,
    administrator: token.administrator,
    phases,
  }));
}

try {
  main();
  process.exitCode = 0;
} catch (error) {
  const args = (() => { try { return readArguments(process.argv); } catch { return new Map(); } })();
  const evidencePath = args.get('evidence');
  if (evidencePath) fs.writeFileSync(evidencePath, JSON.stringify({ status: 'FAIL', code: error.message, pid: process.pid }));
  process.exitCode = 71;
}
