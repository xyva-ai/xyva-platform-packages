# XYVA Windows Secure Store P0 – Abschlussbericht

Datum: 2026-10-25  
Gesamtstatus: `PARTIALLY_VALIDATED`  
PoC-Status: `POC_TESTS_PASS`  
Windows-11-Gerät: `NOT_EXECUTED`  
Unabhängiger Review: `NOT_APPROVED`  
Produktive Integration: `NOT_EXECUTED`

## A. Management Summary

Die ausführbaren isolierten ACL-/Prozess-/Race-/Cleanup-Prüfungen sind auf
GitHub-hosted Windows Server 2025 erfolgreich. Der Timeout-Fehlerpfad und die
sprachunabhängige Kontenbereinigung wurden ergänzt. Ein vorhandener
Windows-11-Proxmox-Bestand ist keine Abnahmefreigabe: Die read-only-Prüfung
ergab für die verfügbaren Testkandidaten ein Runbook-`NO-START` wegen fehlender
Kapazität und unvollständiger Isolationsnachweise; die laufende Quell-VM wurde
nicht verändert. Windows 11 x64, native ARM64, ein unabhängiger
Security-Review und die produktive Foundation bleiben offen. Es wurden keine
künstlichen PASS-Ergebnisse erzeugt.

## B. Technischer Status

- Branch: `codex/windows-acl-security-spike`
- Letzter codewirksam geprüfter Head:
  `9772376cae552f0b65d078df855f4f571018b67f`
- Draft-PR: [#17](https://github.com/xyva-ai/xyva-platform-packages/pull/17)
- CI: [Run 40224827822](https://github.com/xyva-ai/xyva-platform-packages/actions/runs/40224827822)
- Artifact: `12610512957`, `windows-acl-evidence-40224827822`, nicht abgelaufen,
  SHA-256 `eda7e006e0f73568d77f38b0ac7c2c1a8b27dfc026968f1719c4862cf9ac6c07`
- Matrix: 40 `PASS`, 0 `FAIL`, 3 `NOT_EXECUTED`
- Geänderte Branch-Dateien: `.github/workflows/windows-acl-poc.yml`,
  `spikes/windows-acl/WindowsAclProof.ps1`,
  `spikes/windows-acl/WindowsAclProof.Tests.ps1` sowie diese isolierten
  Dokumentationsdateien

## C. Plattformmatrix

| Plattform | Ergebnis | Begründung |
| --- | --- | --- |
| Windows Server 2025 x64 | PASS | Native CI, Build 26100, PowerShell 7.6.7 |
| Windows 11 x64 | NOT_EXECUTED | Bestandener Proxmox-Host, aber kein Runbook-konformer Start: Kapazitäts- und Isolations-Gates fehlen; Quell-VM blieb tabu |
| Windows 11 ARM64 nativ | NOT_EXECUTED | Keine freigegebene ARM64-Umgebung |
| macOS lokal | NOT_EXECUTED | Windows-Security-APIs nicht verfügbar |

## D. Sicherheitsprüfung

Bestanden sind Handle-relative Erstellung, explizite ACLs vor dem Schreiben,
Owner-/DACL-/ACE-/Vererbungsprüfung, Null-/Leer-DACL-Ablehnung, Reparse-Schutz,
Zweitprozess-ACCESS_DENIED, beide Parent-Swap-Races, Timeout-Termination,
Handle-Cleanup, SID-basierte Benutzerbereinigung und fail-closed Negativtests.

Die drei CI-`NOT_EXECUTED`-Einträge sind Windows-11-x64, native ARM64 und der
objektgebundene Missing-DACL-Fixture. Der produktive Foundation-P0 bleibt
`OPEN / BLOCKED`.

Der Workflow akzeptiert zusätzlich ausschließlich genau diese drei benannten
`NOT_EXECUTED`-Einträge und eine vollständige, fest benannte Matrix aller 43
Requirements. Leere, doppelte, fehlende oder zusätzliche Requirement-Namen,
jeder andere Nicht-`PASS`-Status, ein Harness-Exit ungleich null und eine nicht
nativ-x64/NTFS-gebundene Plattform-Evidence lassen den Job fail-closed
scheitern. Die Regel wurde lokal und im Windows-Server-2025-Lauf auf dem
obigen Commit geprüft.

## E. Missing-DACL-Entscheidungsvorlage

Windows hält bei dem zugeordneten NTFS-Objekt `SE_DACL_PRESENT` gesetzt. NULL-
und leere DACLs wurden nativ hergestellt und verworfen. Ein fehlender DACL-
Zeiger wurde nicht als echter NTFS-Objektnachweis simuliert. Entscheidung des
Security Reviewers erforderlich: zusätzliche native Fixture über anderen
Objekttyp/API oder Akzeptanz der fail-closed Metadaten-Garantie.

## F. Unabhängiger Security Review

Das Paket [WINDOWS_ACL_SECURITY_REVIEW_PACKAGE.md](WINDOWS_ACL_SECURITY_REVIEW_PACKAGE.md)
enthält Threat Model, Trust Boundaries, Invarianten, API-Review,
Evidence-Referenzen, Risiken und konkrete Review-Fragen. Es handelt sich
ausdrücklich um einen internen Self-Review, nicht um eine unabhängige Freigabe.

## G. Phase-12B-Readiness

Der vorbereitete Plan liegt in
[WINDOWS_SECURE_STORE_PHASE12B_INTEGRATION_PLAN.md](WINDOWS_SECURE_STORE_PHASE12B_INTEGRATION_PLAN.md).
Er behandelt atomare Erstellung, handle-relative Pfade, Migration,
Rollback, Replace-Recovery, Plattformregressionen und verpflichtende Gates.
Produktive Dateien, PR #16 und `secure-store.ts` wurden nicht geändert.

## H. Nächste unvermeidbare Freigabe

Zuerst müssen die dokumentierten Proxmox-Startgates erfüllt und ein bereits
sanitisierter, isolierter Windows-11-x64-Testgast namentlich freigegeben sein.
Die Details stehen bewusst ohne Infrastrukturkennungen in
[`PROXMOX_WINDOWS11_PREFLIGHT.md`](PROXMOX_WINDOWS11_PREFLIGHT.md). Erst dann
darf dort der vorhandene Harness ausgeführt werden:

```powershell
pwsh -NoProfile -NonInteractive -File .\spikes\windows-acl\Invoke-Windows11AclAcceptance.ps1 `
  -ExpectedCommit (git rev-parse HEAD) `
  -EvidencePath .\evidence\windows11-acl-evidence.json
```

Danach müssen OS/Build/Architektur/Gerätetyp, SHA und Evidence unabhängig
geprüft werden. Für native ARM64 ist eine separate native Umgebung nötig.

Für PR #17 ist zudem noch kein unabhängiger Review angefordert oder eingereicht.
Die verfügbare read-only-GitHub-Abfrage bestätigte nicht die behauptete dritte
Reviewidentität. Ein namentlich benannter, unabhängiger Account mit Zugriff muss
die Prüfung anfordern und als Review dokumentieren; die bisherigen Nachweise
bleiben bis dahin `INTERNAL_SELF_REVIEW_ONLY`.

Kein Merge, keine produktive Integration, kein Deployment, Release oder
Publishing ohne unabhängige Prüfung und erneute ausdrückliche Freigabe.
