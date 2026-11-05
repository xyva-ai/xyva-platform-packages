# XYVA AI CLI – Ist-Zustand

Stand: 20. Oktober 2026. Diese Bestandsaufnahme beruht auf den lokalen
Checkouts; sie gibt keine Secrets, Pfade zu realen Credential-Dateien oder
Tokenwerte wieder.

## Kurzfazit

Der aktive, veröffentlichungsfähige Kern in `xyva-platform-packages` ist
bereits ein sauber abgegrenzter lokaler Agent mit fünf Provider-Backends:

| Betriebsart | Anbieter | Tatsächliche Implementierung | Status |
| --- | --- | --- | --- |
| Local | Ollama, LM Studio | feste Loopback-Endpunkte im Agenten | aktiv |
| API/BYOK | OpenAI, Claude, Gemini | direkte offizielle HTTP-APIs mit lokal gespeichertem API-Key | aktiv |
| CLI | Codex, Claude Code, Gemini CLI | keine Adapter, Discovery oder CLI-Login-Integration | nicht implementiert |
| OAuth-Session-Shim | Codex | separater Docker-Prototyp in QA Studio | experimentell/Legacy, nicht Foundation |

Der beobachtete Session-Shim ist nicht Bestandteil der aktiven
`@xyva/agent`-Laufzeit. Er liegt unter `qa-studio/codex-proxy-mvp`, ist ein
getrackter 11-Dateien-Prototyp und darf weder in Flow noch in den Agenten
übernommen werden. Die vorhandene Foundation selbst liest keine
Anbieter-OAuth-Datei: `checkOAuth` und `startBrowserAuth` geben ausdrücklich
`NOT_IMPLEMENTED` zurück.

## Repositories und Arbeitsstände

| Repository | Branch / lokaler Zustand | Einordnung für diese Migration |
| --- | --- | --- |
| `xyva-platform-packages` | `main`, sauber | maßgebliche, veröffentlichungsfähige Agent-, Vertrags- und Bridge-Quelle |
| `qa-studio` | `codex/docs-search-cleanup-20261016`, sauber | Portal-/Agent-Konsument; enthält außerdem den separaten Prototypen |
| `xyva-flow` | `main`, sauber | produktgetrennte Provider-Bridge-Integration und Berechtigungsmodell |
| `xyva-platform-core` | `main`, sauber | Workspace, Rollen, Entitlements und Integration Grants; keine Provider-Ausführung |
| `xyva-product-hub` | `codex/b2b-accessibility-hardening`, sauber | in der Suche keine AI-Provider-, OAuth- oder Proxy-Laufzeit gefunden |

Bei der Aufnahme waren keine uncommitteten Quelländerungen in diesen
Checkouts vorhanden. Build-Ausgaben der später beschriebenen Prüfungen sind
ignoriert und hinterlassen keinen Git-Diff.

## Aktiver Agent und Verträge

### Routing, Konfiguration und Geheimnisse

- `packages/contracts/src/providers/v1.ts` definiert die festen IDs
  `ollama`, `lmstudio`, `openai`, `claude`, `gemini`, die Capability-Liste und
  strikt validierte, credential-freie Anfragen/Antworten.
- `packages/agent/src/config.ts` hält Default-Modelle, die gewählte Provider-ID
  und API-Keys lokal. Cloud-Keys werden versiegelt gespeichert; die Konfigurations-
  datei wird privat geschrieben. Für Flow gibt es explizite, providerbezogene
  Freigaben.
- `packages/agent/src/provider-cli.ts` erlaubt nur eine maskierte TTY-Eingabe
  für BYOK-Keys, verifiziert sie über Model Discovery und nimmt keinen Key als
  Kommandozeilenargument an.
- `packages/agent/src/services/ai-facade.ts` nutzt ausschließlich feste
  `127.0.0.1`-Endpunkte für Ollama/LM Studio und die offiziellen HTTPS-Endpoints
  für OpenAI, Anthropic und Gemini. Es begrenzt Eingabe/Ausgabe, Gleichzeitigkeit
  und Rate, besitzt Timeout, Abbruchsignal und Idempotenzschutz.

### Bridge und Produktgrenzen

- `packages/agent/src/bridge/register-handlers.ts` löst Credentials erst im
  Agenten auf. Browser und Produkte übermitteln über `ProviderBridgeV1` weder
  Key noch Endpoint noch Session.
- `packages/bridge-types/src/provider-bridge-v1.ts` ist der lokale,
  credential-freie Clientvertrag. Er validiert Request und Resultat und
  unterstützt List, Infer und Cancel.
- Für Flow wird der Zugriff auf eine Provider-ID zusätzlich über die
  `flowProviderGrants`-Konfiguration und den verbundenen Socket kontextgebunden
  entschieden. Preview-Ausführung besitzt einen kleinen Output-Grenzwert.
- `xyva-flow/src/adapters/provider-bridge-model-provider.ts` behandelt die
  Bridge als untrusted boundary und validiert Antworten erneut. Die Weboberfläche
  unter `apps/web/src/features/providers/FlowProviderWorkspace.tsx` ist ein
  Konsument der vorhandenen V1-Bridge, kein zweiter Provider-Store.
- `xyva-platform-core/src/contracts.ts` besitzt Workspace-Rollen,
  Produkt-Entitlements und Integration Grants, aber keinerlei Provider-Key oder
  Anbieter-Session. Das ist die richtige Ownership für spätere zentrale
  Berechtigungsentscheidungen.

### Vorhandene Benutzeroberfläche

`qa-studio/landing-site/xyva-homepage/components/portal/AiProviderSettings.tsx`
stellt fünf einzelne Karten dar. Cloud-Karten verlangen API-Key und Modell,
Local-Karten nur ein Modell; sie können Modelle laden, Verbindung prüfen,
testen, abbrechen, speichern und löschen. Keys gehen per lokaler
WebSocket-Bridge an den Agenten und werden nicht an das Portal gesendet oder im
Browser gespeichert. Die UI kennt weder eine Connection-Art noch CLI-Discovery,
Login, Update oder Produktfreigabe für QA Studio.

## Tatsächlicher OAuth-Session-Prototyp

`qa-studio/codex-proxy-mvp` beschreibt sich selbst als Docker-first,
OpenAI-kompatiblen Codex-Session-Shim. Sein `proxy.js`:

1. liest und analysiert ein Codex-`auth.json`, sucht rekursiv Zugangstoken und
   leitet bei JWTs Ablaufzeit/Account-Anzeige ab;
2. kann ein bereitgestelltes Auth-Payload validieren, sichern und als aktive
   Container-Session schreiben;
3. ruft `codex exec --json` als „Refresh“ und für Prompts auf;
4. bietet mit selbst erzeugten internen `cpmvp_…`-Keys `/v1/models` und
   `/v1/responses` an und übersetzt die Ausgabe in ein OpenAI-ähnliches Format;
5. besitzt Warteschlange, Prozess-Timeout/Abbruch sowie eine Admin-Oberfläche.

Die Docker-Konfiguration persistiert den Codex-Zustand in `codex_state` und
konfiguriert `AUTH_FILE_PATH`, `CODEX_HOME` und `CODEX_CMD`. Das ist genau die
zu beendende Architektur: Aus einer Benutzer-CLI-Sitzung wird ein lokaler,
allgemeiner HTTP-Quoten-/API-Shim. Es wurden keine tatsächlichen Auth-Dateien
gelesen und keine Sessions verändert.

Der Prototyp enthält nur Codex; es wurden keine analogen Claude- oder Gemini-
Session-Proxies gefunden. Seine README fordert zwar internes Netzwerk, aber das
ändert weder die Credential-Übernahme noch die Produkt-/Nutzergrenzen. Seine
Syntaxprüfung besteht; daraus folgt ausdrücklich keine Betriebs- oder
Sicherheitsfreigabe.

## Bereits nutzbare Bausteine

- Die lokale Agenten-Distribution, authenticated loopback WebSocket und
  `ProviderBridgeV1`.
- Strenge Eingabe-/Ausgabevalidierung, Abbruch, Idempotenz, Rate/Gleichzeitigkeit
  und geheimnisfreie Fehler an der Produktgrenze.
- BYOK- und Local-Mode einschließlich Flow-Grant und Provider-Test-Inferenz.
- Flow-Entitlement-/Pairing-Grenzen und der Core-Workspace-/Grant-Domänenkern.
- Vorhandene UI-Karte sowie ihre Backend-/Komponententests als Ausgangspunkt.

## Fehlende oder zu ersetzende Teile

- Kein `CliAdapter`, keine sichere Prozess-Policy, Discovery, Login-Orchestrierung,
  Capability-Ermittlung, versionierte Kompatibilitätsmatrix oder Update-Manager.
- V1 modelliert nur `cloud` und `local-loopback`; CLI ist darin absichtlich nicht
  ausdrückbar. Die exakten V1-Validatoren dürfen deshalb nicht still erweitert
  werden.
- Die UI bietet keine achtstufige Auswahl/Prüfung und keine produktübergreifende
  Connection-Verwaltung.
- QA Studio besitzt zwar die Foundation-nahe UI, aber kein explizites
  Produkt-Grant-Pendant zu Flow.
- Die Prototyp-Routen, Auth-Import, Token-Parsing, Refresh und der
  OpenAI-kompatible Session-Shim müssen nach erfolgreicher Migration kontrolliert
  deaktiviert und erst nach Abhängigkeitsprüfung separat archiviert/entfernt
  werden.

## Tests und Nachweise

Im Foundation-Checkout existieren zielgerichtete Tests für Local-/Cloud-
Provider, Konfiguration, maskierte CLI-Key-Eingabe, Bridge, Cancellation und
V1-Contracts. Nach dem lokalen Build von Contracts, Bridge Types und Agent
liefen acht betroffene Testdateien mit **75/75** Tests erfolgreich.

Die erste Testausführung scheiterte erwartbar vor dem Workspace-Build an nicht
auflösbarem `@xyva/contracts`; dies ist ein Prüfreihenfolgeproblem, kein
Provider-Testfehler. Der Flow-spezifische gezielte Lauf konnte nicht gestartet
werden, weil in seinem Checkout `tsc` nicht installiert/erreichbar ist
(`sh: tsc: command not found`). Es gab daher keine Behauptung eines grünen
Flow-Integrationsstatus.

Es fehlen automatisierte und reale Nachweise für CLI Discovery, Login,
subprozesssichere Inferenz, je-Anbieter-Output-Normalisierung, Version/Update/
Rollback, Windows 11 sowie echte QA-Studio- und Flow-CLI-Ketten.

## Lokale CLI-Beobachtung, keine Freigabe

Auf diesem macOS-Rechner sind `codex-cli 0.162.1` und `gemini 0.64.0` im PATH;
`claude` und `ollama` sind nicht im PATH. Das beweist nur lokale Discovery, nicht
Login, erlaubte Nutzung, Versionskompatibilität oder Funktionsfähigkeit. Windows
wurde in dieser Aufnahme nicht ausgeführt.

## Risiken

1. **Kritisch – Compliance/Abrechnung:** Eine Nutzer-Subscription oder
   interaktive CLI-Anmeldung ist nicht automatisch eine Freigabe, sie als
   allgemeine Produkt-API zu vermitteln. Gemini verbietet ausdrücklich direkten
   Drittzugriff auf die Dienste hinter CLI-OAuth; API- und Geschäftsnutzung
   folgen anderen Bedingungen.
2. **Kritisch – Credential boundary:** Der Session-Shim importiert/parst
   `auth.json` und stellt eine eigene API vor die Benutzer-Session. Er darf nicht
   in einen aktiven Pfad gelangen.
3. **Hoch – Tool-Berechtigungen:** Die offiziellen CLIs sind Coding Agents und
   können Dateien/Shell verwenden. Ein Adapter darf daher weder unbounded
   Arbeitsverzeichnis noch interaktive/auto-approve Toolrechte erben.
4. **Hoch – Vertragskompatibilität:** Ein in-place Zusatz zu V1 würde strikte
   Client-/Server-Validatoren und Flow gefährden.
5. **Hoch – Update:** „latest“ ist keine Kompatibilitätsgarantie; Installation,
   Owner, Version, Test und Rollback unterscheiden sich zwischen npm, native
   Installer und verwalteten Geräten.
6. **Mittel – Release-Schutz:** Ein neuer Adapter darf den bestehenden
   Foundation-RC nicht berühren; bis zu realen Plattformtests bleibt er
   default-off.
