# XYVA CLI Security Acceptance Report

## Verified controls

- `shell: false` for provider execution.
- Trusted executable resolution and PATH-hijacking rejection.
- Fixed provider argument profiles; prompts are passed through stdin.
- Disposable provider task directories and filtered environments.
- Default-deny test mode and per-provider grants.
- Structured, secret-free errors and bounded stdout/stderr.
- Timeout, cancellation and provider/global concurrency limits.
- Cancellation request IDs are namespaced per WebSocket scope before reaching
  the shared process manager.
- Process cleanup now delays completion until the termination grace/force path
  has run; the CI race found in run `41793691520` was corrected in `36c757d`.

## Not accepted as complete

- Native Windows `.exe`/`.cmd` and process-tree evidence remains outside the
  verified macOS scope; PR #16 still has a failed Windows history.
- Windows 11 device evidence is absent.
- The actual provider sandbox semantics and data-exfiltration resistance were
  not tested with a real provider task.
- No provider OAuth/session files were read, and no real inference was run.
- Independent human security review is still required.

Security classification: `PARTIAL_SECURITY_ACCEPTANCE`.

