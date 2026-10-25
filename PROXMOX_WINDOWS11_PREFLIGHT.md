# Proxmox Windows-11 Read-only Preflight

Datum: 2026-10-25
Host: konfigurierte Proxmox-Umgebung (Kennungen nicht versioniert)
Quelle: Runbook `proxmox-image-isolation.md`
Ausführung: ausschließlich read-only über `pvesh`

## Tatsächlicher Zustand

- Die produktive Windows-11-Quell-VM läuft; OSType, VM-Generation-ID und TPM
  wurden read-only bestätigt. Sie blieb unangetastet.
- Die Snapshot-Kette der Quell-VM ist unverändert.
- Ein angehaltener, als isoliert markierter Windows-Testkandidat besitzt eigene
  virtuelle Disks, VM-Generation-ID und TPM-Disk, verlangt laut seiner
  Konfiguration aber weitere Sanitization.
- Ein weiterer angehaltener Windows-Testkandidat besitzt eigene Disk und TPM;
  im gelesenen Config-Stand war keine dokumentierte Quarantänekennzeichnung
  vorhanden.

## Sicherheits- und Kapazitätsbefunde

Der als isoliert markierte Testkandidat ist **kein freigegebener
Windows-11-Abnahmehost**:

- `net0` hat `link_down=0`; der Runbook-Gate verlangt NIC-Link-down vor dem
  Offline-Sanitization-Boot.
- SMBIOS-Serienkennung sowie Hersteller-/Produktdaten entsprechen der Quelle.
  Eine neue UUID allein erfüllt die Identitätsisolation nicht.
- Die VM besitzt nur den Zustandssnapshot `current`; eine unabhängige
  Sanitization-/Secret-Scan-/Recovery-Abnahme ist nicht dokumentiert.

Der Host meldete beim Preflight:

- verfügbarer RAM unterhalb der Runbook-Mindestgrenze von `12 GiB`
- freier Swap unterhalb der Runbook-Mindestgrenze von `6 GiB`

Damit ist jeder Start eines Windows-11-Testklons nach dem Runbook ein
`NO-START`. Es wurde keine VM gestartet, gestoppt, geklont, zurückgesetzt,
umkonfiguriert oder an ein anderes Netzwerk angeschlossen.

## Reviewer-/GitHub-Status

PR #17 hat aktuell keine angeforderten Reviewer und keine eingereichten
Reviews. Die read-only Collaborator-Abfrage bestätigte nur Eigentümer- und
Push-Zugriff; daraus wird keine unabhängige Security-Freigabe abgeleitet. Ein
dritter Account konnte über die verfügbare Repository-Collaborator-API nicht
bestätigt werden.

## Erforderliche nächste Freigaben

1. Runbook-konforme Kapazitätsfreigabe oder Wiederherstellung von mindestens
   12 GiB verfügbarem RAM und 6 GiB freiem Swap, ohne kritische VMs zu stoppen.
2. Ausdrückliche Freigabe für die Offline-Sanitization des Testkandidaten oder
   die Benennung eines bereits bereinigten Windows-11-Testklons.
3. Quarantäne-NIC-Link-down, eindeutige SMBIOS-/Hostname-/IP-/TPM-Identität,
   Secret-/Runtime-Scan und unabhängige Recovery-Evidence.
4. Namentlich bestätigter, unabhängiger GitHub-Reviewer für PR #17.

Bis diese Punkte erfüllt sind, bleibt Windows-11-Geräteabnahme
`NOT_EXECUTED`; Windows Server 2025 CI ersetzt sie nicht.
