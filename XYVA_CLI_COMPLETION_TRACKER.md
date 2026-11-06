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
| CLI-08 | Native Windows 11 CLI | platform-packages | VERIFIED (bounded native scope) | QA Studio PR #139 head `7fcc8dbe`; Windows run `42086602294` tested platform source `1bbe3b3`; Windows 11 build 26200, parent-swap 4/4 PASS, CLI 16 PASS/1 SKIP, secure-store 5 PASS | full product release still requires independent review and provider compliance |
| CLI-09 | QA Studio product/browser E2E | qa-studio | VERIFIED (hosted scoped) | Draft PR #139 head `7fcc8dbe`; CI run `42087866196` PASS for agent, security, docs and portal E2E | authenticated live-agent/provider session remains external |
| CLI-10 | Flow integration | xyva-flow | VERIFIED (local and hosted scoped) | Draft PR #53 head `fda07b4`; CI run `42089776798` PASS on Node 22/24, web, public-export, container and PostgreSQL integration; CLI adapter remains opt-in | authenticated runtime agent pairing and production composition remain external |
| CLI-11 | Entitlements, grants and audit | platform-packages | PARTIAL | non-secret per-provider local grant + QA capability contract; bridge rejects missing/revoked grants | product identity/licensing integration and independent audit review pending |
| CLI-12 | Provider compliance | cross-provider | PARTIAL | documented operational boundary; default deny and no session extraction | current provider terms and real execution mode must be independently verified |
| CLI-13 | Release candidate evidence | cross-repository | VERIFIED (scoped) | platform PR #24 head `1bbe3b3`, run `42089125348`; QA Studio PR #139 head `7fcc8db`, run `42087866196` plus native run `42086602294`; Flow PR #53 head `fda07b4`, run `42089776798` | human review, provider compliance and production authorization remain |

## Current external gates

- Native Windows 11 is evidenced only for the bounded CLI/secure-store suites
  on VM 100; this is not a blanket product or provider acceptance.
- QA Studio and Flow now have passing hosted integration evidence on their draft
  branches; reviewed release composition and authenticated runtime pairing are
  still required before production use.
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
- Platform Packages draft PR #24 head `1bbe3b3775a7a230572c9d7f947161a0702aca4e`:
  discovery/auth boundary and Windows parent-swap PowerShell fallback. Public
  verification run `42089125348` completed successfully on Node 22 and Node 24.
- QA Studio draft PR #139 head `7fcc8dbe0afcfe47e1f49fbd0984eefb5e3f8321`:
  native run `42086602294` PASS and standard CI run `42087866196` PASS. Native
  evidence is bounded and synthetic; it does not prove a live provider session.
- Flow draft PR #53 head `fda07b4249837fd7efb83ac75aef7ce419f7d30f`:
  hosted CI run `42089776798` PASS across Node 22/24, web, public export,
  container and PostgreSQL integration.
- Platform Packages PR #16 head `1628bb47ecb7c8c02532ddfd92eb075486da340a`:
  Windows Server 2025 Node 22 run `41797366842` completed PASS, including the
  Windows fake-process suite, provider-boundary regressions, public build,
  typecheck, regression and complete evidence gate.
- Platform Packages local implementation commit `30494bf8034123f249d539f48d993ba42c7754cb`:
  Gemini fixed-profile adapter tests, signed lifecycle manager tests, status
  integrity/rollback fields, and explicit Flow composition boundary. Local
  targeted adapter/lifecycle tests passed (20/20), bridge contract tests passed
  (15/15), and `npm run verify:public` passed (190 passed, 5 documented skips).
