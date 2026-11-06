# Official provider CLI operational boundary

`ProviderCliBridgeV1` is a separate local bridge. It is not the existing
API/local `ProviderBridgeV1`, it does not accept provider keys, and it cannot
receive shell arguments, paths, environments, or credentials from a product
client.

## Execution states

| Provider | Discovery | Synthetic adapter profile | Real product execution |
| --- | --- | --- | --- |
| Codex CLI | Secret-free version plus documented login-status probe | Fixed read-only `exec` arguments, stdin prompt, temporary work/home | Default deny pending provider operating-mode and device evidence |
| Claude Code | Secret-free version plus `claude auth status --json` exit status | Fixed print/JSON/no-session/no-tool/restricted arguments, stdin prompt | Default deny pending provider operating-mode and device evidence |
| Gemini CLI | Secret-free version probe only; auth remains unknown | Explicitly denied | Default deny pending no-tool/config/session evidence and provider approval |

The local test-mode switches are not a commercial entitlement. They exist only
for synthetic fake-process tests. Inference profiles set a disposable home and
never copy or inspect a provider session file. Consequently an existing human
CLI login is intentionally not reused by this test route.

## Consent and updates

An execution request needs all of the following: the QA Studio bridge
capability, local test-mode activation, a persisted non-secret per-provider
grant, a supported local version, and an authenticated documented CLI status.
Cancelling a task remains allowed to its owning QA socket even if its grant is
withdrawn, because cancellation can only reduce provider activity.

`provider cli update` is reporting-only. XYVA neither installs nor upgrades a
user-managed CLI. An executable update workflow needs a separately approved
managed-distribution design with immutable source, integrity verification,
rollback, version pinning, and explicit operator consent.

## Non-negotiable restrictions

- No OAuth/session-file extraction or token conversion.
- No login, inference, installation, or update during discovery/doctor.
- No shell invocation, caller-controlled command arguments, working
  directories, or execution environment.
- No provider output diagnostics or local paths reflected through the bridge.
- No claim that hosted Windows Server evidence proves native Windows 11.

## External gates

Before this can be enabled beyond synthetic local testing, XYVA needs a
provider-approved commercial operating mode for each provider, an independent
security review, a trusted native Windows 11 target, and a package-line release
path into QA Studio. These gates are intentionally not bypassed in code.
