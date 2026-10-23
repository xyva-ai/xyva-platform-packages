'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const tests = ['adapter.test.cjs', 'barrier.test.cjs', 'parent-swap.test.cjs'];
for (const test of tests) {
  const result = spawnSync(process.execPath, ['--expose-gc', '--test', path.join(__dirname, test)], {
    stdio: 'inherit',
    timeout: 45_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
