# Proxmox Windows-11 Read-only Preflight

Datum: 2026-10-25  
Host: `192.168.68.88`  
Quelle: Runbook `proxmox-image-isolation.md`  
Ausführung: ausschließlich read-only über `pvesh`

## Tatsächlicher Zustand

- VM 100 `win11-main`: `running`, 4 vCPU, 8 GiB RAM, 200 GiB Disk,
  Windows-11-OSType, VM-Generation-ID und TPM vorhanden.
- VM 100 Snapshot-Kette ist unverändert; der aktuelle Snapshot heißt
  `current`, die Quell-VM blieb unangetastet.
- VM 101 `xyva-flow-alpha-tester`: `stopped`, 4 vCPU, 8 GiB RAM, eigene
  `tank:vm-101-disk-*`-Volumes, VM-Generation-ID und eigene TPM-Disk.
  Beschreibung und Tags (`do-not-start;isolated;xyva-flow-alpha`) verlangen
  ausdrücklich weitere Sanitization.
- VM 111 `qa-tester`: `stopped`, 4 vCPU, 8 GiB RAM, eigene Disk und TPM; keine
  dokumentierte Quarantänekennzeichnung im gelesenen Config-Stand.

## Sicherheits- und Kapazitätsbefunde

VM 101 ist **kein freigegebener Windows-11-Abnahmehost**:

- `net0` hat `link_down=0`; der Runbook-Gate verlangt NIC-Link-down vor dem
  Offline-Sanitization-Boot.
- SMBIOS-Serienkennung und Hersteller-/Produktdaten entsprechen der Quelle
  VM 100 (`EC752JJ0426383B2`, `UGREEN`, `DXP4800Plus`). Eine neue UUID allein
  erfüllt die Identitätsisolation nicht.
- Die VM besitzt nur den Zustandssnapshot `current`; eine unabhängige
  Sanitization-/Secret-Scan-/Recovery-Abnahme ist nicht dokumentiert.

Der Host meldete beim Preflight:

- RAM verfügbar: ca. `2.3 GiB` (Runbook fordert mindestens `12 GiB`)
- freier Swap: ca. `0.8 GiB` (Runbook fordert mindestens `6 GiB`)
- Swap insgesamt: `8 GiB`, davon ca. `7.2 GiB` belegt

Damit ist jeder Start eines Windows-11-Testklons nach dem Runbook ein
`NO-START`. Es wurde keine VM gestartet, gestoppt, geklont, zurückgesetzt,
umkonfiguriert oder an ein anderes Netzwerk angeschlossen.

## Reviewer-/GitHub-Status

PR #17 hat aktuell keine angeforderten Reviewer und keine eingereichten
Reviews. Die read-only Collaborator-Abfrage zeigte `p0lycl0n3` mit Push-Rechten
und den Repository-Eigentümer `xyva-ai`; daraus wird keine unabhängige
Security-Freigabe abgeleitet. Ein dritter Account konnte über die verfügbare
Repository-Collaborator-API nicht bestätigt werden.

## Erforderliche nächste Freigaben

1. Runbook-konforme Kapazitätsfreigabe oder Wiederherstellung von mindestens
   12 GiB verfügbarem RAM und 6 GiB freiem Swap, ohne kritische VMs zu stoppen.
2. Ausdrückliche Freigabe für die Offline-Sanitization von VM 101 oder die
   Benennung eines bereits bereinigten Windows-11-Testklons.
3. Quarantäne-NIC-Link-down, eindeutige SMBIOS-/Hostname-/IP-/TPM-Identität,
   Secret-/Runtime-Scan und unabhängige Recovery-Evidence.
4. Namentlich bestätigter, unabhängiger GitHub-Reviewer für PR #17.

Bis diese Punkte erfüllt sind, bleibt Windows-11-Geräteabnahme
`NOT_EXECUTED`; Windows Server 2025 CI ersetzt sie nicht.
