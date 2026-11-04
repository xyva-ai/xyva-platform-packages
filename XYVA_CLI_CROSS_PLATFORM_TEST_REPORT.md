# XYVA CLI Cross-Platform Test Report

| Scope | Result | Evidence |
|---|---|---|
| macOS local discovery/status/doctor/update guidance | PASS | Codex 0.162.1 discovered; Claude missing; Gemini 0.64.0 discovered; no login/inference/update |
| macOS adapter and bridge tests | PASS | 28 passed, 2 documented platform skips |
| Platform Packages hosted checks | PASS | Run 41798674199 on head `14bb234`, Node 22 and Node 24 |
| QA Studio portal build | PASS | Next build with bridge-browser package built first |
| QA Studio portal browser identity test | PASS | 14 passed |
| QA Studio hosted CI | PASS | Run 41794619559 on head `158adabb`; agent, security, docs and portal E2E |
| Windows Server CLI compatibility | PASS (hosted scoped) | Run 41797366842 on PR #16 head `1628bb47`; Windows Server 2025 Node 22 |
| Native Windows 11 | NOT_EXECUTED | No trusted Windows 11 target was used |
| Flow CLI E2E | NOT_EXECUTED / out of confirmed scope | Flow Alpha exposes a contract-only bridge and no workflow execution path |
| Real provider inference | NOT_EXECUTED | Explicitly prohibited without separate authorization |

