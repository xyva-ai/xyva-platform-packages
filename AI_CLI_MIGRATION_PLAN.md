# XYVA AI CLI – Zielarchitektur und priorisierter Migrationsplan

Stand: 20. Oktober 2026. Dies ist ein Umsetzungsplan, keine
Implementierungsfreigabe. Alle CLI-Provider beginnen deaktiviert.

## Entscheidung

`@xyva/agent` bleibt der einzige lokale Ausführungsprozess. Er erhält eine
Provider-Connection-Schicht mit drei ausdrücklich getrennten Modi:

```text
Produkt (QA Studio / Flow)
  -> versionierter, credential-freier Provider-Bridge-Vertrag
  -> @xyva/agent: policy + product/workspace grant + connection selection
      -> LocalConnection (Ollama | LM Studio)
      -> ApiConnection   (OpenAI | Anthropic | Gemini, BYOK)
      -> CliConnection   (Codex | Claude Code | Gemini CLI, feature-flagged)
```

Der Browser erhält Status, freigegebene Capability und Testresultate, aber
keine Provider-Credentials, Token, CLI-Konfiguration oder Roh-Subprozessausgabe.
Core bleibt Eigentümer von Identität, Workspace und Produktentitlements;
der Agent speichert nur eine lokale Connection-Referenz und lokale
Nutzereinwilligung. QA Studio und Flow teilen damit dieselbe Infrastruktur,
besitzen aber getrennte Product Grants. Es entsteht weder ein zweiter Agent
noch ein lokaler HTTP-Proxy.

## Kompatible Vertragsstrategie

`ProviderBridgeV1` bleibt unverändert les- und ausführbar für Local- und
BYOK-Verbindungen. Seine exact-key Validatoren sind ein Schutzmechanismus.

Eine neue `ProviderBridgeV2` wird nur eingeführt, wenn CLI-spezifische Daten
transportiert werden müssen. Sie enthält statt eines API-Provider-Strings eine
`connectionId`, eine deklarierte `connectionMode` (`local`, `api`, `cli`),
Capability- und Readiness-Snapshot sowie dieselben begrenzten Operationen
`listModels`, `infer`, `cancel`. Provider-spezifische CLI-Argumente oder
Credentials gehören nicht in V2. V1 und V2 laufen parallel; Flow/QA Studio
migrieren per Capability Negotiation. Falls V1 für eine erste Codex-Ausführung
ausreicht, wird V2 erst dann angelegt, wenn ein konkreter UI-/Policybedarf es
erzwingt.

## Adapter-Schnittstelle

Im Agenten wird eine intern bleibende Schnittstelle eingeführt:

```ts
interface ProviderConnectionAdapter {
  discover(): Promise<DiscoveryStatus>
  beginLogin(): Promise<LoginLaunchResult>
  getReadiness(): Promise<ConnectionReadiness>
  listModels(): Promise<BoundedModelList>
  infer(request: BoundedInference, signal: AbortSignal): Promise<BoundedResult>
  update?(request: ApprovedUpdate): Promise<UpdateResult>
}
```

Jeder CLI-Adapter verwendet `spawn`/`execFile` mit festem Programm und
Argumentarray, niemals eine Shell. Er arbeitet mit einem neu angelegten,
restriktiven Task-Verzeichnis, minimalem Environment, explizitem Arbeits-
verzeichnis, begrenztem stdin/stdout/stderr, Timeout, Abbruch mit geordnetem
Terminate/Kill, maximaler Prozesszahl und einer per Adapter erlaubten
Argument-/Funktionsliste. Standard ist read-only bzw. no-tools/sandboxed, soweit
die offizielle CLI das unterstützt; jeder Schreib-/Shellzugriff braucht eine
separate später freigegebene Produktpolicy. Logs werden strukturiert redigiert;
vollständige Prompt-/Antwortinhalte und CLI-Konfiguration werden nicht
protokolliert.

## Compliance-Gate vor Codepfad

| Anbieter | Offiziell belegte Lage | Geplante Haltung |
| --- | --- | --- |
| OpenAI Codex | Offizieller lokaler CLI-Login existiert; der Sign-in kann eine API-Organisation/Key-Verknüpfung betreffen. Anwendbare Bedingungen hängen vom Konto-/Business-Vertrag ab. | Keine Session-Datei lesen. Erst nach Legal-Review eines konkreten „lokaler, user-initiated CLI task“-Modells aktivieren; kein allgemeines API-Shim. |
| Claude Code | Unterstützt Console/API, Claude-App-Plan und Enterprise-Backends; Anthropic trennt Consumer- und Commercial Terms. | Default-off bis Produkt, Kontoart und erlaubte Headless-/Automationsform schriftlich geklärt sind. API-Mode bleibt der planbare kommerzielle Weg. |
| Gemini CLI | Offizielle Dokumentation untersagt Dritttools, die CLI-OAuth für direkten Zugriff auf Backends nutzen. API-Key/Vertex folgen eigenen Bedingungen. | OAuth-basierter XYVA-Adapter bleibt deaktiviert. Nur ein ausdrücklich dokumentierter, erlaubter CLI-Automationsmodus könnte nach Legal-Freigabe aktiviert werden; BYOK/Vertex bleibt unabhängig. |

Diese Einordnung ist eine technische Risikoentscheidung, keine Rechtsberatung.
Vor Freigabe sind die jeweils aktuellen Vertragsversionen, Accounts, Regionen,
Datenschutz/DPA und das konkrete Ausführungsmodell durch Legal/Business Owner
zu dokumentieren. Feature Flags müssen die Default-Sperre server- und
agentenseitig erzwingen.

Primärquellen der Aufnahme: [OpenAI Codex CLI/Login](https://help.openai.com/en/articles/11381614-api-codex-cli-and-sign-in-with-chatgpt),
[OpenAI Codex-Planbedingungen](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan),
[Anthropic Legal](https://www.anthropic.com/legal),
[Claude-Code-Authentifizierung](https://docs.anthropic.com/en/docs/claude-code/getting-started)
und [Gemini CLI Terms/Privacy](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md).

## Änderungen je Repository

| Repository | Geplante Änderung | Priorität |
| --- | --- | --- |
| `xyva-platform-packages` | Adapter-Registry, connection store ohne OAuth-Import, Discovery, Prozess-Runner/Policy, V1-Erweiterung nur wo kompatibel bzw. V2, CLI-Kommandos, Tests | P0 |
| `qa-studio` | Gemeinsame Provider-UI auf Mode/Discovery/Login/Test/Product grant umstellen; keine parallele Persistenz | P0 |
| `xyva-flow` | vorhandene Bridge als untrusted edge erhalten, V2 nur nach Vertrag; Flow-spezifische Entitlement-/Grant-Prüfung erweitern | P0 |
| `xyva-platform-core` | nur wenn zentrale Produkt-/Workspace-Grant-Policy benötigt wird; keine CLI-Ausführung und keine Secrets | P1 |
| `qa-studio/codex-proxy-mvp` | Inventar/Abhängigkeitsnachweis, default-off, dann separate Archiv-/Löschentscheidung | P1, destruktiv nur separat |
| `xyva-product-hub` | keine Änderung ohne späteren realen Consumer-Nachweis | P2 |

### Voraussichtliche Dateien im Foundation-Paket

- Neu: `packages/agent/src/providers/{adapter,connection-store,discovery,
  process-runner,policy,updates}/…` und passende Tests.
- Ändern: `packages/agent/src/config.ts`, `provider-cli.ts`, `cli.ts`,
  `bridge/register-handlers.ts`, `services/ai-facade.ts` (nur als API/Local-
  Adapter oder Facade-Delegator), Exporte sowie Produkt-/Socket-Policy.
- Prüfen/gegebenenfalls neu: `packages/contracts/src/providers/v2.ts` und
  `packages/bridge-types/src/provider-bridge-v2.ts`. V1-Dateien bleiben
  rückwärtskompatibel.
- QA Studio: `AiProviderSettings.tsx`, globale Agent-Typen, Settings-Aufrufer
  und Komponenten-/Backend-/E2E-Tests.

## Migrationsreihenfolge und Abnahmekriterien

1. **Freeze und Inventar (0,5 Tag):** Session-Shim nicht deployen, Caller und
   Container ermitteln, keine Auth-Datei lesen/kopieren/löschen. Ingress und
   Flags dokumentieren.
2. **Connection-/Policy-Fundament (1–1,5 Tage):** Modell und Store einführen,
   bestehendes Local/API unverändert durch Regression beweisen, V1-Kompatibilität
   festschreiben.
3. **Discovery (1 Tag):** Codex, Claude, Gemini auf macOS/Windows via sichere
   Kandidaten und Installationsprovenienz erkennen. Status enthält Installed,
   Version, PATH/Reachability, unterstützter Versionsbereich, Update-Owner,
   Auth-Status nur über unterstützte CLI-Befehle und Ready-Reason. Kein Lesen
   eines Credential-Stores.
4. **Codex-Pilot (1–1,5 Tage):** Nur nach Compliance-Gate einen begrenzten,
   offiziellen, nicht-interaktiven Inferenzpfad implementieren. Echte CLI-
   Inferenz, Abbruch, Timeout, Prozessisolation und UI-Test beweisen.
5. **UI und Grants (1–1,5 Tage):** Achtstufiger Wizard: Anbieter, Mode,
   Umgebung, Installation/Verbinden, offizieller Login, Capability/Modell,
   Test, Produktfreigabe. QA Studio und Flow konsumieren denselben Agenten-
   Status; die Freigabe ist pro Produkt/Workspace/Connection.
6. **Update-Management (1,5–2 Tage):** Als eigenes `AI_CLI_UPDATE_DESIGN.md`
   in Phase 5 spezifizieren und dann implementieren: Installationsprovenienz,
   Matrix, Consent, Idle-Gate, offizieller Updater, Nachtest, Failure-Disable
   und ggf. klar begrenztes Rollback. Fremdverwaltete Installationen werden
   ausschließlich gemeldet, nie überschrieben.
7. **Claude/Gemini (je 1–1,5 Tage):** Nur nach individueller Provider- und
   Legal-Freigabe; sonst als sichtbar deaktivierte Option mit nachvollziehbarem
   Grund belassen.
8. **Cutover/Beobachtung (mindestens 1 Tag):** Bestehende API/Local-Nutzer
   unangetastet lassen, alte Session-Konfiguration nur erkennen, niemals
   importieren. Nach akzeptierter CLI-Nutzung neue Session-Shim-Trafficwege
   stoppen; erst nach Observation und expliziter Freigabe archivieren/löschen.

## Teststrategie

Automatisiert: Contract-Fuzzing V1/V2, Adapter-Simulation, Argument-/Environment-
Allowlist, Pfad-/Shell-Injection, stdout/stderr Grenzen, Timeout/Cancel,
Gleichzeitigkeit, Log-Redaction, Connection-/Product-/Workspace-Isolation,
Migration ohne Session-Lesen, Update-Owner/Idle/Recovery und UI-State-Tests.

Echt: pro Plattform und freigegebenem Anbieter Installation, Discovery, Login,
Version, eine beschränkte Inferenz, Fehler, Abbruch, Update und Recovery. Auf
Windows 11 zusätzlich PowerShell/PATH/nicht-administrative Installation; auf
macOS Gatekeeper/Quarantine, PATH aus GUI/Terminal und Keychain-/Dateiboundary.
QA Studio und Flow benötigen jeweils ein sichtbares Produkt-Grant und eine
Ende-zu-Ende-Testinferenz. Ein Prozessstart, ein erfolgreiches Login oder eine
grüne Unit-Suite allein gilt nicht als Abnahme.

## Aufwand, Risiko und Freitagsentscheidung

Die vollständige Drei-Anbieter-Migration einschließlich legaler Klärung,
Update/Recovery sowie macOS- und Windows-Echtprüfungen ist vor Freitag,
23.10.2026 nicht belastbar fertigstellbar. Realistisch bis dahin, ohne den RC
zu gefährden: Architektur/Contracts, ein default-off Codex-Pilot hinter Flag,
automatisierte Sicherheits-/Regressionstests und macOS-Evidence – vorausgesetzt
Legal-/Account-Freigabe und ein reproduzierbares offizielles CLI-Interface liegen
sofort vor. Claude, Gemini, Windows und Auto-Update sollten nicht in die
Foundation-Abnahme eingeschleust werden.

Der Release-Plan lautet deshalb: Bestehenden API-/Local-Mode unverändert
abnehmen; CLI-Flags in Produktion aus lassen; neue Arbeit auf einen eigenen
`codex/ai-cli-adapters`-Feature-Branch; vor Merge unabhängiges Security Review
und reale Plattformnachweise. Bei Nichterreichen eines Gates wird die CLI-
Funktion deaktiviert, nicht auf den Session-Shim zurückgefallen.

## Offene Entscheidungen vor Implementierung

1. Legal/Business Owner: Welche Anbieter-/Kontotyp-/CLI-Kombination ist für
   welchen XYVA-Produktfall ausdrücklich zulässig?
2. Product Owner: Soll ein CLI-Modus nur user-initiierte lokale Coding-Aufgaben
   oder automatisierte Produkt-Workloads tragen? Letzteres benötigt sehr
   wahrscheinlich API-/Enterprise-Verträge statt Subscription-CLI.
3. Security Owner: Welche maximalen Arbeitsverzeichnisse, Toolrechte und
   Netzwerkegress sind je Produkt zulässig?
4. Release Owner: Wird der schrittweise Codex-Pilot außerhalb des Foundation-RC
   freigegeben, oder bleibt bis nach der Gesamtabnahme alles CLI-bezogen aus?
