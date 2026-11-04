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
| CLI-07 | Windows hosted compatibility | platform-packages | BLOCKED | PR #16 has failed Windows checks | platform-neutral correction and controlled rerun |
| CLI-08 | Native Windows 11 CLI | platform-packages | NOT_EXECUTED | no trusted target evidence | external trusted Windows 11 target |
| CLI-09 | QA Studio product/browser E2E | qa-studio | BLOCKED | focused agent test PASS; no CLI browser evidence | package-line composition required |
| CLI-10 | Flow integration | xyva-flow | NOT_EXECUTED / out of current confirmed scope | generic ProviderBridgeV1 only; no CLI boundary | explicit product composition decision; no parallel engine |
| CLI-11 | Entitlements, grants and audit | platform-packages | PARTIAL | non-secret per-provider local grant + QA capability contract | product identity/licensing integration verification pending |
| CLI-12 | Provider compliance | cross-provider | PARTIAL | documented operational boundary; default deny and no session extraction | current provider terms and real execution mode must be independently verified |
| CLI-13 | Release candidate evidence | cross-repository | IN_PROGRESS | this tracker | requires all scoped tests and external gates documented |

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
