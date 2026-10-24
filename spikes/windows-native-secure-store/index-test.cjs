'use strict';
if (process.platform !== 'win32' || process.arch !== 'x64') throw Object.assign(new Error('XYVA_TEST_BINARY_UNAVAILABLE'), { code: 'XYVA_TEST_BINARY_UNAVAILABLE' });
module.exports = require('./build/Release/windows_native_secure_store_test.node');
