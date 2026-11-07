# Arztgespräch-Modul: API-Vertrag

Alle Routen unter `/api/consultations`. Antworten im üblichen Format `{ success, data, error }`.
Zeiten sind naive lokale Zeitstempel `YYYY-MM-DDTHH:mm:ss` wie im übrigen OpenCare.

## Rollen

- Lesen: admin, family, professional, viewer
- Schreiben (Gespräche, Fragen, Zusammenfassung, Freigabe, Aufgaben): admin, family
- Aufnahme hochladen: admin, family oder gekoppeltes Patienten-Gerät (`X-Kiosk-Token`)
- neighbor: kein Zugriff

## Gespräche

| Methode | Pfad | Body | Antwort `data` |
|---|---|---|---|
| GET | `/` | | `ConsultationListItem[]` |
| POST | `/` | `{ doctor_name, specialty, scheduled_at, location, reason, create_event?: boolean }` | `Consultation` |
| GET | `/:id` | | `ConsultationDetail` |
| PUT | `/:id` | Teilmenge von `{ doctor_name, specialty, scheduled_at, location, reason, notes }` | `Consultation` |
| DELETE | `/:id` | | `null` |

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
| POST | `/:id/summary/regenerate` | | Zusammenfassung aus allen Mitschriften neu erstellen (läuft im Hintergrund) |
| POST | `/:id/tasks` | `{ steps: { text, due: string \| null }[] }` | legt Aufgaben an, `data: { created: number }` |

## Aufnahmen (Upload in Stücken)

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| POST | `/recordings` | `{ client_id: uuid, consultation_id: uuid \| null, consent_confirmed: true, mime_type, started_at }` | `{ id, consultation_id, status, received: number[] }`. Ohne `consultation_id` wird ein Gespräch „Arztgespräch“ mit heutigem Datum angelegt (für das Tablet). Wiederholter Aufruf mit gleicher `client_id` liefert denselben Datensatz. Ohne `consent_confirmed: true` → 400 `CONSENT_REQUIRED`. |
| GET | `/recordings/:clientId` | | `{ id, consultation_id, status, received: number[], error_code }` |
| PUT | `/recordings/:clientId/chunks/:index` | Rohdaten, `Content-Type: application/octet-stream`, höchstens 2 MB | `{ received: number }`. Gleiches Stück erneut senden ist erlaubt. |
| POST | `/recordings/:clientId/complete` | `{ total_chunks, duration_seconds }` | `{ status: 'queued' }`, oder 409 `{ error: 'MISSING_CHUNKS', missing: number[] }` |
| POST | `/recordings/:id/retry` | | Verarbeitung erneut einreihen (admin, family) |
| DELETE | `/recordings/:id/audio` | | Audio löschen, Mitschrift bleibt (admin, family) |

Status einer Aufnahme: `uploading` → `queued` → `transcribing` → `summarizing` → `done`, oder `failed`.

`error_code`: `WHISPER_NOT_CONFIGURED`, `WHISPER_UNAVAILABLE`, `EMPTY_TRANSCRIPT`, `AI_NOT_CONFIGURED`
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
  question_answers: { question_index: number; answer: string | null }[]; // Index in questions (nach position sortiert)
  unclear: string[];
}
```
