// Hintergrund-Verarbeitung der Arztgespraech-Aufnahmen.
//
// Ablauf je Aufnahme: queued -> transcribing (Whisper) -> summarizing (Ollama)
// -> done. Es laeuft immer nur EINE Aufnahme gleichzeitig, weil Whisper und
// das Sprachmodell meist auf derselben Grafikkarte laufen.
//
// Datenschutz: Die Zusammenfassung entsteht nur mit einem lokalen Modell
// (Provider 'ollama'). Ist im Kreis ein Cloud-Anbieter eingestellt, bleibt es
// bei der Mitschrift (error_code LOCAL_AI_REQUIRED).

import { query } from '../../db';
import logger from '../../lib/logger';
import { broadcastToCircle } from '../../lib/broadcaster';
import { createNotification } from '../../lib/notifications';
import { decryptCredentials } from '../../utils/crypto';
import { safeFetch } from '../../utils/safeFetch';
import { aiComplete, getAiSettings, type AiSettings } from '../../services/ai';
import {
    DIRECT_SUMMARY_MAX_CHARS,
    buildSegmentPrompt,
    buildSummaryPrompt,
    splitTranscript,
    toSummaryLang,
    validateSegmentNotes,
    validateSummary,
    type SummaryLang,
} from './summary';
import { buildWhisperPrompt, loadVocabulary, vocabularyForSummary } from './vocabulary';
import { consultationText } from './texts';

const POLL_MS = 20_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MIN = 5;
const DEFAULT_WHISPER_MODEL = 'Systran/faster-whisper-small';

const envMs = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};
/** Lange Aufnahmen brauchen auf kleiner Hardware deutlich laenger als ein Diktat. */
const TRANSCRIBE_TIMEOUT_MS = envMs('CONSULTATION_TRANSCRIBE_TIMEOUT_MS', 30 * 60_000);
const SUMMARY_TIMEOUT_MS = envMs('CONSULTATION_SUMMARY_TIMEOUT_MS', 10 * 60_000);

export class ProcessingError extends Error {
    constructor(public code: string, public retryable: boolean) {
        super(code);
        this.name = 'ProcessingError';
    }
}

interface RecordingRow {
    id: string;
    consultation_id: string;
    circle_id: string;
    mime_type: string;
    attempts: number;
    consent_by_user: string | null;
    transcript: string | null;
}

// ─── Whisper ─────────────────────────────────────────────────────────────────

const EXTENSIONS: Record<string, string> = {
    'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3',
};

async function transcribe(rec: RecordingRow, lang: SummaryLang): Promise<string> {
    const integration = (await query(
        `SELECT base_url, encrypted_credentials, config FROM integrations
         WHERE circle_id = $1 AND type = 'whisper'`,
        [rec.circle_id]
    )).rows[0] as { base_url: string; encrypted_credentials: string | null; config: Record<string, unknown> | null } | undefined;
    if (!integration) throw new ProcessingError('WHISPER_NOT_CONFIGURED', false);

    const chunks = await query(
        `SELECT data FROM consultation_recording_chunks WHERE recording_id = $1 ORDER BY chunk_index`,
        [rec.id]
    );
    if (chunks.rows.length === 0) throw new ProcessingError('AUDIO_MISSING', false);
    const audio = Buffer.concat(chunks.rows.map((r: { data: Buffer }) => r.data));

    let apiKey: string | null = null;
    if (integration.encrypted_credentials) {
        try {
            apiKey = decryptCredentials(integration.encrypted_credentials).apiKey ?? null;
        } catch {
            apiKey = null;
        }
    }
    const config = integration.config ?? {};
    const model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : DEFAULT_WHISPER_MODEL;
    const language = typeof config.language === 'string' && config.language.trim() ? config.language.trim() : lang;

    const vocabulary = await loadVocabulary(rec.circle_id);
    const prompt = buildWhisperPrompt(
        { custom: vocabulary.custom.map((v) => v.term), automatic: vocabulary.automatic },
        language
    );

    const baseType = rec.mime_type.split(';')[0].trim().toLowerCase();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: rec.mime_type }), `consultation.${EXTENSIONS[baseType] ?? 'webm'}`);
    form.append('model', model);
    form.append('language', language);
    if (prompt) form.append('prompt', prompt);

    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let response: Awaited<ReturnType<typeof safeFetch>>;
    try {
        response = await safeFetch(
            `${integration.base_url.replace(/\/+$/, '')}/v1/audio/transcriptions`,
            { method: 'POST', headers, body: form },
            { timeoutMs: TRANSCRIBE_TIMEOUT_MS }
        );
    } catch {
        throw new ProcessingError('WHISPER_UNAVAILABLE', true);
    }
    if (!response.ok) {
        // Keinen Antworttext loggen: er kann Gespraechsinhalte enthalten.
        logger.warn('consultations.whisper_status', { status: response.status });
        throw new ProcessingError('WHISPER_UNAVAILABLE', response.status >= 500 || response.status === 429);
    }
    const json = (await response.json().catch(() => null)) as { text?: unknown } | null;
    const text = json && typeof json.text === 'string' ? json.text.trim() : '';
    if (!text) throw new ProcessingError('EMPTY_TRANSCRIPT', false);
    return text;
}

// ─── Zusammenfassung ─────────────────────────────────────────────────────────

/** Lokale KI des Kreises, oder ein Fehlercode, warum es keine gibt. */
export async function localAiFor(circleId: string): Promise<AiSettings | 'AI_NOT_CONFIGURED' | 'LOCAL_AI_REQUIRED'> {
    const settings = await getAiSettings(circleId);
    if (!settings) return 'AI_NOT_CONFIGURED';
    if (settings.provider !== 'ollama') return 'LOCAL_AI_REQUIRED';
    return settings;
}

/**
 * Erstellt die Zusammenfassung eines Gespraechs aus ALLEN fertigen
 * Mitschriften und speichert sie als Entwurf. Gibt einen Hinweis-Code zurueck,
 * wenn keine Zusammenfassung moeglich war (Mitschrift bleibt erhalten).
 */
export async function summarizeConsultation(consultationId: string, circleId: string): Promise<string | null> {
    const ai = await localAiFor(circleId);
    if (typeof ai === 'string') return ai;

    const consultation = (await query(
        `SELECT doctor_name, specialty, reason, to_char(scheduled_at, 'YYYY-MM-DD') AS date,
                to_char(created_at, 'YYYY-MM-DD') AS created_date
         FROM consultations WHERE id = $1 AND circle_id = $2`,
        [consultationId, circleId]
    )).rows[0];
    if (!consultation) return null;

    const transcripts = await query(
        `SELECT transcript FROM consultation_recordings
         WHERE consultation_id = $1 AND transcript IS NOT NULL ORDER BY created_at`,
        [consultationId]
    );
    const transcript = transcripts.rows.map((r: { transcript: string }) => r.transcript).join('\n\n').trim();
    if (!transcript) return 'EMPTY_TRANSCRIPT';

    const questions = (await query(
        `SELECT text FROM consultation_questions WHERE consultation_id = $1 ORDER BY position, created_at`,
        [consultationId]
    )).rows.map((r: { text: string }) => r.text);

    const lang = await circleLanguage(circleId);
    const vocabulary = await loadVocabulary(circleId);
    const ctx = {
        lang,
        date: consultation.date ?? consultation.created_date ?? null,
        doctor: consultation.doctor_name,
        specialty: consultation.specialty,
        reason: consultation.reason,
        questions,
        vocabulary: vocabularyForSummary({ custom: vocabulary.custom.map((v) => v.term), automatic: vocabulary.automatic }),
    };

    let material: { transcript?: string; notes?: string[] };
    if (transcript.length <= DIRECT_SUMMARY_MAX_CHARS) {
        material = { transcript };
    } else {
        const segments = splitTranscript(transcript);
        const notes: string[] = [];
        for (let i = 0; i < segments.length; i++) {
            const raw = await aiComplete(ai, { ...buildSegmentPrompt(segments[i], i, segments.length, lang), timeoutMs: SUMMARY_TIMEOUT_MS });
            notes.push(...validateSegmentNotes(raw));
        }
        material = { notes };
    }

    const raw = await aiComplete(ai, { ...buildSummaryPrompt(material, ctx), timeoutMs: SUMMARY_TIMEOUT_MS });
    const summary = validateSummary(raw, questions.length);

    await query(
        `UPDATE consultations SET summary = $1::jsonb, summary_status = 'draft', approved_by = NULL, approved_at = NULL
         WHERE id = $2 AND circle_id = $3`,
        [JSON.stringify(summary), consultationId, circleId]
    );
    return null;
}

/** Sprache des Kreises: die Sprache des ersten Admins, sonst Deutsch. */
async function circleLanguage(circleId: string): Promise<SummaryLang> {
    const row = (await query(
        `SELECT u.language FROM circle_members m JOIN users u ON u.id = m.user_id
         WHERE m.circle_id = $1 ORDER BY (m.role = 'admin') DESC, m.created_at LIMIT 1`,
        [circleId]
    )).rows[0] as { language?: string } | undefined;
    return toSummaryLang(row?.language);
}

// ─── Benachrichtigung ────────────────────────────────────────────────────────

async function notifyFamily(circleId: string, consultationId: string, kind: 'summary' | 'transcript' | 'failed') {
    const c = (await query(`SELECT doctor_name, specialty FROM consultations WHERE id = $1`, [consultationId])).rows[0];
    const members = await query(
        `SELECT u.id, u.language FROM circle_members m JOIN users u ON u.id = m.user_id
         WHERE m.circle_id = $1 AND m.role IN ('admin', 'family')`,
        [circleId]
    );
    for (const member of members.rows as Array<{ id: string; language: string }>) {
        const title = [c?.doctor_name, c?.specialty].filter(Boolean).join(', ')
            || consultationText(member.language, 'defaultTitle');
        await createNotification({
            userId: member.id,
            circleId,
            type: 'consultation',
            relatedId: consultationId,
            url: `/consultations/${consultationId}`,
            title: consultationText(member.language, kind === 'failed' ? 'failedTitle' : 'summaryReadyTitle'),
            message: consultationText(
                member.language,
                kind === 'failed' ? 'failedBody' : kind === 'summary' ? 'summaryReadyBody' : 'transcriptReadyBody',
                { title }
            ),
        });
    }
}

// ─── Warteschlange ───────────────────────────────────────────────────────────

const setStatus = async (id: string, status: string, extra = '') =>
    query(`UPDATE consultation_recordings SET status = $1 ${extra} WHERE id = $2`, [status, id]);

/** Holt die naechste faellige Aufnahme und markiert sie atomar als in Arbeit. */
async function claimNext(): Promise<RecordingRow | null> {
    const result = await query(
        `UPDATE consultation_recordings SET status = 'transcribing', attempts = attempts + 1
         WHERE id = (
            SELECT id FROM consultation_recordings
            WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
            ORDER BY uploaded_at NULLS LAST, created_at
            FOR UPDATE SKIP LOCKED LIMIT 1
         )
         RETURNING id, consultation_id, circle_id, mime_type, attempts, consent_by_user, transcript`
    );
    return (result.rows[0] as RecordingRow) ?? null;
}

export async function processRecording(rec: RecordingRow): Promise<void> {
    const broadcast = () => broadcastToCircle(rec.circle_id, { type: 'update', entity: 'consultations', action: 'updated' });
    try {
        await broadcast();
        // Bei einer Wiederholung nach fehlgeschlagener Zusammenfassung ist die Mitschrift schon da.
        if (!rec.transcript) {
            const lang = await circleLanguage(rec.circle_id);
            const text = await transcribe(rec, lang);
            await query(`UPDATE consultation_recordings SET transcript = $1 WHERE id = $2`, [text, rec.id]);
        }
        await setStatus(rec.id, 'summarizing');
        await broadcast();

        let note: string | null;
        try {
            note = await summarizeConsultation(rec.consultation_id, rec.circle_id);
        } catch (error) {
            logger.warn('consultations.summary_failed', { error: error instanceof Error ? error.message : String(error) });
            throw new ProcessingError('AI_FAILED', true);
        }
        await query(
            `UPDATE consultation_recordings SET status = 'done', error_code = $1, processed_at = NOW(), next_attempt_at = NULL
             WHERE id = $2`,
            [note, rec.id]
        );
        await notifyFamily(rec.circle_id, rec.consultation_id, note ? 'transcript' : 'summary');
    } catch (error) {
        const code = error instanceof ProcessingError ? error.code : 'INTERNAL';
        const retryable = error instanceof ProcessingError ? error.retryable : true;
        if (!(error instanceof ProcessingError)) {
            logger.error('consultations.processing_error', { error: error instanceof Error ? error.message : String(error) });
        }
        if (retryable && rec.attempts < MAX_ATTEMPTS) {
            await query(
                `UPDATE consultation_recordings SET status = 'queued', error_code = $1,
                    next_attempt_at = NOW() + ($2 || ' minutes')::interval WHERE id = $3`,
                [code, String(RETRY_DELAY_MIN * rec.attempts), rec.id]
            );
        } else {
            await query(`UPDATE consultation_recordings SET status = 'failed', error_code = $1 WHERE id = $2`, [code, rec.id]);
            await notifyFamily(rec.circle_id, rec.consultation_id, 'failed');
        }
    } finally {
        await broadcast();
    }
}

let running = false;
let timer: NodeJS.Timeout | null = null;

export async function processQueueOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
        // Nacheinander abarbeiten, solange etwas faellig ist.
        for (let rec = await claimNext(); rec; rec = await claimNext()) {
            await processRecording(rec);
        }
    } catch (error) {
        logger.error('consultations.queue_error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
        running = false;
    }
}

/** Startet die Warteschlange. Nach einem Neustart werden haengende Aufnahmen neu eingereiht. */
export function startConsultationProcessor(): void {
    void query(
        `UPDATE consultation_recordings SET status = 'queued' WHERE status IN ('transcribing', 'summarizing')`
    ).catch((error) => logger.error('consultations.requeue_failed', { error: String(error) }))
        .finally(() => {
            void processQueueOnce();
            timer = setInterval(() => void processQueueOnce(), POLL_MS);
        });
}

export function stopConsultationProcessor(): void {
    if (timer) clearInterval(timer);
    timer = null;
}

/** Sofort anstossen, z. B. nachdem ein Upload fertig ist. */
export function kickConsultationProcessor(): void {
    void processQueueOnce();
}
