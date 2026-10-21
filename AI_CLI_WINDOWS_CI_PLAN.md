# XYVA AI CLI – GitHub-hosted Windows-CI-Plan

Stand: 21. Oktober 2026
Status: **vorbereitet, nicht ausgeführt**
Branch: `codex/ai-cli-adapters`
Hardening-Commit: `a86560b8f0e05c6397a902f24634dc883c9b66e9`

## Zweck und Abnahmegrenze

Dieser Plan ergänzt die fehlende native Windows-Server-Kompatibilitätsprüfung, ohne Proxmox zu verwenden. Ein späterer erfolgreicher Lauf auf einem GitHub-hosted Windows-Runner bestätigt nur Windows-Server-Codekompatibilität mit isolierten Fake-Prozessen. Er ersetzt weder eine echte Windows-11-Geräteabnahme noch die weiterhin geblockte Proxmox-Golden-Image-Abnahme.

Es wurden kein Push, kein Workflow-Run, kein Provider-Login, keine reale Provider-Inferenz, kein Deployment und keine Veröffentlichung ausgelöst.

## Neue CI-Konfiguration

Neu vorbereitet wurde [windows-cli-adapter.yml](.github/workflows/windows-cli-adapter.yml).

| Eigenschaft | Konfiguration |
| --- | --- |
| Auslösung | `workflow_dispatch` sowie ausschließlich `pull_request:labeled` für Same-Repository-PRs nach `main`, wenn das Label `ci:windows-cli` hinzugefügt wurde; kein Push-Trigger |
| Runner | GitHub-hosted `windows-2025`; ein zusätzlicher Boundary-Check verweigert andere Runner |
| Node | Node.js 22 über `actions/setup-node`; Node-/npm-Versionen werden erst danach in die Evidenz geschrieben |
| Berechtigungen | ausschließlich `contents: read` |
| Checkout | fest gepinnte `actions/checkout`-Revision, `persist-credentials: false`, flacher Checkout; bei PR-Label-Run explizit `github.event.pull_request.head.sha`, nie der synthetische PR-Merge-Commit |
| Installation | `npm ci --ignore-scripts --no-audit --no-fund` anhand des vorhandenen Lockfiles |
| Secrets / Environments | keine Referenz auf Repository-, Environment- oder Production-Secrets; keine Environments |
| Provider-CLIs | Boundary-Check verweigert vorinstallierte `codex`, `claude` oder `gemini`; keine CLI-Installation und kein Update |
| Testmodus | Workflow verweigert ein geerbtes `XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE`; Tests setzen ihren lokalen Fake-Zustand selbst |
| Infrastruktur | kein Proxmox-, Self-hosted-, SSH- oder Netzwerkinfrastruktur-Zugriff |
| Mutationen | kein Publish, kein Deployment, kein Merge und keine Release-Aktion |

Die verwendeten GitHub-Actions sind wie die bestehenden Workflows auf feste Commit-Revisionen gepinnt. Der Workflow besitzt keinen Trigger, der durch einen späteren Push automatisch einen Lauf startet. Vor Aufnahme der Workflow-Datei auf den Default-Branch ist `workflow_dispatch` in GitHub nicht als manueller Auslöseweg verfügbar. Der erste zulässige Auslöseweg ist daher der kontrollierte `pull_request:labeled`-Run auf dem Draft-PR; nach einer späteren, separat freigegebenen Aufnahme auf den Default-Branch bleibt der manuelle Dispatch ein zweiter autorisierter Pfad.

Der Job besitzt zusätzlich eine auswertbare Gate-Bedingung. Ein Label-Event führt den Testjob nur aus, wenn das gerade hinzugefügte Label exakt `ci:windows-cli` heißt, der PR gegen `main` gerichtet ist und `github.event.pull_request.head.repo.full_name` dem aktuellen Repository entspricht. Fork-PRs, andere Labels und andere Zielbranches ergeben keinen ausführbaren Job. `pull_request_target` wird nicht verwendet.

Für einen PR-Label-Run wird der Head-SHA als Checkout-Ref übergeben und unmittelbar mit `git rev-parse HEAD` gegen `github.event.pull_request.head.sha` geprüft. Damit wird nicht der von GitHub für `pull_request` normalerweise bereitgestellte synthetische Merge-SHA getestet. Der geprüfte SHA wird sowohl im Step Summary als auch in der Evidenzdatei festgehalten.

## Vorbereitete Testfälle

### Windows CLI und Prozessgrenze

`tests/backend/agent-cli-adapters.test.ts` wird auf dem Windows-Runner ausgeführt. Abgedeckt sind isolierte Fake-Prozesse für:

- fehlende und unzulässige CLI-Auflösung sowie PATH-Hijacking;
- lokale Versions-/Discovery-Normalisierung ohne Modellaufruf;
- fail-closed ohne aktivierten CLI-Testmodus;
- Request-ID-basierte Cancellation, doppelte Cancellation, parallele Requests und Cleanup nach Absturz;
- Provider- und Gesamtparallelitätsgrenzen ohne Queue;
- Timeout, stdout-/stderr-Limits und geheimnisfreie Fehlermeldungen;
- Windows-spezifischer Parent-/Kindprozess-Test über den `taskkill`-Codepfad;
- sichere Ablehnung eines PATH-vorangestellten npm-`.cmd`-Shims ohne `shell: true`.

Der `.cmd`-Test ist bewusst ein Negativtest. Die aktuelle Implementierung akzeptiert nur kanonische `.exe`-/`.js`-Ziele und unterstützt keinen npm-`.cmd`-Shim. Das ist eine dokumentierte Kompatibilitätslücke, kein umgangener Sicherheitsmechanismus.

### Foundation- und Provider-Grenzen

Der Workflow führt zusätzlich folgende geheimnisfreie Testgruppen aus:

```text
tests/backend/agent-ai-cloud-providers.test.ts
tests/backend/agent-ai-local-providers.test.ts
tests/backend/agent-provider-bridge.test.ts
tests/backend/agent-provider-config.test.ts
tests/backend/agent-product-origins.test.ts
tests/backend/provider-contracts-v1.test.ts
tests/backend/provider-bridge-client-v1.test.ts
tests/backend/agent-security-hardening.test.ts
```

Danach läuft `npm run verify:public` (Build, Typechecks und öffentliche Package-Tests). Damit werden Local-/BYOK-Verträge, credential-freie Bridge-Grenzen, Product-Origins/Grants und die öffentlichen Paketverträge regressiv geprüft. Es wird keine echte API-/BYOK-Provider-Verbindung benötigt.

## Lokal ausgeführte Vorbereitung

| Befehl | Ergebnis |
| --- | --- |
| YAML-Strukturprüfung des Workflows | PASS |
| 9 gezielte Adapter-/Provider-/Security-Testdateien | PASS – 129 Tests, 2 erwartete Windows-SKIPs auf macOS |
| `npm run verify:public` | PASS – 18 Dateien, 171 Tests |

Dies sind macOS-Lokalnachweise der Testvorbereitung, **keine Windows-CI-Ergebnisse**.

## Nach einem ausdrücklich freigegebenen Push und Label-Run

1. Den gezielten Workflow-Commit lokal prüfen und erst nach gesonderter Freigabe ausschließlich `codex/ai-cli-adapters` pushen.
2. Einen Draft-PR aus demselben Repository von `codex/ai-cli-adapters` nach `main` erstellen. Weder den Branch noch `main` mergen.
3. Den vollständigen PR-Head-SHA notieren, dann ausschließlich das Label `ci:windows-cli` hinzufügen. Ein normales PR-Öffnen oder ein Push löst diesen Workflow nicht aus.
4. Der Label-Run checkt exakt den PR-Head-SHA aus. Im Evidenzbericht erfassen: Workflow-Run-ID, vollständiger `tested_sha` aus Summary/Evidenzdatei, Windows-Image-/Buildnummer, Node-/npm-Version, alle PASS/FAIL/SKIP, Prozessbaum-Nachweis und den `.cmd`-Status.
5. Bei einem fehlenden/unerwarteten Provider-CLI-Binary, einem Geheimnis im Runner oder einem nicht-GitHub-hosted Runner muss der Workflow fehlschlagen; keine Umgehung durch Installation, Login oder ein anderes Runner-Label.
6. Das Ergebnis weiterhin getrennt von Windows-11-Gerät und Proxmox-Golden-Image bewerten.

## Erwartete CI-Evidenz und Artefaktspeicher

Der Run erzeugt ausschließlich die geheimnisfreie Datei `windows-cli-evidence.txt`. Sie enthält den tatsächlich ausgecheckten `tested_sha`, Runner-OS/-Umgebung, Runner-Image/-Version, Windows-Caption/-Version/-Build sowie die erst nach `actions/setup-node` erfassten Node- und npm-Versionen. Dieselben Angaben stehen im Step Summary. Nach den Tests wird die Datei mit siebentägiger Aufbewahrung als `windows-cli-evidence-<tested_sha>` hochgeladen; Testausgaben, Umgebungsvariablen, Sessiondateien und Provider-Credentials werden nicht als Artefakt exportiert.

Ist der GitHub-Artefaktspeicher erschöpft, wird der Artefakt-Upload als expliziter Acceptance-Fail ausgewiesen: Der finale Evidenzschritt schlägt fehl, auch wenn die Testschritte zuvor erfolgreich waren. Die unmittelbar im Run vorhandene Step Summary und die Job-Logs sichern, den Upload-Warnhinweis und die Speicherkapazität dokumentieren und erst nach Bereinigung oder Erhöhung des Artefaktlimits einen erneuten Label-Run ausführen. Keine Geheimnisse, Logs oder Sessiondateien zur Umgehung extern speichern.

## Reproduktion auf dem späteren Runner

Der Workflow führt äquivalent aus:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npx vitest run tests/backend/agent-cli-adapters.test.ts
npx vitest run tests/backend/agent-ai-cloud-providers.test.ts tests/backend/agent-ai-local-providers.test.ts tests/backend/agent-provider-bridge.test.ts tests/backend/agent-provider-config.test.ts tests/backend/agent-product-origins.test.ts tests/backend/provider-contracts-v1.test.ts tests/backend/provider-bridge-client-v1.test.ts tests/backend/agent-security-hardening.test.ts
npm run verify:public
```

Der Workflow setzt dabei diese Sicherheitsgrenzen durch: `windows-2025`, Node.js 22, GitHub-hosted Runner, `contents: read`, kein `pull_request_target`, kein Environment, keine Repository-/Environment-Secrets, kein Provider-Login/-Aufruf/-Update, kein Zugriff auf Sessiondateien, keine Proxmox- oder Self-hosted-Verbindung, keine Credentials-Installation, kein Publish, kein Deployment und kein Auto-Update.

## Auswirkungen und verbleibende Gates

- `ProviderBridgeV1`, Flow, QA Studio, Local Mode, BYOK, Produktgrants und die Provider-Runtime bleiben unverändert.
- Der CI-Workflow ist keine Änderung an der produktiven Foundation und erzeugt keine Runtime-Abhängigkeit.
- Windows-11-Hardware-/Gerätenachweis, sichere produktive `.cmd`-Launcher-Strategie, reale Provider-Compliance und die Proxmox-Golden-Image-Abnahme bleiben offen.
- GitHub-hosted `windows-2025` beweist Windows-Server-Kompatibilität, jedoch weder Windows-11-Geräteverhalten noch die durch den Proxmox-Preflight geblockte, isolierte Golden-Image-Umgebung.
- Bis echte Windows-Nachweise vorliegen, bleibt die Gesamtklassifikation `BLOCKED`.

## Tatsächlich angepasste Dateien

- `.github/workflows/windows-cli-adapter.yml` – GitHub-hosted Windows-Workflow mit manuellem und eng begrenztem Same-Repository-PR-Label-Trigger.
- `tests/backend/agent-cli-adapters.test.ts` – Windows-only Negativtest für unsichere npm-`.cmd`-Launcher sowie plattformgetreuer PATH-Hijack-Test.
- `AI_CLI_WINDOWS_CI_PLAN.md` – dieser Plan.

Die vorher vorhandenen, bewusst uncommitteten Acceptance-/Hardening-/Windows-Berichte wurden nicht überschrieben oder committed.
