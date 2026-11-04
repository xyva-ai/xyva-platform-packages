# XYVA AI CLI – Implementierungsbericht Phase 3–4

Stand: 20. Oktober 2026  
Kandidat: **PARTIALLY_READY**

## Scope und Git-Nachweis

- Branch: `codex/ai-cli-adapters`
- Ausgangs-Commit: `ad299b9257cb0ffaa381e61a98d5b25478eba0b8`
- Implementierungs-Commit: `74c87e94df6bd4f034e81d25a281551118eadba2`
- Keine Deployments, Veröffentlichungen, Provider-Session-Dateien oder
  produktiven Konfigurationen wurden verändert.

## Implementierte Komponenten

| Komponente | Ergebnis |
| --- | --- |
| Interne Registry | `CliAdapterRegistry` registriert Codex, Claude Code und Gemini als produktneutrale CLI-Adapter. Sie erzeugt nur Status und erteilt keine Produktberechtigung. |
| Discovery | Ausschließlich `--version`; Codex ergänzt den dokumentierten, nichtinteraktiven `login status`. Keine Modellanfrage, kein Login, kein Lesen von OAuth- oder Session-Dateien. |
| Version-Management | `CliVersionManager` hat eine lokale Kompatibilitätsmatrix, Mindestversionsvergleich, Update-Status und offizielle Installations-/Update-Hinweise. Es gibt keinen Netz-Check und keine Update-Mutation. |
| Agent CLI | Neu: `provider cli status [--json]` und `provider cli doctor`. Die Ausgabe enthält keine Prompts, Keys, Tokens, Sessions, stderr oder Rohkonfiguration. |
| Codex-Pilot | Implementierter, aber default-off Inferenzpfad: feste `codex exec`-Argumente, stdin-Prompt, neues temporäres Arbeitsverzeichnis, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--sandbox read-only`, JSONL-Normalisierung, Output-Grenze, Timeout und Abbruch. |
| Prozessgrenze | Kein Shell-Start; `spawn(..., { shell: false })`, minimaler Environment-Allowlist, begrenzte stdout/stderr-Puffer, SIGTERM/SIGKILL-Fallback und maximale Laufzeit. |

Der reale Codex-Inferenzpfad verlangt zusätzlich
`XYVA_AGENT_ENABLE_CODEX_CLI_TEST_MODE=1`. Ohne dieses explizite interne
Test-Gate wird er vor Prozessstart abgelehnt. Das Gate ersetzt keine
anbieterrechtliche Freigabe.

## Tatsächlich geänderte Dateien

- `packages/agent/src/providers/cli-types.ts`
- `packages/agent/src/providers/cli-version-manager.ts`
- `packages/agent/src/providers/cli-process-runner.ts`
- `packages/agent/src/providers/cli-adapters.ts`
- `packages/agent/src/providers/cli-registry.ts`
- `packages/agent/src/providers/index.ts`
- `packages/agent/src/cli.ts`
- `packages/agent/src/index.ts`
- `tests/backend/agent-cli-adapters.test.ts`
- `AI_CLI_CURRENT_STATE.md`, `AI_CLI_MIGRATION_PLAN.md`

`ProviderBridgeV1`, `contracts/providers/v1.ts`, Provider-Konfiguration,
Flow-Grants und QA-Studio-/Flow-Produktcode wurden nicht geändert.

## Funktionsstatus

| Anbieter | Discovery | Version | Auth-Status | Login | Inferenz |
| --- | --- | --- | --- | --- | --- |
| Codex | implementiert | implementiert | `codex login status` | offizieller `codex login --device-auth`-Launcher vorbereitet | technisch implementiert, default-off, kein realer Aufruf durchgeführt |
| Claude Code | implementiert | Matrix vorbereitet | nicht über undokumentierten Befehl abgefragt | bewusst nicht automatisiert | nicht implementiert |
| Gemini | implementiert | implementiert | nicht über undokumentierten Befehl abgefragt | bewusst nicht automatisiert | nicht implementiert |

Der lokale Smoke-Check (`provider cli status --json`) stellte fest: Codex
`0.162.1` installiert/authentifiziert und kompatibel; Gemini `0.64.0`
installiert/kompatibel, Auth-Status nicht geprüft; Claude nicht installiert.
Dies ist weder ein kommerzieller Freigabenachweis noch ein echter
CLI-Inferenztest.

## Testnachweise

| Prüfung | Status | Ergebnis |
| --- | --- | --- |
| Agent-Typecheck | PASS | `npm run typecheck --workspace @xyva/agent` |
| Neue Adapter-/Sicherheits-Tests | PASS | 5 Tests: Discovery, fehlende/ungültige Version, Test-Gate, feste Argumente/stdin/Environment, Timeout |
| Zielgerichtete Agent-Regression | PASS | 10 Dateien, 122 Tests: Provider Config/CLI/Bridge/Cancellation/API/Local/Security/V1 |
| Öffentliche Package-Regression | PASS | `npm run verify:public`: Build, Typechecks, 18 Dateien / 171 Tests |
| Lokaler Status-Smoketest | PASS | `node packages/agent/dist/cli.js provider cli status --json` und `doctor`; keine Inferenz ausgeführt |
| Flow Core | PASS | Lockfile-basierte Wiederherstellung, Build sowie 19 gezielte Provider-/Gateway-Tests |
| Flow Web | PASS | Lockfile-basierte Wiederherstellung, 2 Dateien / 42 gezielte Provider-/Connection-Tests |
| macOS echte CLI-Inferenz | SKIP | Compliance-Gate bewusst nicht geöffnet |
| Windows 11 | SKIP | Kein Windows-Host in dieser Ausführung |

Die Flow-Abhängigkeiten fehlten zuvor nur lokal (`node_modules` und damit
`tsc`/`vitest`). `npm ci` auf den vorhandenen Root- und Web-Lockfiles stellte
sie ohne Manifest- oder Lockfile-Diff wieder her. Der Web-Install-Audit meldete
eine bestehende moderate Abhängigkeitsschwachstelle; sie ist nicht Bestandteil
dieser Änderung und wurde nicht blind aktualisiert.

## Auto-Update-Fortschritt

Es existieren nur die sichere Vorstufe: Installations-/Versionsstatus,
Kompatibilitätsmatrix und offizielle Update-Hinweise. Nicht implementiert und
weiterhin verboten: automatische Updateprüfung über fremde Quellen,
unbeaufsichtigte Installation, Aktualisierung während Aufgaben, Rollback oder
Manipulation fremdverwalteter Installationen. Dafür ist die in
`AI_CLI_MIGRATION_PLAN.md` beschriebene Phase-5-Freigabe erforderlich.

## Auswirkungen auf QA Studio und Flow

Keine Runtime- oder Vertragsänderung: Beide Produkte verwenden unverändert
`ProviderBridgeV1`, API/BYOK und Local Mode. CLI-Discovery ist momentan nur
über den lokalen npm-Agenten sichtbar. Es wurden keine Produktgrants für CLI
eingeführt; damit kann weder Flow auf QA-Studio-Berechtigungen noch ein Produkt
automatisch auf eine CLI zugreifen.

## Verbleibende Blocker und nächste Schritte

1. Legal/Business muss den konkreten Codex-Testmodus und jede spätere
   kommerzielle Produktnutzung je Anbieter/Kontotyp freigeben.
2. Erst danach: echte Codex-Inferenz auf macOS mit dokumentiertem Nachweis;
   Windows 11 Discovery/Prozess-/PATH-Test auf einem realen Host.
3. Für Product-Exposition: einen separaten, versionierten V2-Vorschlag samt
   Connection-/Produktgrant-Modell prüfen; V1 bleibt unverändert.
4. Claude/Gemini-Inferenz nur nach eigenem Funktions- und Compliance-Gate.
5. Auto-Update als separat genehmigte Phase 5 mit Consent, Installationsowner,
   Idle-Gate, Integritätsprüfung und Recovery implementieren.
6. Den Session-Shim nicht entfernen, bevor seine echten Abhängigkeiten,
   Beobachtungszeit und ein separater, expliziter Decommission-Beschluss
   vorliegen.
