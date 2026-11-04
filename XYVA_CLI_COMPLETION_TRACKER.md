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
| CLI-07 | Windows hosted compatibility | platform-packages | VERIFIED (hosted scoped) | PR #16 head `1628bb47`; Windows Server 2025 Node 22 run `41797366842` PASS, including exact-SHA, fake-process, provider-boundary, public build/typecheck/regression and evidence gates | native Windows 11 remains separate |
| CLI-08 | Native Windows 11 CLI | platform-packages | NOT_EXECUTED | no trusted target evidence | external trusted Windows 11 target |
| CLI-09 | QA Studio product/browser E2E | qa-studio | VERIFIED (hosted scoped) | Draft PR #137 head `158adabb`; hosted run `41794619559` PASS for agent, security, docs and portal E2E; focused suite 15 passed, 2 platform skips | authenticated live-agent/provider session remains external |
| CLI-10 | Flow integration | xyva-flow | NOT_EXECUTED / out of current confirmed scope | generic ProviderBridgeV1 only; no CLI boundary | explicit product composition decision; no parallel engine |
| CLI-11 | Entitlements, grants and audit | platform-packages | PARTIAL | non-secret per-provider local grant + QA capability contract | product identity/licensing integration verification pending |
| CLI-12 | Provider compliance | cross-provider | PARTIAL | documented operational boundary; default deny and no session extraction | current provider terms and real execution mode must be independently verified |
| CLI-13 | Release candidate evidence | cross-repository | VERIFIED (scoped) | platform PR #23 at `aa7bd71`, final run pending on this head; QA Studio PR #137 at `158adabb`, run `41794619559`; PR #16 Windows run `41797366842` | native device, human review and commercial/external gates remain |

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
- Platform Packages draft PR #23 head `aa7bd71`: the cross-socket request-ID
  namespace fix and release-candidate evidence are committed and pushed. Public
  verification run `41798463100` completed successfully on Node 22 and Node 24.
  This is package compatibility evidence, not Windows 11 device acceptance or
  real-provider evidence.
- QA Studio draft PR #137 head `158adabb3302f69ad4b9ac269255e313e895e461`: local
  contracts/bridge/agent checks, focused provider CLI suite (15 passed, 2
  platform skips), portal build and browser identity tests completed successfully.
  Hosted run `41794619559` completed PASS for agent, security, docs and portal
  E2E. The run's E2E is hosted/synthetic and does not prove a live provider
  session.
- Platform Packages PR #16 head `1628bb47ecb7c8c02532ddfd92eb075486da340a`:
  Windows Server 2025 Node 22 run `41797366842` completed PASS, including the
  Windows fake-process suite, provider-boundary regressions, public build,
  typecheck, regression and complete evidence gate.
