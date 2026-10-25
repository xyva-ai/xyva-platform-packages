# Windows Security P0 – Infrastruktur- und Entscheidungsgrundlage

Stand: 2026-10-25

Status: `PENDING_OWNER_DECISIONS`

Diese Unterlage enthält bewusst keine Hostadressen, VM-IDs, MAC-Adressen,
Seriennummern, Storage-Namen oder Zugangsdaten. Solche Kennungen bleiben in der
privaten Operations-Inventur.

## Ergebnis in einem Satz

Die vorhandene Infrastruktur kann die Windows-11-x64-Abnahme grundsätzlich
tragen, aber **nicht im gegenwärtigen Zustand**: Es fehlt zugleich eine
Runbook-konforme Kapazitätsfreigabe und die nachweisbare Offline-Isolation eines
bereits vorhandenen Windows-11-Testgasts. NAS und VPS sind keine Ersatzumgebung
für die native Abnahme.

## Tatsächlich geprüfter Stand

| Bereich | Nachweis | Ergebnis |
| --- | --- | --- |
| Isolierter ACL-PoC | [CI 40224827822](https://github.com/xyva-ai/xyva-platform-packages/actions/runs/40224827822), Commit `9772376cae552f0b65d078df855f4f571018b67f` | 40 `PASS`, 0 `FAIL`, 3 klar begrenzte `NOT_EXECUTED` |
| CI-Evidence | Artefakt `12610512957`, SHA-256 `eda7e006e0f73568d77f38b0ac7c2c1a8b27dfc026968f1719c4862cf9ac6c07` | Windows Server 2025, native `X64`-Prozess, NTFS-Fixtures |
| Öffentlicher Paket-Gate | [CI 40224821630](https://github.com/xyva-ai/xyva-platform-packages/actions/runs/40224821630) | `PASS` auf demselben Commit |
| Windows 11 x64 | Read-only-Proxmox-Inventur | vorhandene Kandidaten, aber `NO-START` |
| Windows 11 ARM64 | keine vorhandene native Umgebung nachgewiesen | `NOT_EXECUTED` |
| Produktive Integration | `secure-store.ts` unverändert | weiterhin `OPEN / BLOCKED` |

Der PoC-Workflow akzeptiert jetzt nur eine vollständige, eindeutig benannte
43-Ergebnisse-Matrix. Jede fehlende, doppelte oder zusätzliche Requirement-ID,
jeder unerwartete Nicht-`PASS`-Status und ein Harness-Exit ungleich null
beenden den CI-Job fail-closed.

## A. Read-only-Infrastrukturvergleich

| System | Tatsächliche Fähigkeit | Freie Ressourcen zum Prüfzeitpunkt | Eignung |
| --- | --- | --- | --- |
| Proxmox auf UGREEN-Hardware | x86-64, sechs logische CPUs, rund 32 GiB RAM, lokale ZFS-Datenträger mit reichlich Disk-Reserve; mehrere laufende VMs und Container | rund 2 GiB `MemAvailable`, unter 1 GiB freier Swap | einzig mögliche native Windows-11-VM-Umgebung, aktuell `NO-START` |
| Separates UGREEN-NAS | kein eigenständig erreichbarer NAS-Endpunkt oder Virtualisierungshost in den vorhandenen SSH-/Mount-Inventuren nachgewiesen | nicht nachweisbar | keine angenommene VM-Kapazität; nur nach separater Erreichbarkeits-/Berechtigungsprüfung als Backupziel bewertbar |
| Bestehendes NAS-Backupziel | vorhandener Sicherungspfad, aber sehr geringe freie Kapazität; frühere Netzwerk-Restore-Abweichung dokumentiert | für Evidenz klein genug, nicht für VM-Auslagerung | keine Entlastung des Proxmox-RAM; kein Golden-Image- oder Runtime-Ersatz |
| VPS | Linux x64, acht CPUs, rund 16 GiB RAM, mehrere Produkt-, CI-, Datenbank- und Monitoring-Workloads | rund 4–5 GiB verfügbarer RAM, unter 2 GiB freier Swap | kein nativer Windows-11-Nachweis und keine freie Kapazität für einen sicheren Windows-VM-Betrieb |

Disk ist nicht der Engpass. Die unmittelbaren Runbook-Grenzen von mindestens
12 GiB verfügbarem RAM, 6 GiB freiem Swap, 15 Minuten stabiler PSI-Evidence und
keinen aktiven Backup-/Restore-/Snapshot-Jobs sind nicht erfüllt.

### Kapazitätsursache

Der Proxmox-Host führt mehrere große Windows- und Linux-VMs neben Containern
aus. Die belegte Host-RAM-Menge wird überwiegend durch diese laufenden Gäste
gebunden; die laufende Quell-VM ist davon ausdrücklich ausgenommen. Ein
isolierter Staging-Gast meldet zwar erheblichen Gast-Leerlauf, belegt auf dem
Host aber mehrere GiB. Sein Stoppen oder Ballooning könnte daher nur einen
Teil der fehlenden Reserve zurückgeben und wäre allein nicht ausreichend.

Die zusätzliche benötigte Reserve beträgt ungefähr 10 GiB RAM und mehr als
5 GiB freien Swap. Dieser Wert ist vor einer Änderung nur eine Planungsgröße;
die tatsächliche Rückgabe ist unmittelbar nach jeder genehmigten Maßnahme und
anschließend über 15 Minuten erneut zu messen.

## B. Realistische Kapazitätsoptionen

| Option | Erwarteter Nutzen | Machbarkeit | Risiko/Auswirkung | Erforderliche Genehmigung | Bewertung |
| --- | --- | --- | --- | --- | --- |
| 1. Genehmigtes Wartungsfenster mit gezieltem Pausieren nichtkritischer Staging-Workloads | mehrere GiB pro Gast; mindestens zwei größere, nichtkritische Gäste oder äquivalente Reduzierungen wären voraussichtlich nötig | technisch möglich, Geschäfts- und Abhängigkeitsprüfung fehlt | zeitweiser Verlust von Staging-/Testdiensten; Swap-Rückgewinnung nicht garantiert | konkrete Liste, Service-Sentinel, Wartungsfenster und Rollback | **einzige realistische lokale Variante** |
| 2. Genehmigtes Ballooning eines nachweislich nichtkritischen Gasts | begrenzt, abhängig von Gastunterstützung und tatsächlichem Working Set | nur bei bestätigtem Ballooning und ohne Produktionslast | Gast kann Speicherdruck oder Funktionsverlust erleiden; allein voraussichtlich unzureichend | konkrete Ressourcenänderung und Live-Sentinel | nur als Teil von Option 1 |
| 3. Nichtkritische Dienste auf NAS verlagern | Disk-/Backup-Entlastung, praktisch keine unmittelbare RAM-Freigabe | keine unabhängige NAS-Compute-Fähigkeit nachgewiesen | neue Daten-/Netzwerkgrenze; keine Windows-VM-Entlastung | separate Architektur- und Betriebsfreigabe | nicht für dieses Gate |
| 4. Dienste auf VPS verlagern | nur nach detaillierter Dienstanalyse | VPS ist bereits stark belegt und kein Windows-11-Host | Produkt-/Datenbank-/CI-Risiko, Netzwerk- und Geheimnisgrenze | separate Migrationsfreigabe | nicht für dieses Gate |
| 5. Bestehenden Testgast mit kleinerer Konfiguration starten | keine zulässige Entlastung des Host-Startgates | widerspricht dem unveränderten Runbook-Gate | falscher Sicherheitsnachweis | keine zulässige Umgehung | verworfen |

**Empfohlene Variante:** Option 1, aber erst nach einer privaten
Abhängigkeitsklassifizierung. Ohne mindestens zwei ausdrücklich als
nichtkritisch bestätigte größere Gäste oder eine gleichwertige, sichere
Reduzierung ist die Abnahme mit dem aktuellen Host nicht durchführbar. NAS und
VPS ersetzen diese Freigabe nicht.

## C. Vorbereiteter Windows-11-Isolationsplan

Der vorhandene angehaltene QA-Testkandidat ist der bevorzugte Ausgangspunkt,
nicht die laufende Quell-VM. Read-only bestätigt sind eigene virtuelle Disk,
eigene EFI- und VM-Generation-Identität, eigener SMBIOS-UUID-Wert sowie
deaktivierter Autostart. Das ist noch keine Abnahmefreigabe.

| Voraussetzung | Status | Nächste Maßnahme |
| --- | --- | --- |
| Quell-VM unangetastet | nachgewiesen | unverändert beibehalten |
| Kandidaten-Disk isoliert | teilweise nachgewiesen | gestoppten Zustand und keine Shared-Writable-Volumes erneut protokollieren |
| SMBIOS-/VM-Generation-Identität | eigene UUID/Generation nachgewiesen | Hersteller-/Serienwerte, TPM, Aktivierung und BitLocker im Offline-Boot prüfen |
| TPM | im bevorzugten Kandidaten nicht als eigene TPM-State-Konfiguration nachgewiesen | vor einem Start entscheiden, ob eine TPM-/BitLocker-Strategie erforderlich ist; nicht spontan hinzufügen |
| Netzwerk | nicht erfüllt: vorhandene Schnittstelle ist noch nicht link-down und keine deny-by-default-Quarantäne nachgewiesen | nach Freigabe NIC link-down, Autostart/Startreihenfolge prüfen, dann erst Offline-Boot über Konsole |
| Recovery | kein unabhängiger Kandidatensnapshot als Abnahmereferenz nachgewiesen | Recovery-Backup und sauberer Stopped-State vor Sanitization festlegen |
| Secrets/Runtime | Beschreibung allein ist kein Nachweis | Offline-Sanitization und Secret-/Runtime-Scan ausschließlich nach Freigabe |

Verbindliche Reihenfolge nach Freigabe: Kapazitätsnachweis → gestoppte
Kandidatenkonfiguration → Offline-Boot mit NIC link-down → Sanitization und
Identitätsprüfung → Shutdown/Stopped-State-Recheck → erst danach freigegebenes
Quarantänenetz → Windows-11-Harness mit Testidentitäten. Kein Schritt nutzt
die Quellidentität oder Produktions-Credentials.

## D. Reviewprozess für einen Solo-Entwickler

Die read-only-GitHub-Prüfung ergab ein öffentliches Repository ohne sichtbare
Repository-Rulesets oder Branch-Protection auf `main`; es gibt keine
angeforderte oder eingereichte PR-Review. Im Repository wurde keine verbindliche
Security-Review-Policy gefunden. Das beweist nicht, dass es keine außerhalb des
Repositories geltende Unternehmenspflicht gibt.

| Ebene | Status | Aussagekraft |
| --- | --- | --- |
| Automatisierte Prüfungen | vorhanden | Windows-CI, vollständige Evidence-Matrix und öffentlicher Paket-Gate |
| Zweiter KI-Self-Review | durchgeführt | fand fünf Evidenzlücken; alle wurden im PoC korrigiert und im neuen Windows-CI getestet; kein menschlicher Review |
| Technischer Self-Review | vorhanden | [Review-Paket](WINDOWS_ACL_SECURITY_REVIEW_PACKAGE.md), keine Unabhängigkeit |
| Unabhängiger menschlicher Review | offen | für produktive Integration weiterhin empfohlen; nicht erfunden |
| Formale Risikoakzeptanz | offen | nur der Projektverantwortliche kann Umfang und Restrisiken akzeptieren |

Für eine kleine Organisation ist die praktikable Mindestentscheidung: das
CI-/Self-Review-Paket zusammen mit einem klaren Risikoregister dem
Projektverantwortlichen vorlegen, dessen explizite Risikoakzeptanz oder externe
Security-Review dokumentieren und erst danach über eine produktive Integration
entscheiden. Diese Vorlage erteilt keine Selbstfreigabe.

## E. Öffentliche Git-Historie

Ein älterer Commit auf dem offenen Draft-PR enthält nachweislich interne
Infrastrukturkategorien: private Netzadressierung, VM-/Storage-Bezeichner und
Hardware-/SMBIOS-Metadaten. Eine gezielte Textprüfung fand darin keine privaten
Schlüssel, Zugangstokens, Passwörter oder API-Schlüssel. Das ist keine
kryptografische Aussage über alle früheren Repositoryzustände.

Da das Repository öffentlich ist, lautet die Einstufung für diese Kennungen
`MEDIUM`: Sie sind keine direkten Zugangsdaten, erleichtern aber gezielte
Umgebungsprofilierung. Die aktuelle Fassung ist bereinigt; der alte Commit
bleibt historisch erreichbar.

**Empfehlung:** Eine koordinierte Bereinigung des Feature-Branch-Verlaufs vor
einem externen Review. Dazu gehört ein nachvollziehbarer Ersatzbranch oder ein
abgestimmter Rewrite, ein erneuter CI-Lauf und die Aktualisierung aller
SHA-gebundenen Referenzen. Ein Rewrite kann vorhandene Klone, Caches oder
bereits bekannte Commit-IDs nicht zuverlässig löschen. Da keine Credentials
gefunden wurden, ist keine unmittelbare Credential-Rotation allein aus diesem
Befund abgeleitet. Force-Push, PR-Neuerstellung, Branch-Löschung und
Repository-Sichtbarkeitsänderungen bleiben ausdrücklich genehmigungspflichtig.

## Entscheidungen zur Freigabe

| Freigabeoption | Konkrete Aktion | Betroffenes System | Nutzen | Risiko | Rückfallstrategie |
| --- | --- | --- | --- | --- | --- |
| A. Kapazitätsfenster | private Auswahl und zeitweises Pausieren/Reduzieren ausschließlich bestätigter nichtkritischer Gäste; vor/nachher 15-Minuten-Evidence | Proxmox | ermöglicht Runbook-konformen Windows-11-Start, falls Grenzwerte erreicht werden | Test-/Staging-Ausfall, ungewisse tatsächliche Freigabe | Dienste in dokumentierter Reihenfolge wiederherstellen; bei einem unterschrittenen Gate nicht starten |
| B. Offline-Isolation | Kandidat nur gestoppt umkonfigurieren: NIC link-down, Autostart/Startup prüfen, Quarantänekennzeichnung und Recovery-Evidence; danach Offline-Sanitization-Boot | vorhandener Windows-11-Testkandidat | bereitet reale Abnahme vor | falsche Konfiguration oder übernommene Identität | vor jeder Bootphase gestoppten Config-Export prüfen; kein Netz, keine Quelländerung |
| C. Review-/Risikoweg | externe menschliche Prüfung beauftragen **oder** formale, begrenzte Risikoakzeptanz des Projektverantwortlichen dokumentieren | PR #17 / Governance | klare Integrationsentscheidung ohne erfundene Reviewer | verbleibendes Fehlerrisiko bei nur Self-Review | P0 bleibt ohne Freigabe offen; keine produktive Integration |
| D. Historienbereinigung | neuen bereinigten Branch-Verlauf erstellen und nach bestätigtem Migrationsplan alte öffentliche PR-Referenz schließen/ersetzen | GitHub-Feature-Branch/PR | reduziert künftige Sichtbarkeit interner Kennungen | SHA-/CI-/PR-Referenzen ändern, alte Klone bleiben möglich | Branch und Artefakte vorab sichern; alte Referenzen nachvollziehbar dokumentieren |

## Unveränderte Grenzen

Kein Merge, keine produktive Secure-Store-Integration, kein Deployment, keine
Veröffentlichung, keine echte Provider-Inferenz und keine Änderung an
`packages/agent/src/secure-store.ts` erfolgten in diesem Arbeitsstrang.
