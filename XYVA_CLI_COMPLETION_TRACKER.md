# XYVA CLI completion tracker

Status values are evidence-based as of the current isolated CLI worktree.
`NOT_EXECUTED` never means pass.

| ID | Work package | Repository | Status | Evidence | Security gate / dependency |
|---|---|---|---|---|---|
| CLI-01 | Registry, discovery and version matrix | platform-packages | VERIFIED (scoped) | three CLI discovery paths, trusted resolver and version-matrix tests | no provider calls during discovery |
| CLI-02 | Codex fake-process adapter lifecycle | platform-packages | VERIFIED (scoped) | request IDs, timeout, limits, cancellation-during-discovery and fake-process tests | real inference/commercial use default-deny |
| CLI-03 | Claude and Gemini task adapters | platform-packages | VERIFIED (synthetic / product-gated) | Claude and Gemini fixed stdin/no-tool fake-process profiles; Gemini plan+sandbox profile and parser tests | Gemini product bridge remains default-deny pending independent sandbox/compliance evidence |
| CLI-04 | ProviderCliBridgeV1 | platform-packages | IMPLEMENTED / locally verified | three-provider versioned contracts, per-provider grants, dispatch and cancellation tests | QA capability, persisted grant and local test mode |
| CLI-05 | CLI lifecycle / updates | platform-packages | IMPLEMENTED / locally verified | signed-manifest validation, SHA-256 verification, consent gate, versioned install, rollback slot and fail-closed lifecycle tests | no provider-specific signed manifest/source is configured; production update remains disabled |
| CLI-06 | Existing API/local provider regression | platform-packages | VERIFIED (historical) | public verification reports | rerun after integration changes |
| CLI-07 | Windows hosted compatibility | platform-packages | VERIFIED (hosted scoped) | PR #16 head `1628bb47`; Windows Server 2025 Node 22 run `41797366842` PASS, including exact-SHA, fake-process, provider-boundary, public build/typecheck/regression and evidence gates | native Windows 11 remains separate |
| CLI-08 | Native Windows 11 CLI | platform-packages | NOT_EXECUTED | no trusted target evidence | external trusted Windows 11 target |
| CLI-09 | QA Studio product/browser E2E | qa-studio | VERIFIED (hosted scoped) | Draft PR #137 head `158adabb`; hosted run `41794619559` PASS for agent, security, docs and portal E2E; focused suite 15 passed, 2 platform skips | authenticated live-agent/provider session remains external |
| CLI-10 | Flow integration | xyva-flow | PARTIAL / adapter implemented | typed `ProviderCliModelProvider` maps Flow's model-provider boundary to local `ProviderCliBridgeV1`; runtime client composition remains disabled | pairing, entitlement and runtime cancellation wiring require review |
| CLI-11 | Entitlements, grants and audit | platform-packages | PARTIAL | non-secret per-provider local grant + QA capability contract; grant/revoke audit entries; bridge rejects missing/revoked grants | Foundation product identity integration and independent audit review pending |
| CLI-12 | Provider compliance | cross-provider | PARTIAL | documented operational boundary; default deny and no session extraction | current provider terms and real execution mode must be independently verified |
| CLI-13 | Release candidate evidence | cross-repository | VERIFIED (scoped) | platform PR #23 head `2043894`, run `41803233030`; QA Studio PR #137 at `158adabb`, run `41794619559`; PR #16 Windows run `41797366842` | native device, human review and commercial/external gates remain |

## Current external gates

- A trusted native Windows 11 test target and its bounded authorization are not
  evidenced; hosted Windows Server remains a separate compatibility tier.
- QA Studio and Foundation package lines require a composable, reviewed release
  path before browser E2E can represent the CLI bridge.
- Real provider authentication/inference requires documented commercial and
  provider-authorized operating modes; no session extraction or account use is
  permitted.
- Managed lifecycle code now provides a signed-manifest, integrity, consent and
  rollback boundary for local artifacts. No provider-specific manifest/source is
  configured, so the public update command remains guidance-only and mutates
  nothing.

## Executed evidence

- macOS local discovery (2026-11-04): Codex `0.162.1` was found through the
  trusted resolver and reported authenticated; Gemini `0.64.0` was found with
  authentication intentionally `not_checked`; Claude Code was not installed.
  The commands were `provider cli status --json`, `provider cli doctor`, and
  reporting-only `provider cli update`. No login, inference, installation, or
  update was performed.
- Platform Packages draft PR #23 head `2043894457fce8a1787d650984fd5e316a4dd231`:
  Gemini fixed-profile support, signed lifecycle API, status integrity fields
  and Flow composition boundary are committed and pushed. Public verification
  run `41803233030` completed successfully on Node 22 and Node 24.
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
- Platform Packages local implementation commit `30494bf8034123f249d539f48d993ba42c7754cb`:
  Gemini fixed-profile adapter tests, signed lifecycle manager tests, status
  integrity/rollback fields, and explicit Flow composition boundary. Local
  targeted adapter/lifecycle tests passed (20/20), bridge contract tests passed
  (15/15), and `npm run verify:public` passed (190 passed, 5 documented skips).
- Platform Packages entitlement/audit follow-up commit
  `05df36982fdd4d0e5fb067a853f453a8805a9018` added secret-free grant/revoke
  audit evidence; hosted run `41809275438` passed on Node 22 and Node 24.
- Flow branch `codex/flow-cli-runtime-bridge`, head
  `89559f3d838f1debd8df917486bd819ffd40cf4f`, passed typecheck and the full
  test suite (215 PASS, 1 documented PostgreSQL skip).
