# Roadmap: OpenCare-Fork mit Arztgespräch-Modul

Stand: 7. November 2026, 5:30 Uhr (Arbeitsstand nach dem ersten Bautag)

Ziel: OpenCare als Grundlage nutzen, auf Deutsch bringen und um zwei Module erweitern.
Alles läuft selbst gehostet, auch Texterkennung (Whisper) und Sprachmodell (Ollama),
weil Gesundheitsdaten verarbeitet werden.

Geräte: Aufnahme und Sprachsteuerung auf Android. Die betreute Person nutzt ein Tablet
in der Kiosk-Ansicht.

## Phase 0: Basis

- [x] Fork von OpenCare 1.2.2 anlegen (Branch `de-arztmodul`)
- [x] Abhängigkeiten installieren, Build und Tests laufen (257 Tests grün)
- [ ] Fork auf GitHub anlegen und Branch `de-arztmodul` dorthin pushen (liegt als Git-Bundle vor)

## Phase 1: Deutsch

- [x] Deutsche Sprachdateien für die Oberfläche (34 Bereiche, durchgängig „Sie“)
- [x] Deutsche Texte im Server (Benachrichtigungen, Erinnerungen, E-Mails, KI-Antwortsprache)
- [x] Englisch, Französisch und Spanisch bleiben erhalten
- [ ] Datumsformat auf Deutsch: „Freitag 20 November 2026“ statt „Freitag, 20. November 2026“
      (Muster 'EEEE d MMMM yyyy' in Calendar, Medications, Visitors, Journal, Consultations)
- [ ] Blutzucker auf Deutsch in mg/dL anzeigen (App zeigt im metrischen System g/L)
- [ ] Deutsche Stichwörter für den Gesprächsbegleiter prüfen; „heiß“ mit ß wird nicht erkannt

## Phase 2: Arztgespräch-Modul

Ablauf: Vorbereiten, Aufnehmen, Verarbeiten, Prüfen, Nachbereiten. API: `docs/consultations-api.md`.

Fertig und getestet (Durchlauftest `scripts/smoke-consultations.sh`, 46 Prüfungen, alle grün):
- [x] Gespräch anlegen (Arzt, Fachrichtung, Termin, Ort, Anlass), optional mit Kalendertermin
- [x] Vorbereitung: Fragenliste für alle im Pflegekreis, sortierbar, Druckbericht für den Arzt
- [x] Einwilligung des Arztes ist Pflicht, sonst startet keine Aufnahme (Zeitpunkt und Person gespeichert)
- [x] Aufnahme auf dem Handy, Stücke werden sofort auf dem Gerät gespeichert, Bildschirm bleibt an
- [x] Warteschlange: Upload in Stücken, sobald Netz da ist, mit Lückenerkennung, ohne Doppel
- [x] Tablet: große Taste „Arztgespräch aufnehmen“ mit Ja/Nein-Frage zur Zustimmung
- [x] Verarbeitung: Whisper (Text) und Ollama (Zusammenfassung), lange Gespräche in Abschnitten
- [x] Fachwörter: eigene Liste pro Kreis, dazu automatisch Medikamente, Ärzte, Fachrichtungen,
      dazu deutsche Grundliste. Auch für Diktate im Tagebuch und die Sprachsteuerung
- [x] Zusammenfassung als KI-Entwurf, bearbeitbar, Freigabe durch einen Menschen
- [x] Vorschläge für Termine, Aufgaben und Pinnwand-Notizen. Angelegt wird erst nach Bestätigung,
      Termine nur mit Datum UND Uhrzeit, bereits übernommene werden nicht doppelt angelegt
- [x] Datenschutz: Zusammenfassung nur mit Ollama, und nur wenn Whisper und Ollama im eigenen Netz
      liegen (sonst wird nichts gesendet, Hinweis LOCAL_SERVICE_REQUIRED). Ausnahme per
      `LOCAL_AI_ALLOWED_HOSTS` für eigene Server mit öffentlicher Adresse
- [x] Freigegebene oder von Hand bearbeitete Zusammenfassungen werden nicht automatisch ersetzt
- [x] Antworten werden den Fragen über deren ID zugeordnet (Verschieben/Löschen sicher)
- [x] Rollen: Familie liest und schreibt, Fachkräfte lesen, Bekannte (viewer) und Nachbarn sehen nichts
- [x] Benachrichtigung der Familie, wenn eine Auswertung fertig oder fehlgeschlagen ist
- [x] Fehler im Original behoben: undici 8 passte nicht zu Node 20/22, Whisper und Ollama waren
      dadurch nicht erreichbar (`server/src/utils/safeFetch.ts`). Als Beitrag ans Original melden

Offen, aus der unabhängigen Prüfung (Oberfläche; angefangen im Branch `de-fixclient`, nicht fertig):
- [ ] Zwei offene Fenster: Das zweite darf eine laufende Aufnahme nicht als abgebrochen behandeln
- [ ] Fehlgeschlagenes Speichern eines Stücks darf die Aufnahme nicht blockieren (Speicher voll)
- [ ] Ungespeicherte Eingaben auf der Detailseite werden alle 15 s überschrieben, während der Server arbeitet
- [ ] Zeitpunkt der Einwilligung vom Gerät mitsenden (`consent_at`, Server nimmt es noch nicht an)
- [ ] Dauerhafte Upload-Fehler verständlich anzeigen statt endlos wiederholen, mit „Verwerfen“
- [ ] Tablet: Status der Warteschlange anzeigen, Hinweis wenn das Tablet entkoppelt wurde
- [ ] Abmelden: wartende Aufnahmen vorher hochladen oder bewusst löschen
- [ ] Angemeldete Angehörige auf einem gekoppelten Tablet senden als Gerät statt als Person
- [ ] Ohne Netz „Keine Verbindung“ statt „Gespräch nicht gefunden“ anzeigen
- [ ] Tablet: zweite Aufnahme innerhalb kurzer Zeit zum selben Gespräch
- [ ] Editor: Antworten über `question_id` anzeigen, Hinweis bei `summary_outdated`,
      klarer Warntext beim Neu-Erstellen (ersetzt auch die Freigabe), Menüpunkt für viewer ausblenden
- [ ] Neue Fehlercodes verständlich anzeigen (AUDIO_MISSING, LOCAL_SERVICE_REQUIRED, CONSULTATION_DELETED)

Offen, Server:
- [ ] Kalendertermin mitändern bzw. mitlöschen, wenn das Gespräch geändert oder gelöscht wird
- [ ] Gespräch und Aufnahme beim Tablet in einer Transaktion anlegen
- [ ] Größengrenze pro Aufnahme atomar prüfen
- [ ] Speicherbedarf bei langen Aufnahmen senken (Audio liegt mehrfach im Speicher)
- [ ] Entscheidung: Audio nach Freigabe automatisch löschen? (bisher nur von Hand)
- [ ] Diktate im Tagebuch (Funktion des Originals) prüfen ebenfalls nicht, ob Whisper lokal ist
- [ ] Gesprächsseiten offline lesbar machen

Offen, Gerät:
- [ ] Test auf echtem Android-Gerät: Läuft die Aufnahme weiter, wenn der Bildschirm ausgeht?
      Falls nicht: App in eine native Android-Hülle (Capacitor) packen
- [ ] Sprechertrennung (wer hat was gesagt), später

## Phase 3: Sprachsteuerung

- [x] Feste Befehle für Termine (anlegen, abfragen), Aufgaben (anlegen, erledigt) und Messwerte
      (Gewicht, Blutzucker), immer mit Ja/Nein-Rückfrage, auch als Texteingabe
- [x] Taste „Sprechen“ für Angehörige und große Kachel am Tablet
- [x] Regeln zuerst, Ollama nur als Hilfe für Datum und Uhrzeit
- [ ] Fehler: „Montag morgen um 9“ ergibt morgen statt Montag (angefangen in `de-fixvoice`)
- [ ] Fehler: „halb eins“ ergibt 0:30 statt 12:30
- [ ] Ollama-Hilfe darf keine Uhrzeit erfinden, die im Satz nicht vorkommt; Zeitgrenze 15 s
- [ ] Ollama-Hilfe nur, wenn Ollama im eigenen Netz liegt
- [ ] Befehle nur auf Deutsch und Englisch; Französisch und Spanisch fehlen
- [ ] Rückgängig-Taste nach einem Befehl am Tablet

## Phase 3b: Funktionen ein- und ausschalten (Wunsch vom 7. November)

Angefangen im Branch `de-features`, nicht fertig.
- [ ] Bereich „Funktionen“ in den Einstellungen, nur Admin, große Schalter
- [ ] Ausgeschaltete Funktionen verschwinden für alle im Kreis (Menü, Startseite, Tablet)
- [ ] Server sperrt ausgeschaltete Funktionen zusätzlich (403 FEATURE_DISABLED)
- [ ] Daten bleiben beim Ausschalten erhalten
- [ ] Fest an: Übersicht, Pflegetagebuch, Einstellungen, Notfall

## Phase 4: Betrieb

- [x] Lokaler Test mit Docker Desktop: Anleitung `LOKAL-TESTEN.md`, optionale lokale KI `docker-compose.ki.yml`
- [ ] Lokalen Test auf Windows durchführen
- [ ] Hosting entscheiden: AWS (Region Frankfurt) oder Server beim bekannten Admin
- [ ] Hardware für Whisper und Ollama: Grafikkarte nötig, Kosten prüfen
- [ ] HTTPS, tägliche Backups mit Wiederherstellungstest, Überwachung
- [ ] Ablauf für Updates vom Original-Projekt

## Phase 5: Alltagstest vor dem echten Einsatz

- [ ] Zwei bis vier Wochen mit der Familie testen
- [ ] Medikamenten-Erinnerungen und Eskalation einschalten und gezielt prüfen
      (standardmäßig ausgeschaltet)
- [ ] Bedienung mit der betreuten Person am Tablet ausprobieren

## Später

- Sprechertrennung im Arztgespräch (wer hat was gesagt)
- Medikamenten-Befehle für die Sprachsteuerung
- Module an das Original-Projekt zurückgeben

## Offene Entscheidungen

- GitHub-Konto für den Fork
- Hosting-Anbieter und Hardware
- Welches Sprachmodell in Ollama (Qualität auf Deutsch gegen Hardware-Bedarf)
