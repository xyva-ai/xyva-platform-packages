# XYVA CLI Cross-Platform Test Report

| Scope | Result | Evidence |
|---|---|---|
| macOS local discovery/status/doctor/update guidance | PASS | Codex 0.162.1 discovered; Claude missing; Gemini 0.64.0 discovered; no login/inference/update |
| macOS adapter and bridge tests | PASS | 28 passed, 2 documented platform skips |
| Platform Packages hosted checks | PASS | Run 41793971112, Node 22 and Node 24 |
| QA Studio portal build | PASS | Next build with bridge-browser package built first |
| QA Studio portal browser identity test | PASS | 14 passed |
| QA Studio hosted CI first attempt | FAIL, corrected | Run 41793691520; cleanup race at agent-cli-adapters.test.ts:289 |
| QA Studio hosted CI follow-up | PENDING_FINAL_OBSERVATION | Run 41794208174 |
| Windows Server CLI compatibility | BLOCKED | Existing PR #16 Windows security failures remain separate |
| Native Windows 11 | NOT_EXECUTED | No trusted Windows 11 target was used |
| Flow CLI E2E | NOT_EXECUTED | No confirmed current product scope |
| Real provider inference | NOT_EXECUTED | Explicitly prohibited without separate authorization |

