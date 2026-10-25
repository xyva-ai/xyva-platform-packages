# XYVA Windows ACL PoC – Security-Review-Paket

Status: `INTERNAL_SELF_REVIEW_ONLY`  
Branch: `codex/windows-acl-security-spike`  
Letzter codewirksam geprüfter Head: `311224e7fcee155d17ab28618840ac1cc66e666c`  
PR: [#17](https://github.com/xyva-ai/xyva-platform-packages/pull/17)

## Scope und Threat Model

Schutzgüter sind der private Dateiinhalt, der Security Descriptor, der
Master-Key-Testpfad sowie die Integrität des validierten Parent-Verzeichnisses.
Betrachtete Angreifer sind ein anderer lokaler Nicht-Admin-Prozess und ein
Prozess, der zwischen Pfadauflösung und Erstellung Parent-Komponenten durch
Junction/Reparse-Austausch manipuliert. Lokale Administratoren, `SYSTEM`, der
Kernel, ein kompromittierter Host und ein bösartiger GitHub-Runner liegen
außerhalb des PoC-Schutzversprechens.

## Trust Boundaries und Invarianten

- Native Datei-/Verzeichnis-Erstellung erfolgt relativ zu geöffneten Handles.
- Jede Parent-Komponente wird einzeln geöffnet und auf Reparse-Attribute geprüft.
- Der Security Descriptor wird vor dem ersten synthetischen Schreiben gesetzt
  und am weiterhin geöffneten Handle vor und nach dem Schreiben geprüft.
- Zulässig sind nur der erwartete Owner sowie `SYSTEM` und
  `BUILTIN\\Administrators` als explizite, nicht geerbte Full-Control-ACEs.
- Null-DACL, leere DACL, fehlende DACL, unbekannte ACEs, breite SIDs und
  unerlaubte Rechte werden fail-closed abgelehnt.
- Unbekannte Race-Fehler dürfen nicht als erfolgreiche Ablehnung gelten.
- Temporäre Konten, Tokens, Prozess-/Thread-Handles und Testfixtures werden
  mit Fehlerprüfung bereinigt.

## Native Architekturprüfung

Geprüft wurden `CreateFile`, `NtCreateFile`, `GetSecurityInfo`,
`SetSecurityInfo`, `CreateProcessWithLogonW`, `TerminateProcess`,
`WaitForSingleObject`, `GetExitCodeProcess` und `CloseHandle`. Die P/Invoke-
Definitionen verwenden feste Zugriffs-/Create-Flags, kontrollierte relative
Komponenten und explizite Handle-Cleanup-Pfade. Der Timeout-Fault-Test bestätigt
die Beendigung über das originale Prozesshandle mit Exitcode `124`.

Interner Restpunkt: Die P/Invoke-Schicht ist kein produktiver Adapter und wurde
nicht durch einen unabhängigen Windows-Security-Reviewer freigegeben.

## Nachweise

Windows-Server-2025-CI-Run [40218421133](https://github.com/xyva-ai/xyva-platform-packages/actions/runs/40218421133):

- Evidence-Artefakt `12607549682`, Schema `xyva.windows-acl-poc.v3`, nicht abgelaufen
- 40 `PASS`, 0 `FAIL`, 3 `NOT_EXECUTED`
- Nicht-Admin-Zweitprozess mit SID-/PID-Nachweis und Kernel-ACCESS_DENIED
- File- und Directory-Parent-Swap mit Barrieren, externem Sentinel und
  handlegebundener Erstellung
- Reparse-Point-Ablehnung, Owner-/DACL-/ACE-/Vererbungsprüfung
- Timeout-Termination, Prozess-/Thread-Handle-Cleanup und sprachunabhängige
  lokale Benutzer-/SID-Bereinigung

## Missing-DACL-Entscheidung

Auf dem verwendeten NTFS-Objekt liefert Windows einen dem Objekt zugeordneten
Security Descriptor mit gesetztem `SE_DACL_PRESENT`. Ein echter NULL-DACL-
Zeiger und eine gültige leere ACL konnten nativ hergestellt und abgelehnt
werden. Ein persistent zugeordnetes NTFS-Objekt mit nicht gesetztem
`SE_DACL_PRESENT` wurde nicht sicher hergestellt. Ein frei konstruiertes,
nicht objektgebundenes Descriptor-Objekt wäre kein ausreichender nativer
Nachweis und bleibt deshalb `NOT_EXECUTED`.

Die produktrelevante Garantie ist dennoch fail-closed: `DaclPresent=false`,
NULL-DACL und leere/unerwartete ACE-Listen werden von
`Assert-PrivateAclEvidence` verworfen. Der Security Reviewer muss entscheiden,
ob diese Metadaten-Garantie ohne nativen Missing-DACL-Fixture genügt oder ein
separater Windows-API-/Objekttyp-PoC erforderlich ist.

## Offene Review-Fragen

1. Sind die verwendeten Rechte und SDDL-Flags für alle unterstützten Windows-
   Editionen und NTFS-Konfigurationen minimal und korrekt?
2. Ist der Einsatz von `NtCreateFile` für den späteren Produktadapter zulässig,
   oder muss eine dokumentierte Win32-Handle-Alternative verwendet werden?
3. Welche Recovery-/Migrationsregeln gelten für bereits unsichere Dateien?
4. Muss Missing-DACL auf einem separaten, objektgebundenen Security-API-Fixture
   nachgewiesen werden?
5. Welche Windows-11-x64-, ARM64- und Geräteklassen sind offiziell im Support-
   Umfang?

## Review-Grenze

Dies ist ein interner Self-Review desselben Arbeitsstrangs. `INDEPENDENT_REVIEW_APPROVED`
ist nicht gesetzt. Für PR #17 ist kein unabhängiger Review angefordert oder
eingereicht; die verfügbare read-only-GitHub-Abfrage bestätigte keine dritte
Reviewidentität. Der PoC ist kein produktiver Secure-Store und erteilt keine
Credential-, Provider-, Merge-, Release- oder Deployment-Freigabe.
