# Roadmap: OpenCare-Fork mit Arztgespräch-Modul

Stand: 7. November 2026

Ziel: OpenCare als Grundlage nutzen, auf Deutsch bringen und um zwei Module erweitern.
Alles läuft selbst gehostet, auch Texterkennung (Whisper) und Sprachmodell (Ollama),
weil Gesundheitsdaten verarbeitet werden.

Geräte: Aufnahme und Sprachsteuerung auf Android. Die betreute Person nutzt ein Tablet
in der Kiosk-Ansicht.

## Phase 0: Basis

- [x] Fork von OpenCare 1.2.2 anlegen (Branch `de-arztmodul`)
- [x] Abhängigkeiten installieren, Build und Tests laufen (257 Tests grün)
- [ ] Fork auf GitHub anlegen und Branch dorthin pushen

## Phase 1: Deutsch

- [ ] Deutsche Sprachdateien für die Oberfläche (`client/src/i18n/locales/de`)
- [ ] Deutsche Texte im Server (Benachrichtigungen, Erinnerungen, E-Mails)
- [ ] Englisch, Französisch und Spanisch bleiben erhalten, damit Updates vom Original
      übernommen werden können

## Phase 2: Arztgespräch-Modul

Ablauf: Vorbereiten, Aufnehmen, Verarbeiten, Prüfen, Nachbereiten.

- [ ] Gespräch anlegen: Arzt, Fachrichtung, Datum, Anlass
- [ ] Vorbereitung: Fragenliste, die alle im Pflegekreis ergänzen können
- [ ] Einwilligung: Die Aufnahme startet erst, wenn bestätigt ist, dass der Arzt zugestimmt
      hat (§ 201 StGB). Zeitpunkt und bestätigende Person werden gespeichert.
- [ ] Aufnahme in der App (Android), Speicherung lokal auf dem Gerät
- [ ] Warteschlange: Aufnahmen bleiben auf dem Gerät, bis Netz da ist, und werden dann
      in Stücken hochgeladen
- [ ] Verarbeitung auf dem Server: Whisper für Text, Ollama für die Zusammenfassung
- [ ] Zusammenfassung ist als KI-Entwurf markiert, bis ein Mensch sie prüft und freigibt
- [ ] Nachbereitung: Antworten zu den vorbereiteten Fragen, eigene Notizen, Folgetermine
      und Aufgaben übernehmen
- [ ] Zugriff nach Rollen: Familie liest und schreibt, Nachbarschaft sieht nichts
- [ ] Auch die betreute Person kann in der Tablet-Ansicht eine Aufnahme starten
- [ ] Test auf echtem Android-Gerät: Läuft die Aufnahme weiter, wenn der Bildschirm ausgeht?
      Falls nicht: App in eine native Android-Hülle (Capacitor) packen

## Phase 3: Sprachsteuerung

Feste Befehle statt freier Sprache. Jeder Befehl wird vor dem Speichern vorgelesen
und mit Ja oder Nein bestätigt.

- [ ] Termine: Termin anlegen, Termine von heute oder morgen abfragen
- [ ] Aufgaben: Aufgabe anlegen, Aufgabe als erledigt melden
- [ ] Messwerte: Gewicht und Blutzucker erfassen
- [ ] Für Angehörige auf dem Handy und als große Sprachtaste in der Tablet-Ansicht
- [ ] Befehle zuerst über feste Regeln erkennen, Ollama nur für Datum und Uhrzeit
      in freier Formulierung

## Phase 4: Betrieb

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
