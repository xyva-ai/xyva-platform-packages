'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');

function readArguments(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error('XYVA_CHILD_INVALID_ARGUMENTS');
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  return values;
}

function currentToken() {
  const probe = childProcess.spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); @{ sid = $identity.User.Value; administrator = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress"],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 },
  );
  if (probe.error || probe.status !== 0 || !probe.stdout) throw new Error('XYVA_CHILD_TOKEN_PROBE_FAILED');
  return JSON.parse(probe.stdout);
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

function assertKernelAccessDenied(action, target, name) {
  const encodedTarget = Buffer.from(target, 'utf8').toString('base64');
  const command = `$ErrorActionPreference='Stop'; $target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTarget}')); try { switch ('${action}') { 'read' { [IO.File]::ReadAllBytes($target) | Out-Null }; 'write' { [IO.File]::AppendAllText($target, 'x') }; 'create' { [IO.File]::WriteAllText($target, 'x') } } } catch { if ($_.Exception.HResult -eq -2147024891) { exit 0 }; throw ('XYVA_KERNEL_DENIAL_UNEXPECTED_HRESULT=' + $_.Exception.HResult) }; throw 'XYVA_KERNEL_DENIAL_UNEXPECTED_SUCCESS'`;
  const probe = childProcess.spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 },
  );
  if (probe.error || probe.status !== 0) {
    const detail = String(probe.stderr || probe.stdout || probe.error?.message || 'no-detail').replace(/[\r\n]+/g, ' ').slice(0, 240);
    throw new Error(`XYVA_CHILD_${name}_KERNEL_PROBE_FAILED_${probe.status ?? 'ERROR'}_${detail}`);
  }
}

function main() {
  const args = readArguments(process.argv);
  const evidencePath = args.get('evidence');
  const phases = [];
  const token = currentToken();
  phases.push('token-probed');
  if (token.sid !== args.get('expected-sid') || token.administrator) throw new Error('XYVA_CHILD_UNTRUSTED_TOKEN');
  phases.push('identity-verified');

  const addon = require(args.get('addon'));
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
  assertKernelAccessDenied('read', args.get('private-file'), 'PRIVATE_READ');
  assertKernelAccessDenied('write', args.get('private-file'), 'PRIVATE_WRITE');
  assertKernelAccessDenied('create', `${args.get('private-directory')}\\child-create.bin`, 'PRIVATE_DIRECTORY_CREATE');
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
