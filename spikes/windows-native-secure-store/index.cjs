'use strict';

if (process.platform !== 'win32') {
  throw Object.assign(new Error('XYVA_WINDOWS_NATIVE_STORE_UNSUPPORTED_PLATFORM'), { code: 'XYVA_UNSUPPORTED_PLATFORM' });
}
if (process.arch !== 'x64') {
  throw Object.assign(new Error('XYVA_WINDOWS_NATIVE_STORE_UNSUPPORTED_ARCH'), { code: 'XYVA_UNSUPPORTED_ARCH' });
}
// The path is package-owned and fixed; no PATH lookup, child process, or fallback exists.
module.exports = require('./build/Release/windows_native_secure_store.node');
