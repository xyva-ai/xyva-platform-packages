# XYVA CLI completion tracker

Status values are evidence-based as of the current isolated CLI worktree.
`NOT_EXECUTED` never means pass.

| ID | Work package | Repository | Status | Evidence | Security gate / dependency |
|---|---|---|---|---|---|
| CLI-01 | Registry, discovery and version matrix | platform-packages | VERIFIED (scoped) | three CLI discovery paths, trusted resolver and version-matrix tests | no provider calls during discovery |
| CLI-02 | Codex fake-process adapter lifecycle | platform-packages | VERIFIED (scoped) | request IDs, timeout, limits, cancellation-during-discovery and fake-process tests | real inference/commercial use default-deny |
| CLI-03 | Claude and Gemini task adapters | platform-packages | PARTIAL | Claude fixed stdin/no-tool fake-process profile; Gemini discovery and explicit fail-closed gate | Gemini no-tool/config/session and provider-compliance evidence remain external |
| CLI-04 | ProviderCliBridgeV1 | platform-packages | IMPLEMENTED / locally verified | three-provider versioned contracts, per-provider grants, dispatch and cancellation tests | QA capability, persisted grant and local test mode |
| CLI-05 | CLI lifecycle / updates | platform-packages | PARTIAL | status/list/doctor/update-guidance/matrix exist | no approved managed installer/update/rollback yet |
| CLI-06 | Existing API/local provider regression | platform-packages | VERIFIED (historical) | public verification reports | rerun after integration changes |
| CLI-07 | Windows hosted compatibility | platform-packages | BLOCKED | PR #16 has failed Windows checks; no native Windows rerun in this workstream | platform-neutral correction and controlled rerun |
| CLI-08 | Native Windows 11 CLI | platform-packages | NOT_EXECUTED | no trusted target evidence | external trusted Windows 11 target |
| CLI-09 | QA Studio product/browser E2E | qa-studio | IN_PROGRESS | Draft PR #137 at `d985470`; portal build and browser identity test pass; full authenticated CLI browser E2E not executed | package-line CI and authenticated agent session |
| CLI-10 | Flow integration | xyva-flow | NOT_EXECUTED / out of current confirmed scope | generic ProviderBridgeV1 only; no CLI boundary | explicit product composition decision; no parallel engine |
| CLI-11 | Entitlements, grants and audit | platform-packages | PARTIAL | non-secret per-provider local grant + QA capability contract | product identity/licensing integration verification pending |
| CLI-12 | Provider compliance | cross-provider | PARTIAL | documented operational boundary; default deny and no session extraction | current provider terms and real execution mode must be independently verified |
| CLI-13 | Release candidate evidence | cross-repository | IN_PROGRESS | platform PR #23 at `96a481d`; QA Studio PR #137 at `d985470`; hosted CI pending/partially verified | requires all scoped tests and external gates documented |

## Current external gates

- A trusted native Windows 11 test target and its bounded authorization are not
  evidenced; hosted Windows Server remains a separate compatibility tier.
- QA Studio and Foundation package lines require a composable, reviewed release
  path before browser E2E can represent the CLI bridge.
- Real provider authentication/inference requires documented commercial and
  provider-authorized operating modes; no session extraction or account use is
  permitted.
- Managed lifecycle updates require a separately approved immutable-source,
  integrity, consent and rollback design; the implemented command is guidance
  only and intentionally mutates nothing.

## Executed evidence

- macOS local discovery (2026-11-04): Codex `0.162.1` was found through the
  trusted resolver and reported authenticated; Gemini `0.64.0` was found with
  authentication intentionally `not_checked`; Claude Code was not installed.
  The commands were `provider cli status --json`, `provider cli doctor`, and
  reporting-only `provider cli update`. No login, inference, installation, or
  update was performed.
- Platform Packages draft PR #23 head `96a481dd48b101fc6badd6b54ae2bc427c8fdc9b`:
  the cross-socket request-ID namespace fix is committed and pushed. The prior
  GitHub-hosted Node 22/24 run `41791139547` completed successfully at the
  preceding head; follow-up public-verification run `41793971112` completed
  successfully on Node 22 and Node 24. This is package compatibility evidence,
  not Windows 11 device acceptance or real-provider evidence.
- QA Studio draft PR #137 head `d985470`:
  local contracts/bridge/agent checks, focused provider CLI suite (28 passed,
  2 platform skips), portal Next build, and portal browser identity test (14
  passed) completed successfully. Hosted CI run `41793691520` was triggered;
  its final conclusion must be recorded before release-candidate closure.
