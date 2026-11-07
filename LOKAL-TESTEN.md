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
- **Tablet-Ansicht**: unter „Kreis“ ein Gerät koppeln und den Code in einem zweiten
  Browserfenster unter http://localhost:3000/kiosk/pair eingeben.
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

Dann in der App unter **Integrationen**:

- Whisper: Adresse `http://speaches:8000`, Modell `Systran/faster-whisper-small`, Sprache `de`
- KI-Assistent: Anbieter Ollama, Adresse `http://ollama:11434`, Modell `qwen2.5:7b`

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
