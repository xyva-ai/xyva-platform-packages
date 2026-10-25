# Windows Secure Store – Phase-12B-Integrationsplan

Status: `PREPARED_NOT_IMPLEMENTED`  
Produktive Datei: `packages/agent/src/secure-store.ts` (nur lesend betrachtet)  
PR #16: unverändert

## Geplante Integrationsinvarianten

1. Secure-Root und jede Parent-Komponente handle-relativ öffnen; Reparse-
   Punkte und unsichere Komponenten ablehnen.
2. Datei mit explizitem Security Descriptor atomar erzeugen.
3. Owner, DACL, ACEs, Schutz-/Vererbungsflags über den geöffneten Handle prüfen,
   bevor und nachdem Daten geschrieben werden.
4. Nur erwartete native Fehlercodes in Create-/Replace-/Read-/Delete-Pfaden
   behandeln; unbekannte Fehler fail-closed weitergeben.
5. Atomische Ersetzung nur über einen sicheren Parent-Handle und nachweisbare
   Zielidentität durchführen.

## Bestandsdaten, Migration und Rollback

- Bestehende Dateien niemals stillschweigend überschreiben oder lockern.
- Unsichere oder nicht auswertbare ACLs als Fehler markieren und vor Migration
  sichern.
- Migration nur nach expliziter Freigabe, mit Backup-/Rollback-Plan und
  nachweisbarer Wiederherstellung.
- Fehlt der Master-Key bei vorhandenen verschlüsselten Credentials oder
  Swarm-Daten, keinen neuen Key erzeugen.
- Nach Migration müssen alte und neue Daten mit demselben Schlüssel lesbar
  sein; ein Rollback darf keine neue Schlüsselgeneration auslösen.

## Plattform- und Regressionserfordernisse

- Windows Server 2025 CI bleibt getrennt von Windows-11-Geräteabnahme.
- Windows 11 x64, native ARM64, Linux und macOS separat testen.
- Bestehende Secure-Store-, Foundation-, Packaging- und Public-Regressionen
  müssen auf jedem Integrationscommit erneut laufen.
- APIs und Fehlercodes des bestehenden Secure Stores dürfen sich nicht
  unbeabsichtigt ändern.

## Verbindliche Gates vor Phase 12B

- unabhängiger Security-Review mit dokumentierter Freigabe;
- Windows-11-x64-Nachweis oder bewusste Supportentscheidung;
- Entscheidung zu native Missing-DACL-Evidence;
- vollständige Create-/Replace-/Read-/Delete-Regression;
- Master-Key-Lifecycle- und Bestandsdaten-Migrationstests;
- explizite Freigabe für produktive Dateiänderungen.

Bis dahin bleiben Änderungen auf dem isolierten PoC-Branch. Es gibt keine
Implementierung in `secure-store.ts`, keine Datenmigration und keinen Rollout.
