# OpenCare (deutscher Fork) lokal testen

Diese Anleitung startet die App auf dem eigenen Rechner. Sie ist zum Ausprobieren gedacht,
nicht für den echten Betrieb mit Gesundheitsdaten.

## Was Sie brauchen

- Docker Desktop (für Mac oder Windows), gestartet
- etwa 3 GB freien Speicher, mit lokaler KI zusätzlich etwa 8 GB

## 1. App starten

Im entpackten Ordner ein Terminal öffnen (Mac: Terminal, Windows: PowerShell) und eingeben:

```
cp .env.demo .env
docker compose up -d --build
```

Unter Windows statt `cp` den Befehl `copy .env.demo .env` verwenden.

Der erste Start dauert einige Minuten. Danach im Browser öffnen:

**http://localhost:3000**

## 2. Erstes Konto anlegen

Auf „Ich habe noch kein Konto, registrieren“ klicken. Das erste Konto darf sich immer
registrieren, weitere Personen laden Sie danach aus der App heraus ein.
Oben links lässt sich die Sprache auf **DE** stellen.

## 3. Ausprobieren

- **Arztgespräche** im Menü unter „Pflege“: Gespräch anlegen, Fragen vorbereiten, Aufnahme
  starten (das Kontrollkästchen zur Zustimmung des Arztes ist Pflicht).
- **Einfache Ansicht der betreuten Person**: mit dem Konto der betreuten Person anmelden
  (bei `npm run dev:lokal` das Testkonto „Betreute Person“, siehe unten). Sie sieht nur
  diese Ansicht: Medikamente heute mit „Genommen“ und „Rückgängig“, Besuche, Termine,
  wichtige Kontakte und „Fragen Sie mich“ mit festen Fragen. Andere Seiten führen zurück.
- **Sprechen**: grüne Taste oben rechts. Ohne lokale KI funktioniert die Texteingabe.

Ohne lokale KI werden Aufnahmen gespeichert, aber nicht ausgewertet. Die App zeigt dann einen
Hinweis „Texterkennung nicht eingerichtet“.

## 4. Optional: lokale KI

Startet zusätzlich Whisper (Texterkennung) und Ollama (Sprachmodell). Ohne Grafikkarte ist
das langsam: ein 15-minütiges Gespräch kann auf einem normalen Laptop viele Minuten dauern.

```
docker compose -f docker-compose.yml -f docker-compose.ki.yml up -d --build
docker exec opencare-ollama ollama pull qwen2.5:7b
```

Das Sprachmodell ist ein Beispiel. Welches Modell auf Deutsch gut genug und für Ihre Hardware
klein genug ist, sollte getestet werden.

Dann in der App einrichten:

- Unter **Integrationen**, Whisper: Adresse `http://speaches:8000`, Modell `Systran/faster-whisper-small`, Sprache `de`
- Unter **Einstellungen**, KI-Assistent: Anbieter Ollama, Adresse `http://ollama:11434`, Modell `qwen2.5:7b`

Hinweis: Je nach Version von speaches muss das Whisper-Modell beim ersten Mal heruntergeladen
werden. Das passiert automatisch oder über die Dokumentation von speaches.

## Beenden und aufräumen

```
docker compose down
```

Alle Testdaten löschen (Datenbank inklusive):

```
docker compose down -v
```

## Für die Entwicklung: dev:lokal und precheck

Zwei Befehle reichen:

| Befehl | Wann | Adresse |
| --- | --- | --- |
| `npm run dev:lokal` | Beim Arbeiten. Änderungen erscheinen nach etwa einer Sekunde, ohne neuen Build. Keine Tests | http://localhost:5173 |
| `npm run precheck` | Vor jedem Commit: Typprüfung, Tests und die fertige App in Docker, so wie auf dem Server | http://localhost:3000 |

`npm run precheck:fast` (nur Typprüfung und Tests) bleibt für zwischendurch.

`npm run dev:lokal` startet nur die Datenbank in Docker (erreichbar nur über 127.0.0.1:5433,
siehe `docker-compose.dev.yml`), dann Server und Oberfläche direkt auf dem Rechner. Beim ersten Start
legt es `server/.env` aus `server/.env.example` an und spielt die Testdaten ein. Läuft die Docker-App
von `npm run precheck`, wird sie angehalten, weil beide Port 3001 brauchen. Beide nutzen dieselbe
Datenbank und dieselben Testdaten.

Alle Meldungen von Server und Oberfläche stehen in `dev-lokal.log` im Hauptordner (bei jedem Start
neu, nicht im Repo). Im Terminal stehen nur die Schritte und die Testkonten.

Beenden mit Strg+C. Die Datenbank läuft weiter, anhalten mit `docker compose stop postgres`.

### Testkonten (fiktiv)

Anmeldung mit Benutzername (Vorname und Nachname ohne Leerzeichen, Groß- und Kleinschreibung egal).
Passwort für alle: `Testpasswort-123`

| Rolle | Benutzername |
| --- | --- |
| Administrator | ThomasMuster |
| Familie | SabineMuster |
| Fachkraft | PetraSonnenschein |
| Freunde | KarlNachbar |
| Betreute Person | ErikaMuster |

Lokale Datenbank aus der Zeit vor den Benutzernamen: einmal mit `docker compose down -v`
löschen, danach legt `npm run precheck` die Testkonten neu an.

Passwort vergessen: Auf der Seite Kreis erzeugt der Administrator mit der Taste
„Passwort-Link“ neben einem Mitglied einen Link (24 Stunden gültig, einmal nutzbar).

### Prüfliste Medikamentenplan (fiktive Szenarien)

Die Szenarien legt `scripts/testdaten.mjs` nur auf einer leeren Datenbank an: vorher
`docker compose down -v`, danach `npm run precheck` oder `npm run dev:lokal`. Erscheint der
Hinweis „ohne zurückdatierte Zeiten“, fehlen die Zeiten bei 5 und 6 (Docker nicht erreichbar).

| Nr. | Medikament | Was es zeigt |
| --- | --- | --- |
| 1 | Prednisolon 5 mg | Ausschleichplan in 4 Stufen als Hinweis, Stufe 3 läuft heute (1 Tablette morgens), Gruppe „Zu besonderen Zeiten“ |
| 2 | Paracetamol 500 mg | Bei Bedarf, keine festen Zeiten |
| 3 | Vitamin D3 1000 I.E. | Nur Mo, Mi, Fr um 21:30, Gruppe „Zu besonderen Zeiten“ |
| 4 | Amoxicillin / Ibuprofen | Beginnt in 5 Tagen / endete vor 3 Tagen |
| 5 | Ramipril 5 mg | Dosis geändert vor 20 Tagen (5 mg → 2,5 mg) und vor 5 Tagen (2,5 mg → 5 mg) |
| 6 | Simvastatin 20 mg | Heute 19:00 mit „Morgens“ angelegt, dann auf 21:30 fest umgestellt |
| 7 | Levothyroxin 75 µg | Kopie von Levothyroxin 50 µg (wie „Duplizieren“), beginnt in 7 Tagen |

**Administrator (ThomasMuster) und Familie (SabineMuster)**

- Medikamente › Heute (PC und Handy): Gruppen wie am Tablet, je Tageszeit und je feste Uhrzeit
  („Um 06:30“, „Um 21:30“). Taste „… alle genommen“ pro Gruppe, bei fester Uhrzeit „Um 21:30 alle
  genommen“. Simvastatin steht heute nur unter „Um 21:30“, kein verpasstes 08:00. Prednisolon zeigt
  1 Tablette. Vitamin D3 nur an Mo, Mi, Fr. Amoxicillin und Ibuprofen fehlen.
- Medikamentenplan: Taste „Plan drucken“ oben, auf jeder Karte „Duplizieren“ (Symbol mit Text).
  „Duplizieren“ öffnet „Neues Medikament“ mit allen Angaben und Einnahmezeiten, gespeichert erst mit
  „Erstellen“.
- Formular: unter „Hinweise“ das Beispiel mit dem Ausschleichplan, darunter „Gruppe im
  Medikamentenplan“ (Dauermedikation, Zu besonderen Zeiten). Bei „Bei Bedarf“ ist das Feld weg.
  „Ende“ auf gestern setzen: Hinweis unter dem Feld, Speichern geht trotzdem.
- Druckansicht: A4 quer, Kopf mit Erika Muster, geb. 12.03.1941, „Erstellt von“, Druckdatum und
  Vermerk „Stand: [heute]“. Dauermedikation (Levothyroxin 50 µg und 75 µg, Metformin 1-0-1-0,
  Ramipril, Simvastatin 0-0-1-0 mit „um 21:30“, Amoxicillin mit „ab [Datum]; bis [Datum]“), Zu besonderen Zeiten
  (Prednisolon mit „ab“, „bis“ und Ausschleichplan, Vitamin D3 mit „um 21:30; Mo, Mi, Fr“), Bedarfsmedikation
  (Paracetamol, Spalten leer). Ibuprofen fehlt. Unten „Seite 1 von 2“.
- Seite 2 „Änderungen der letzten 14 Tage“: Ramipril 2,5 mg → 5 mg (vor 5 Tagen), nicht die Änderung
  vor 20 Tagen, dazu die heute angelegten Medikamente.
- „Als PDF speichern“ im Druckdialog: zwei Seiten, nichts abgeschnitten.
- Reiter „Änderungen“: dieselben Einträge, dazu Ramipril vor 20 Tagen. Gruppe ändern erscheint als
  „Gruppe im Medikamentenplan: Dauermedikation → Zu besonderen Zeiten“.

**Fachkraft (PetraSonnenschein)**

- Heute wie oben, „… alle genommen“ geht. Medikamentenplan: „Plan drucken“ ja, „Duplizieren“,
  Bearbeiten und Archivieren nein. Druckansicht wie oben.

**Freunde (KarlNachbar)**

- Keine Taste „Plan drucken“ (Freunde sehen keine Gesundheitsdaten). Die Adresse `/medications/druck` zeigt nur
  den Hinweis, dass nur Administratoren, Familie und Fachkräfte drucken dürfen.

**Betreute Person (ErikaMuster), Tablet-Ansicht**

- Tagesliste: Prednisolon morgens 1 Tablette, Simvastatin um 21:30, Vitamin D3 nur Mo, Mi, Fr.
  „Infos zur Tablette“ bei Prednisolon zeigt den Ausschleichplan unter „Hinweise“.
- Kein Zugang zu Plan, Druck und Änderungen (Adresse `/medications/druck` führt zur Startseite).

Beim Wechsel einer Stufe im Ausschleichplan passt die Familie die Menge der Einnahmezeit selbst an.

### Prüfliste Termine und Arztgespräch (E59 bis E61)

**Betreute Person (ErikaMuster), Tablet-Ansicht**

- Kachel und Fenster heißen „Termine“. „Neuer Termin“: Art, Tag, Uhrzeit, Ort, „Begleitung nötig“ und
  „Fahrt nötig“ (Feld ausgegraut bis zum Haken, Vorschläge aus Mitgliedern, Kontakten, früheren Gästen),
  Mitnehmen. „Weiter“ speichert sofort, danach 10 Minuten „Rückgängig“.
- Kachel „Arztgespräch“: „Arzttermin eintragen“ (Arzt per Vorschlag, Ort aus dem Kontakt) legt Termin
  (Art Arzt) und Gespräch an, mit der Frage „Gibt es einen neuen Medikamentenplan?“. Frage hinzufügen,
  Frage löschen (mit Rückfrage), „Angaben ändern“.
- Aufnahme: Einwilligung anhaken, „Neue Aufnahme starten“, Bildschirm bleibt an, „Aufnahme beenden“.
  Ohne Internet (Flugmodus) geht Aufnehmen und Abspielen; „Gespräch jetzt aufnehmen“ ohne Internet
  speichert auf dem Tablet und legt das Gespräch beim Senden an.
- Terminkarte des Arzttermins: Taste „Zum Arztgespräch“.

**Familie (App)**: Mitschrift bearbeiten und freigeben, Zusammenfassung freigeben. Danach am Tablet keine
Tasten mehr für Fragen, Angaben und Aufnahmen. „Freigabe zurücknehmen“ hebt das wieder auf.

**Tablet einrichten, damit eine Aufnahme nicht abbricht** (Android, Samsung Galaxy Tab):

- Einstellungen › Apps › Chrome › Akku: „Nicht eingeschränkt“ (sonst beendet der Energiesparmodus Chrome).
- Einstellungen › Akku › Hintergrund-Nutzungslimits: Chrome nicht unter „Apps im Tiefschlaf“.
- Mikrofon für die Seite erlauben (Chrome › Website-Einstellungen › Mikrofon).
- Während der Aufnahme die Ein-/Aus-Taste nicht drücken. Die App hält den Bildschirm an; schaltet jemand das
  Tablet trotzdem aus, ist alles bis dahin Aufgenommene gespeichert (Stücke zu 30 Sekunden).

### Prüfliste Arztgespräch mit KI (E63, Infomaniak)

Nur fiktive Testdaten und der Vorlesetext unten, keine echten Gespräche. Mitschrift und Zusammenfassung gehen
an Infomaniak (Schweiz), ohne Arztname, Datum und Anlass.

**Einrichten (ThomasMuster, App):** Integrationen › „Infomaniak (Arztgespräch)“ › Verbinden: Token und
Produkt-ID aus dem Passwortmanager, Modell Zusammenfassung `Qwen/Qwen3.5-397B-A17B-FP8` (Schreibweise wie im
Infomaniak-Konto). „Testen“ zeigt „Verbindung zu Infomaniak hergestellt“. Falscher Token: „Infomaniak hat den
Token abgelehnt“. Falsche Produkt-ID: „Die Produkt-ID wurde … nicht gefunden“.

**A. Ganzer Ablauf (http://localhost:3000, Tablet-Ansicht und App)**

1. ErikaMuster: Arztgespräch › „Arzttermin eintragen“ (fiktiver Arzt), Termin mit Begleitung. Im Gespräch steht
   „Gibt es einen neuen Medikamentenplan?“. Eine Frage hinzufügen, eine löschen (Rückfrage).
2. Kalender: Terminkarte zeigt „Zum Arztgespräch“, führt zum selben Gespräch.
3. Einwilligung anhaken, „Neue Aufnahme starten“, Vorlesetext (Teil D) vorlesen, „Aufnahme beenden“.
4. Nach einigen Minuten: Mitschrift und Zusammenfassung erscheinen am Tablet mit „Noch nicht geprüft“.
   SabineMuster bekommt die Meldung „Zusammenfassung bereit“.
5. SabineMuster (App): Mitschrift lesen, eine Zahl korrigieren, freigeben. Zusammenfassung prüfen, freigeben.
6. Sperre: Am Tablet keine Tasten mehr für Fragen, Angaben, Aufnahmen. In der App ebenso.
7. „Freigabe zurücknehmen“ (Mitschrift): Tablet zeigt die Tasten wieder.
8. Datum überall deutsch („Dienstag, 1. Dezember 2026“, „10:00 Uhr“). Relative Folgetermine („in drei Monaten“)
   ohne Datum: richtig so (E63), die Familie trägt das Datum ein.
9. Gegenprobe: PetraSonnenschein (Fachkraft) liest, darf aber nicht freigeben; KarlNachbar (Freunde) sieht kein
   Arztgespräch.

**B. Offline (Tablet, Flugmodus)**

1. Flugmodus an, „Gespräch jetzt aufnehmen“, 2 Minuten aufnehmen, beenden. Hinweis „Auf dem Tablet
   gespeichert“.
2. Vorhandene Mitschrift und Zusammenfassung öffnen: lesbar. Eigene Aufnahme abspielen (lokale Kopie).
3. Flugmodus aus: Aufnahme wird gesendet, das Gespräch erscheint, Mitschrift folgt.

**C. Am Tablet (Galaxy Tab A11+, Chrome)**

1. Vorher Akku-Einstellungen wie oben („Nicht eingeschränkt“, nicht im Tiefschlaf).
2. Aufnahme 30 Minuten, dann 60 Minuten: Bildschirm bleibt an, Aufnahme läuft durch. Dauer und Größe notieren
   (erwartet etwa 11 MB pro Stunde).
3. Während einer Aufnahme kurz die Ein-/Aus-Taste drücken, nach 1 Minute wieder an: Was ist gespeichert? Läuft
   die Aufnahme weiter oder endet sie mit „Das Tablet hat das Mikrofon beendet“?
4. Energiesparmodus des Tablets an, 10 Minuten aufnehmen: läuft durch?
5. Speicher: Einstellungen › Apps › Chrome › Speicher vor und nach der 60-Minuten-Aufnahme notieren.

**D. Qualität: Vorlesetext (fiktiv, zwei Personen, normales Tempo)**

> Ärztin: Guten Tag, Frau Muster. Ihr HbA1c liegt bei 7,2, das ist in Ordnung. Der Blutdruck war zu Hause
> 138 zu 82. Wir reduzieren das Ramipril von 5 auf 2,5 Milligramm, einmal morgens. Metformin 500 bleibt
> zweimal täglich. Bitte kein Ibuprofen mehr, bei Schmerzen Paracetamol, höchstens dreimal 500 Milligramm am
> Tag. Ein neues Medikament gegen das nächtliche Wasserlassen bekommen Sie nicht, trinken Sie nach 18 Uhr
> weniger. Wenn der Blutzucker unter 100 fällt, rufen Sie bitte an. Kontrolle in drei Monaten, nüchtern.
> Patientin: Gibt es einen neuen Medikamentenplan?
> Ärztin: Ja, ich drucke Ihnen den neuen Plan aus.

Prüfpunkte (je richtig / falsch notieren): HbA1c 7,2; 138 zu 82; Ramipril 5 auf 2,5 mg einmal morgens;
Metformin 500 zweimal; kein Ibuprofen; Paracetamol höchstens dreimal 500 mg; kein neues Medikament; nach 18 Uhr
weniger trinken; unter 100 anrufen; Kontrolle in drei Monaten nüchtern; Antwort auf die Standardfrage „Ja“.
Fehlerquote der Mitschrift: falsche oder fehlende Wörter geteilt durch alle Wörter (etwa 110). Zusammenfassung:
nichts erfunden, alle Prüfpunkte da. Mindestens zwei Durchläufe.
