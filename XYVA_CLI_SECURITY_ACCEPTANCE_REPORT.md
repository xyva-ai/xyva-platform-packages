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
- Windows Server hosted compatibility remains PASS-scoped on the prior server
  matrix.
- Native Windows 11 bounded acceptance is PASS-scoped on QA Studio PR #139,
  run `42086602294`, with platform source `1bbe3b3775a7a230572c9d7f947161a0702aca4e`;
  parent-swap 4/4, secure-store 5/5 and cleanup/evidence gates passed.
- Gemini's synthetic adapter profile is fixed to JSON + plan + sandbox flags,
  with isolated HOME and bounded stdin/stdout. Product bridge execution remains
  default-deny until independent provider sandbox/compliance review.
- Lifecycle controls are locally verified at commit `30494bf`: manifest expiry,
  HTTPS source metadata, signature callback, SHA-256 binding, explicit consent,
  active-task lock, versioned installation and verified rollback.

## Not accepted as complete

- Native Windows 11 evidence exists only for the bounded synthetic CLI/secure-store
  suites and is not substituted for a full provider or production acceptance.
- The actual provider sandbox semantics and data-exfiltration resistance were
  not tested with a real provider task.
- No provider OAuth/session files were read, and no real inference was run.
- Independent human security review is still required.
- No provider-specific signed distribution manifest is configured; the lifecycle
  API is fail-closed and the public update command remains non-mutating.

Security classification: `PARTIAL_SECURITY_ACCEPTANCE`.

