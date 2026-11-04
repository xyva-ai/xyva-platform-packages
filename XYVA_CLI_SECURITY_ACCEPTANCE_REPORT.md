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
- Windows Server 2025 hosted compatibility is PASS-scoped on PR #16 head
  `1628bb47`, run `41797366842`, including fake-process, provider-boundary,
  packaging, typecheck and public regression evidence.

## Not accepted as complete

- Native Windows 11 device evidence is absent; hosted Windows Server evidence
  is not substituted for it.
- The actual provider sandbox semantics and data-exfiltration resistance were
  not tested with a real provider task.
- No provider OAuth/session files were read, and no real inference was run.
- Independent human security review is still required.

Security classification: `PARTIAL_SECURITY_ACCEPTANCE`.

