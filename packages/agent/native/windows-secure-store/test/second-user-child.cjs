'use strict';

const fs = require('node:fs');

function argumentsByName(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error('XYVA_CHILD_INVALID_ARGUMENTS');
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  return values;
}

function assertDenied(operation, name) {
  try {
    operation();
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return;
    throw new Error(`XYVA_CHILD_${name}_UNEXPECTED_${error?.code || 'ERROR'}`);
  }
  throw new Error(`XYVA_CHILD_${name}_UNEXPECTED_SUCCESS`);
}

function assertKernelDenied(error, name) {
  if (error !== 5) throw new Error(`XYVA_CHILD_${name}_NATIVE_PROBE_ERROR_${error}`);
}

function main() {
  const args = argumentsByName(process.argv);
  const phases = [];
  const addon = require(args.get('addon'));
  const token = addon.testCurrentToken();
  phases.push('token-probed');
  if (token.sid !== args.get('expected-sid') || token.administrator) throw new Error('XYVA_CHILD_UNTRUSTED_TOKEN');
  phases.push('identity-verified');

  fs.writeFileSync(`${args.get('control-directory')}\\child-positive.bin`, 'synthetic-child-control');
  if (fs.readFileSync(`${args.get('control-directory')}\\child-positive.bin`, 'utf8') !== 'synthetic-child-control') {
    throw new Error('XYVA_CHILD_POSITIVE_CONTROL_FAILED');
  }
  phases.push('positive-file-control');

  assertDenied(() => fs.readFileSync(args.get('private-file')), 'PRIVATE_READ');
  assertDenied(() => fs.appendFileSync(args.get('private-file'), 'x'), 'PRIVATE_WRITE');
  assertDenied(() => fs.writeFileSync(`${args.get('private-directory')}\\child-create.bin`, 'x'), 'PRIVATE_DIRECTORY_CREATE');
  phases.push('node-denials-verified');

  assertKernelDenied(addon.testProbeRead(args.get('private-file')), 'PRIVATE_READ');
  assertKernelDenied(addon.testProbeWrite(args.get('private-file')), 'PRIVATE_WRITE');
  assertKernelDenied(addon.testProbeCreateDirectory(`${args.get('private-directory')}\\child-create.bin`), 'PRIVATE_DIRECTORY_CREATE');
  phases.push('kernel-denials-verified');

  fs.writeFileSync(args.get('evidence'), JSON.stringify({ status: 'PASS', pid: process.pid, sid: token.sid, administrator: token.administrator, phases }));
}

try {
  main();
  process.exitCode = 0;
} catch (error) {
  const args = (() => { try { return argumentsByName(process.argv); } catch { return new Map(); } })();
  const evidencePath = args.get('evidence');
  if (evidencePath) fs.writeFileSync(evidencePath, JSON.stringify({ status: 'FAIL', code: error.message, pid: process.pid }));
  process.exitCode = 71;
}
