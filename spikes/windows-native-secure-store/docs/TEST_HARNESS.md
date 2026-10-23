# Test-build boundary

`windows_native_secure_store` is the only normal target. It has no test IPC,
barrier, account-management, or debug API. `windows_native_secure_store_test`
is a separate binary compiled with `XYVA_TEST_BUILD=1`; it is loaded only by
the Windows-only harness and must never be packaged as a runtime artifact.

The later Windows harness must use two processes: a controller owns named
events and performs the path rename/junction swap while a worker holds the
NativeRoot and waits at the test-build barrier immediately before `NtCreateFile`.
The child identity probe must be launched with a token created by Win32 logon
APIs, receive no password through arguments/environment, load this test binary,
and emit secret-free JSON evidence. A missing barrier reach, timeout, failed
junction cleanup, absent child PID, or failed positive control is a test FAIL.

This document is design preparation only; it is not evidence of a Windows run.
