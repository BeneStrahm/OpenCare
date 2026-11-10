# Arztgespräch-Modul: API-Vertrag

Alle Routen unter `/api/consultations`. Antworten im üblichen Format `{ success, data, error }`.
Zeiten sind naive lokale Zeitstempel `YYYY-MM-DDTHH:mm:ss` wie im übrigen OpenCare.

## Rollen

- Lesen: admin, family, professional (neighbor und recipient NICHT: Mitschriften und KI-Entwürfe sind Gesundheitsdaten)
- Schreiben (Gespräche, Fragen, Zusammenfassung, Freigabe, Aufgaben): admin, family
- Aufnahme hochladen: admin, family (gekoppelte Patienten-Geräte gibt es seit Launch Block C nicht mehr)
- neighbor: kein Zugriff

## Gespräche

| Methode | Pfad | Body | Antwort `data` |
|---|---|---|---|
| GET | `/` | | `ConsultationListItem[]` |
| POST | `/` | `{ doctor_name, specialty, scheduled_at, location, reason, create_event?: boolean }` | `Consultation` |
| GET | `/:id` | | `ConsultationDetail` |
| PUT | `/:id` | Teilmenge von `{ doctor_name, specialty, scheduled_at, location, reason, notes }` | `Consultation`. Ein beim Anlegen erzeugter Kalendertermin (`event_id`) wird mit angepasst. |
| DELETE | `/:id` | | `null`. Der beim Anlegen erzeugte Kalendertermin wird mit gelöscht. |

## Fragen (Vorbereitung und Nachbereitung)

| Methode | Pfad | Body |
|---|---|---|
| POST | `/:id/questions` | `{ text }` |
| PUT | `/:id/questions/:qid` | `{ text?, answer?, position? }` |
| DELETE | `/:id/questions/:qid` | |

## Zusammenfassung

| Methode | Pfad | Body | Wirkung |
|---|---|---|---|
| PUT | `/:id/summary` | `{ summary: ConsultationSummary }` | Entwurf bearbeiten, Status bleibt `draft` |
| POST | `/:id/summary/approve` | `{ summary?: ConsultationSummary }` | Status `approved`, Antworten zu Fragen werden in leere `answer`-Felder übernommen |
| POST | `/:id/summary/regenerate` | | Zusammenfassung aus allen Mitschriften neu erstellen (läuft im Hintergrund). ERSETZT auch eine freigegebene oder von Hand bearbeitete Fassung, der Client muss das vorher deutlich bestätigen lassen. |
| POST | `/:id/apply` | `{ tasks?: { text, due: string \| null }[], appointments?: { title, date, time, location }[], notes?: { content }[] }` | legt NUR die bestätigten Vorschläge an (je Liste höchstens 20). Termine brauchen Datum (JJJJ-MM-TT) UND Uhrzeit (HH:MM), sonst 400 `APPOINTMENT_DATE_TIME_REQUIRED`. Bereits übernommene werden übersprungen. `data: { tasks, appointments, notes, skipped, applied: string[] }` |

### Schutz von Freigaben

Eine KI-Zusammenfassung ersetzt automatisch nur einen KI-Entwurf. Ist die Zusammenfassung
freigegeben (`approved`) oder von Hand bearbeitet (`summary_source: 'human'`) und kommt eine weitere
Aufnahme dazu, bleibt sie unverändert und `summary_outdated` wird `true`. Die Oberfläche zeigt dann
einen Hinweis mit der Möglichkeit, über `regenerate` neu zu erstellen.

### Vorschläge und Bestätigung

Die Zusammenfassung enthält nur Vorschläge: `next_steps` (Aufgaben), `appointments` (Termine) und
`family_notes` (Notizen für die Familien-Pinnwand). Angelegt wird nichts automatisch. Die Oberfläche
zeigt jeden Vorschlag bearbeitbar mit Auswahl an und schickt erst nach Bestätigung `POST /:id/apply`.

`Consultation.applied` ist ein Objekt `{ [key]: createdId }`. Schlüssel:
- Aufgabe: `task:` + Text
- Termin: `event:` + Titel + Leerzeichen + `JJJJ-MM-TTTHH:MM:00`
- Notiz: `note:` + Text

Der Text wird dabei normalisiert: Mehrfach-Leerraum zu einem Leerzeichen, trim, Kleinschreibung
(`toLocaleLowerCase`). Ein Vorschlag gilt als übernommen, wenn sein Schlüssel in `applied` steht.

## Fachwörter für die Spracherkennung

| Methode | Pfad | Body | Antwort `data` |
|---|---|---|---|
| GET | `/vocabulary` | | `{ custom: { id, term, created_at }[], automatic: string[] }` |
| POST | `/vocabulary` | `{ term }` (höchstens 80 Zeichen) | `{ id, term, created_at }`, Duplikat → 409 `DUPLICATE` |
| DELETE | `/vocabulary/:id` | | `null` |

`automatic` enthält Medikamentennamen, Ärzte und Fachrichtungen des Kreises. Whisper bekommt daraus
einen Kontext in dieser Reihenfolge: eigene Wörter, automatische Wörter, eine deutsche Grundliste.
Die Zusammenfassung bekommt die eigenen und automatischen Wörter als Schreibhilfe.

## Aufnahmen (Upload in Stücken)

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| POST | `/recordings` | `{ client_id: uuid, consultation_id: uuid \| null, consent_confirmed: true, consent_at?, mime_type, started_at }` (`consent_at`: Zeitpunkt der Bestätigung auf dem Gerät, naiver lokaler Zeitstempel; ohne Angabe gilt die Serverzeit) | `{ id, consultation_id, status, received: number[] }`. Ohne `consultation_id` wird ein Gespräch „Arztgespräch“ mit heutigem Datum angelegt (für das Tablet). Wiederholter Aufruf mit gleicher `client_id` liefert denselben Datensatz. Ohne `consent_confirmed: true` → 400 `CONSENT_REQUIRED`. |
| GET | `/recordings/:clientId` | | `{ id, consultation_id, status, received: number[], error_code }` |
| PUT | `/recordings/:clientId/chunks/:index` | Rohdaten, `Content-Type: application/octet-stream`, höchstens 2 MB | `{ received: number }`. Gleiches Stück erneut senden ist erlaubt. |
| POST | `/recordings/:clientId/complete` | `{ total_chunks, duration_seconds }` | `{ status: 'queued' }`, oder 409 `{ error: 'MISSING_CHUNKS', missing: number[] }` |
| POST | `/recordings/:id/retry` | | Verarbeitung erneut einreihen (admin, family) |
| DELETE | `/recordings/:id/audio` | | Audio löschen, Mitschrift bleibt (admin, family) |

Status einer Aufnahme: `uploading` → `queued` → `transcribing` → `summarizing` → `done`, oder `failed`.

`error_code`: `LOCAL_SERVICE_REQUIRED` (Whisper- oder KI-Adresse liegt nicht im eigenen Netz, es wurde nichts gesendet), `AUDIO_MISSING` (Audio fehlt, Wiederholen hilft nicht), `CONSULTATION_DELETED`, `WHISPER_NOT_CONFIGURED`, `WHISPER_UNAVAILABLE`, `EMPTY_TRANSCRIPT`, `AI_NOT_CONFIGURED`
(nur Mitschrift, keine Zusammenfassung, Status bleibt `done`), `LOCAL_AI_REQUIRED` (KI des Kreises ist
nicht Ollama, Status `done` ohne Zusammenfassung), `AI_FAILED`, `INTERNAL`.

WebSocket: Änderungen werden als `{ type: 'update', entity: 'consultations', action }` an den Kreis gesendet.

## Typen

```ts
interface Consultation {
  id: string; circle_id: string;
  doctor_name: string | null; specialty: string | null;
  scheduled_at: string | null; location: string | null; reason: string | null;
  event_id: string | null; notes: string | null;
  summary: ConsultationSummary | null;
  summary_status: 'none' | 'draft' | 'approved';
  approved_by_name: string | null; approved_at: string | null;
  applied: Record<string, string>;  // übernommene Vorschläge, siehe oben
  summary_source: 'ai' | 'human' | null;
  summary_outdated: boolean;        // neue Aufnahme nach Freigabe/Bearbeitung
  created_at: string; updated_at: string;
}
interface ConsultationListItem extends Omit<Consultation, 'summary' | 'notes'> {
  question_count: number;
  recording_count: number;
  latest_recording_status: RecordingStatus | null;
}
interface ConsultationQuestion { id: string; text: string; answer: string | null; position: number; created_at: string; }
type RecordingStatus = 'uploading' | 'queued' | 'transcribing' | 'summarizing' | 'done' | 'failed';
interface ConsultationRecording {
  id: string; client_id: string; status: RecordingStatus; error_code: string | null;
  duration_seconds: number | null; size_bytes: number; consent_at: string;
  created_at: string; processed_at: string | null; audio_deleted_at: string | null;
}
interface ConsultationDetail {
  consultation: Consultation;
  questions: ConsultationQuestion[];
  recordings: ConsultationRecording[];
  /** Alle Mitschriften der fertigen Aufnahmen, in Reihenfolge, oder null */
  transcript: string | null;
}
interface ConsultationSummary {
  overview: string;
  findings: string[];
  medication_changes: { name: string; change: string }[];
  recommendations: string[];
  next_steps: { text: string; due: string | null }[];   // due: YYYY-MM-DD
  // question_id ist maßgeblich (seit Fork-Fix). question_index nur noch zur Anzeige älterer Entwürfe.
  question_answers: { question_id: string | null; question_index: number; answer: string | null }[];
  unclear: string[];
  appointments: { title: string; date: string | null; time: string | null; location: string | null }[]; // Vorschläge
  family_notes: string[]; // Vorschläge für die Pinnwand
}
```
