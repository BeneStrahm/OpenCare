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

Anmeldung mit Benutzername (Vorname und Nachname, Groß- und Kleinschreibung egal).
Passwort für alle: `Testpasswort-123`

| Rolle | Benutzername |
| --- | --- |
| Administrator | Thomas Muster |
| Familie | Sabine Muster |
| Fachkraft | Petra Sonnenschein |
| Freunde | Karl Nachbar |
| Betreute Person | Erika Muster |

Lokale Datenbank aus der Zeit vor den Benutzernamen: einmal mit `docker compose down -v`
löschen, danach legt `npm run precheck` die Testkonten neu an.

Passwort vergessen: Auf der Seite Kreis erzeugt der Administrator mit der Taste
„Passwort-Link“ neben einem Mitglied einen Link (24 Stunden gültig, einmal nutzbar).
