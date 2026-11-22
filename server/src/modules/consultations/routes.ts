// Routen des Arztgespraech-Moduls. Vertrag: docs/consultations-api.md
//
// Zwei Router:
//  - recordingsRouter (/api/consultations/recordings): Upload in Stuecken.
//  - consultationsRouter (/api/consultations): alles andere, nur Mitglieder.

import express, { Router, Response } from 'express';
import { query, getClient } from '../../db';
import { authMiddleware } from '../../middleware/auth';
import {
    circleMiddleware, requireRole, requireRoleOrTeam, CircleRequest, CircleRole, CONSULTATION_READER_ROLES, CONSULTATION_PREPARER_ROLES,
} from '../../middleware/circle';
import { cleanPersonName } from '../../lib/eventExtras';
import { broadcastToCircle } from '../../lib/broadcaster';
import logger from '../../lib/logger';
import { sanitizeSummaryForQuestions, isValidIsoDate, type ConsultationSummary } from './summary';
import { loadVocabulary, normalizeTerm } from './vocabulary';
import { kickConsultationProcessor } from './processing';
import { consultationText } from './texts';
import { addDefaultQuestion } from './eventLink';

// Lesen: admin, family, professional und (E59) recipient; neighbor nie (zentral in middleware/circle.ts).
export const READER_ROLES: CircleRole[] = CONSULTATION_READER_ROLES;
// Pruefen, freigeben, bearbeiten, Vorschlaege uebernehmen, Audio loeschen: nur admin und family.
export const WRITER_ROLES: CircleRole[] = ['admin', 'family'];
// E59: Gespraech anlegen, Angaben aendern, Fragen hinzufuegen und loeschen, aufnehmen: auch recipient.
export const PREPARER_ROLES: CircleRole[] = CONSULTATION_PREPARER_ROLES;

const requireReader = requireRole(...READER_ROLES);
const requireWriter = requireRole(...WRITER_ROLES);
// E64: Mitschrift und Zusammenfassung pruefen und freigeben auch im Teambereich am Tablet (PIN).
const requireWriterOrTeam = requireRoleOrTeam(...WRITER_ROLES);
const requirePreparer = requireRole(...PREPARER_ROLES);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAIVE_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const ALLOWED_MIME = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/mpeg'];

export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_CHUNKS = 2000;
export const MAX_RECORDING_BYTES = 300 * 1024 * 1024;

const notify = (circleId: string, action: 'created' | 'updated' | 'deleted') =>
    broadcastToCircle(circleId, { type: 'update', entity: 'consultations', action });

const text = (value: unknown, max: number): string | null => {
    if (typeof value !== 'string') return null;
    const t = value.trim();
    return t ? t.slice(0, max) : null;
};

const timestamp = (value: unknown): string | null | undefined => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') return undefined;
    if (!NAIVE_TS_RE.test(value) || !isValidIsoDate(value.slice(0, 10))) return undefined;
    return value.length === 16 ? `${value}:00` : value;
};

const fail = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) =>
    res.status(status).json({ success: false, error, ...extra });

const serverError = (res: Response, where: string, error: unknown) => {
    logger.error(`consultations.${where}`, { error: error instanceof Error ? error.message : String(error) });
    return fail(res, 500, 'Internal server error');
};

// E59: Ist das Gespraech mit einem Termin verknuepft, gelten Zeit und Ort des Termins (eine Stelle).
// Begleitung und Fahrt stehen nur am Termin (companion_*, travel_*, driver).
const CONSULTATION_COLUMNS = `c.id, c.circle_id, c.doctor_name, c.specialty,
    COALESCE(e.start_time, c.scheduled_at) AS scheduled_at, COALESCE(e.location, c.location) AS location, c.reason,
    c.event_id, c.notes, c.summary, c.summary_status, c.approved_at, u.name AS approved_by_name, c.summary_source, c.summary_outdated,
    c.transcript_status, c.transcript_approved_at, tu.name AS transcript_approved_by_name,
    e.companion_needed AS event_companion_needed, e.member_ids AS event_member_ids, e.guests AS event_guests,
    e.travel_needed AS event_travel_needed, e.driver_to AS event_driver, e.take_along AS event_take_along,
    c.created_at, c.updated_at`;

const CONSULTATION_FROM = `consultations c
    LEFT JOIN users u ON u.id = c.approved_by
    LEFT JOIN users tu ON tu.id = c.transcript_approved_by
    LEFT JOIN events e ON e.id = c.event_id AND e.circle_id = c.circle_id`;

/** Namen der Begleitung aus dem Termin: Mitglieder (Kreis) und Gaeste, nur wenn "Begleitung noetig" aktiv. */
async function companionNames(circleId: string, row: Record<string, unknown>): Promise<string[]> {
    const memberIds = Array.isArray(row.event_member_ids) ? (row.event_member_ids as string[]) : [];
    const guests = Array.isArray(row.event_guests) ? (row.event_guests as string[]) : [];
    const active = row.event_companion_needed ?? (memberIds.length > 0 || guests.length > 0);
    if (!active) return [];
    let names: string[] = [];
    if (memberIds.length > 0) {
        const r = await query(
            `SELECT u.name FROM circle_members m JOIN users u ON u.id = m.user_id
             WHERE m.circle_id = $1 AND m.id = ANY($2::uuid[]) ORDER BY u.name`,
            [circleId, memberIds]
        );
        names = r.rows.map((x: { name: string }) => x.name);
    }
    return [...names, ...guests];
}

async function loadConsultation(id: string, circleId: string) {
    if (!UUID_RE.test(id)) return null;
    const result = await query(
        `SELECT ${CONSULTATION_COLUMNS} FROM ${CONSULTATION_FROM}
         WHERE c.id = $1 AND c.circle_id = $2`,
        [id, circleId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const {
        event_companion_needed, event_member_ids, event_guests, event_travel_needed, event_driver, event_take_along, ...rest
    } = row;
    const companions = await companionNames(circleId, row);
    return {
        ...rest,
        companion_needed: row.event_id ? Boolean(event_companion_needed ?? companions.length > 0) : false,
        companion_member_ids: Array.isArray(event_member_ids) ? event_member_ids : [],
        companions,
        travel_needed: row.event_id ? Boolean(event_travel_needed) : false,
        driver: event_driver ?? null,
        take_along: event_take_along ?? null,
        locked: isLocked(row),
    };
}

/**
 * E59: Sind Mitschrift und Zusammenfassung freigegeben, aendert niemand mehr Fragen,
 * Angaben oder Aufnahmen. admin und family koennen eine Freigabe zuruecknehmen.
 */
export function isLocked(c: { transcript_status?: string | null; summary_status?: string | null }): boolean {
    return c.transcript_status === 'approved' && c.summary_status === 'approved';
}

/** Titel des Termins zu einem Arztgespraech: "Arztgespraech: Dr. ..." */
function eventTitle(lang: unknown, doctor: string | null, specialty: string | null): string {
    const label = consultationText(lang, 'defaultTitle');
    const who = [doctor, specialty].filter(Boolean).join(', ');
    return (who ? `${label}: ${who}` : label).slice(0, 255);
}


// ═════════════════════════════════════════════════════════════════════════════
// Aufnahmen
// ═════════════════════════════════════════════════════════════════════════════

export const recordingsRouter = Router();
recordingsRouter.use(authMiddleware, circleMiddleware);

const RECORDING_PUBLIC = `id, client_id, consultation_id, status, error_code, duration_seconds, size_bytes,
    consent_at, created_at, processed_at, audio_deleted_at`;

async function receivedChunks(recordingId: string): Promise<number[]> {
    const r = await query(
        `SELECT chunk_index FROM consultation_recording_chunks WHERE recording_id = $1 ORDER BY chunk_index`,
        [recordingId]
    );
    return r.rows.map((row: { chunk_index: number }) => row.chunk_index);
}

async function recordingByClientId(clientId: string, circleId: string) {
    if (!UUID_RE.test(clientId)) return null;
    const r = await query(
        `SELECT ${RECORDING_PUBLIC} FROM consultation_recordings WHERE client_id = $1 AND circle_id = $2`,
        [clientId, circleId]
    );
    return r.rows[0] ?? null;
}

// POST /recordings: Aufnahme anmelden (idempotent ueber client_id)
recordingsRouter.post('/', requirePreparer, async (req: CircleRequest, res: Response) => {
    const circleId = req.circleId!;
    const body = req.body ?? {};
    try {
        if (body.consent_confirmed !== true) return fail(res, 400, 'CONSENT_REQUIRED');
        const clientId = typeof body.client_id === 'string' ? body.client_id : '';
        if (!UUID_RE.test(clientId)) return fail(res, 400, 'INVALID_CLIENT_ID');
        const mime = typeof body.mime_type === 'string' ? body.mime_type.trim().slice(0, 80) : '';
        if (!ALLOWED_MIME.includes(mime.split(';')[0].toLowerCase())) return fail(res, 400, 'UNSUPPORTED_AUDIO');
        const startedAt = timestamp(body.started_at);
        if (startedAt === undefined) return fail(res, 400, 'INVALID_STARTED_AT');

        const existing = await recordingByClientId(clientId, circleId);
        if (existing) {
            return res.json({ success: true, data: { ...existing, received: await receivedChunks(existing.id) } });
        }
        // Gleiche client_id in einem anderen Kreis: nicht verraten, einfach ablehnen.
        const elsewhere = await query(`SELECT 1 FROM consultation_recordings WHERE client_id = $1`, [clientId]);
        if (elsewhere.rows.length > 0) return fail(res, 409, 'CLIENT_ID_TAKEN');

        // Zeitpunkt der Bestaetigung auf dem Geraet (kann vor dem Upload liegen, z. B. offline).
        // Nur plausible Werte: nicht in der Zukunft, hoechstens 30 Tage alt. Sonst Serverzeit.
        const consentRaw = timestamp(body.consent_at);
        if (consentRaw === undefined) return fail(res, 400, 'INVALID_CONSENT_AT');

        let consultationId: string | null = typeof body.consultation_id === 'string' ? body.consultation_id : null;
        if (consultationId) {
            const c = await loadConsultation(consultationId, circleId);
            if (!c) return fail(res, 404, 'Consultation not found');
            // E59: nach beiden Freigaben keine neuen Aufnahmen.
            if (c.locked) return fail(res, 409, 'CONSULTATION_LOCKED');
        }
        const db = await getClient();
        let inserted;
        try {
            await db.query('BEGIN');
        if (!consultationId) {
            // Ohne vorbereitetes Gespraech: neues Gespraech mit Startzeit anlegen.
            const created = await db.query(
                `INSERT INTO consultations (circle_id, scheduled_at, created_by, created_by_device)
                 VALUES ($1, COALESCE($2::timestamp, date_trunc('minute', NOW()::timestamp)), $3, $4) RETURNING id`,
                [circleId, startedAt, req.userId, null]
            );
            consultationId = created.rows[0].id as string;
            await addDefaultQuestion(db, consultationId, circleId, req.headers['accept-language'], req.userId);
        }

        inserted = await db.query(
            `INSERT INTO consultation_recordings
                (consultation_id, circle_id, client_id, mime_type, consent_at, consent_by_user, consent_by_device, started_at)
             VALUES ($1, $2, $3, $4,
                CASE WHEN $8::timestamp IS NOT NULL AND $8::timestamp <= NOW()::timestamp + interval '5 minutes'
                      AND $8::timestamp >= NOW()::timestamp - interval '30 days' THEN $8::timestamp ELSE NOW()::timestamp END,
                $5, $6, $7)
             RETURNING ${RECORDING_PUBLIC}`,
            [consultationId, circleId, clientId, mime, req.userId, null, startedAt, consentRaw]
        );
            await db.query('COMMIT');
        } catch (error) {
            await db.query('ROLLBACK').catch(() => undefined);
            // Zwei gleichzeitige Anmeldungen mit derselben client_id: die erste gewinnt.
            if ((error as { code?: string }).code === '23505') {
                const again = await recordingByClientId(clientId, circleId);
                if (again) return res.json({ success: true, data: { ...again, received: await receivedChunks(again.id) } });
                return fail(res, 409, 'CLIENT_ID_TAKEN');
            }
            throw error;
        } finally {
            db.release();
        }
        await notify(circleId, 'created');
        res.json({ success: true, data: { ...inserted.rows[0], received: [] } });
    } catch (error) {
        return serverError(res, 'recording_create', error);
    }
});

// GET /recordings/:clientId: Stand des Uploads
recordingsRouter.get('/:clientId', requirePreparer, async (req: CircleRequest, res: Response) => {
    try {
        const rec = await recordingByClientId(String(req.params.clientId), req.circleId!);
        if (!rec) return fail(res, 404, 'Recording not found');
        res.json({ success: true, data: { ...rec, received: await receivedChunks(rec.id) } });
    } catch (error) {
        return serverError(res, 'recording_get', error);
    }
});

// PUT /recordings/:clientId/chunks/:index: ein Stueck Audio (Rohdaten)
recordingsRouter.put(
    '/:clientId/chunks/:index',
    requirePreparer,
    (req: CircleRequest, res: Response, next: express.NextFunction) =>
        express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK_BYTES })(req, res, (err?: unknown) => {
            if (err) {
                const status = (err as { status?: number }).status;
                return fail(res, status === 413 ? 413 : 400, status === 413 ? 'CHUNK_TOO_LARGE' : 'INVALID_BODY');
            }
            next();
        }),
    async (req: CircleRequest, res: Response) => {
        try {
            const index = Number(req.params.index);
            if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) return fail(res, 400, 'INVALID_INDEX');
            const data = req.body;
            if (!Buffer.isBuffer(data) || data.length === 0) return fail(res, 400, 'EMPTY_CHUNK');

            const rec = await recordingByClientId(String(req.params.clientId), req.circleId!);
            if (!rec) return fail(res, 404, 'Recording not found');
            if (rec.status !== 'uploading') {
                // Bereits abgeschlossen: ein erneut gesendetes Stueck ist harmlos.
                return res.json({ success: true, data: { received: index } });
            }
            // Groesse zuerst atomar reservieren, dann speichern; bei Doppel oder Fehler zurueckgeben.
            const reserved = await query(
                `UPDATE consultation_recordings SET size_bytes = size_bytes + $1
                 WHERE id = $2 AND size_bytes + $1 <= $3 RETURNING id`,
                [data.length, rec.id, MAX_RECORDING_BYTES]
            );
            if (reserved.rows.length === 0) return fail(res, 413, 'RECORDING_TOO_LARGE');
            let stored = false;
            try {
                const inserted = await query(
                    `INSERT INTO consultation_recording_chunks (recording_id, chunk_index, data)
                     VALUES ($1, $2, $3) ON CONFLICT (recording_id, chunk_index) DO NOTHING RETURNING chunk_index`,
                    [rec.id, index, data]
                );
                stored = inserted.rows.length > 0;
            } finally {
                if (!stored) {
                    await query(`UPDATE consultation_recordings SET size_bytes = size_bytes - $1 WHERE id = $2`, [data.length, rec.id]);
                }
            }
            res.json({ success: true, data: { received: index } });
        } catch (error) {
            return serverError(res, 'recording_chunk', error);
        }
    }
);

// POST /recordings/:clientId/complete: alle Stuecke da, Verarbeitung einreihen
recordingsRouter.post('/:clientId/complete', requirePreparer, async (req: CircleRequest, res: Response) => {
    try {
        const total = Number(req.body?.total_chunks);
        if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS) return fail(res, 400, 'INVALID_TOTAL');
        const durationRaw = Number(req.body?.duration_seconds);
        const duration = Number.isFinite(durationRaw) && durationRaw >= 0 ? Math.min(Math.round(durationRaw), 24 * 3600) : null;

        const rec = await recordingByClientId(String(req.params.clientId), req.circleId!);
        if (!rec) return fail(res, 404, 'Recording not found');
        if (rec.status !== 'uploading') return res.json({ success: true, data: { status: rec.status } });

        const received = new Set(await receivedChunks(rec.id));
        const missing = Array.from({ length: total }, (_, i) => i).filter((i) => !received.has(i));
        if (missing.length > 0) return fail(res, 409, 'MISSING_CHUNKS', { missing });
        const extra = [...received].filter((i) => i >= total);
        if (extra.length > 0) {
            await query(`DELETE FROM consultation_recording_chunks WHERE recording_id = $1 AND chunk_index >= $2`, [rec.id, total]);
            await query(
                `UPDATE consultation_recordings SET size_bytes =
                    (SELECT COALESCE(SUM(length(data)), 0) FROM consultation_recording_chunks WHERE recording_id = $1)
                 WHERE id = $1`,
                [rec.id]
            );
        }

        await query(
            `UPDATE consultation_recordings SET status = 'queued', total_chunks = $1, duration_seconds = $2,
                uploaded_at = NOW(), error_code = NULL WHERE id = $3`,
            [total, duration, rec.id]
        );
        await notify(req.circleId!, 'updated');
        kickConsultationProcessor();
        res.json({ success: true, data: { status: 'queued' } });
    } catch (error) {
        return serverError(res, 'recording_complete', error);
    }
});

// POST /recordings/:id/retry: erneut verarbeiten (nur Familie)
recordingsRouter.post('/:id/retry', requireRole(...WRITER_ROLES), async (req: CircleRequest, res: Response) => {
    try {
        if (!UUID_RE.test(String(req.params.id))) return fail(res, 404, 'Recording not found');
        const r = await query(
            `UPDATE consultation_recordings SET status = 'queued', attempts = 0, next_attempt_at = NULL, error_code = NULL
             WHERE id = $1 AND circle_id = $2 AND status IN ('failed', 'done')
               AND (audio_deleted_at IS NULL OR transcript IS NOT NULL)
             RETURNING id`,
            [req.params.id, req.circleId]
        );
        if (r.rows.length === 0) return fail(res, 409, 'NOT_RETRYABLE');
        await notify(req.circleId!, 'updated');
        kickConsultationProcessor();
        res.json({ success: true, data: { status: 'queued' } });
    } catch (error) {
        return serverError(res, 'recording_retry', error);
    }
});

// DELETE /recordings/:id/audio: Audio loeschen, Mitschrift bleibt
recordingsRouter.delete('/:id/audio', requireRole(...WRITER_ROLES), async (req: CircleRequest, res: Response) => {
    try {
        if (!UUID_RE.test(String(req.params.id))) return fail(res, 404, 'Recording not found');
        const r = await query(
            `UPDATE consultation_recordings SET audio_deleted_at = NOW()
             WHERE id = $1 AND circle_id = $2 AND status IN ('done', 'failed') RETURNING id`,
            [req.params.id, req.circleId]
        );
        if (r.rows.length === 0) return fail(res, 409, 'NOT_DELETABLE');
        await query(`DELETE FROM consultation_recording_chunks WHERE recording_id = $1`, [req.params.id]);
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: null });
    } catch (error) {
        return serverError(res, 'recording_delete_audio', error);
    }
});

// GET /recordings/:id/audio: Audio vom Server abspielen (E59: nach 30 Tagen ist die lokale
// Kopie auf dem Geraet weg). Nur online, nur solange das Audio nicht geloescht ist.
// Die Stuecke werden einzeln gelesen und weitergereicht, damit lange Aufnahmen den
// Arbeitsspeicher des Servers nicht fuellen.
recordingsRouter.get('/:id/audio', requireReader, async (req: CircleRequest, res: Response) => {
    try {
        if (!UUID_RE.test(String(req.params.id))) return fail(res, 404, 'Recording not found');
        const r = await query(
            `SELECT id, mime_type, status, audio_deleted_at FROM consultation_recordings WHERE id = $1 AND circle_id = $2`,
            [req.params.id, req.circleId]
        );
        const rec = r.rows[0];
        if (!rec) return fail(res, 404, 'Recording not found');
        if (rec.audio_deleted_at) return fail(res, 410, 'AUDIO_DELETED');
        if (rec.status === 'uploading') return fail(res, 409, 'NOT_UPLOADED');
        const indexes = (await query(
            `SELECT chunk_index FROM consultation_recording_chunks WHERE recording_id = $1 ORDER BY chunk_index`,
            [rec.id]
        )).rows.map((row: { chunk_index: number }) => row.chunk_index);
        if (indexes.length === 0) return fail(res, 410, 'AUDIO_DELETED');
        res.setHeader('Content-Type', String(rec.mime_type).split(';')[0]);
        res.setHeader('Cache-Control', 'private, no-store');
        for (const index of indexes) {
            const chunk = await query(
                `SELECT data FROM consultation_recording_chunks WHERE recording_id = $1 AND chunk_index = $2`,
                [rec.id, index]
            );
            if (!chunk.rows[0]) continue;
            if (!res.write(chunk.rows[0].data)) await new Promise((resolve) => res.once('drain', resolve));
            if (res.destroyed) return;
        }
        res.end();
    } catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        return serverError(res, 'recording_audio', error);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// Gespraeche, Fragen, Zusammenfassung, Fachwoerter
// ═════════════════════════════════════════════════════════════════════════════

export const consultationsRouter = Router();
consultationsRouter.use(authMiddleware);
consultationsRouter.use(circleMiddleware);

// ─── Fachwoerter ─────────────────────────────────────────────────────────────

consultationsRouter.get('/vocabulary', requireRole('admin', 'family', 'professional'), async (req: CircleRequest, res: Response) => {
    try {
        res.json({ success: true, data: await loadVocabulary(req.circleId!) });
    } catch (error) {
        return serverError(res, 'vocabulary_list', error);
    }
});

consultationsRouter.post('/vocabulary', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        const term = normalizeTerm(req.body?.term);
        if (!term) return fail(res, 400, 'TERM_REQUIRED');
        const r = await query(
            `INSERT INTO consultation_vocabulary (circle_id, term, created_by) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING RETURNING id, term, created_at`,
            [req.circleId, term, req.userId]
        );
        if (r.rows.length === 0) return fail(res, 409, 'DUPLICATE');
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: r.rows[0] });
    } catch (error) {
        return serverError(res, 'vocabulary_create', error);
    }
});

consultationsRouter.delete('/vocabulary/:id', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        if (!UUID_RE.test(String(req.params.id))) return fail(res, 404, 'Not found');
        const r = await query(`DELETE FROM consultation_vocabulary WHERE id = $1 AND circle_id = $2 RETURNING id`, [req.params.id, req.circleId]);
        if (r.rows.length === 0) return fail(res, 404, 'Not found');
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: null });
    } catch (error) {
        return serverError(res, 'vocabulary_delete', error);
    }
});

// ─── Gespraeche ──────────────────────────────────────────────────────────────

consultationsRouter.get('/', requireReader, async (req: CircleRequest, res: Response) => {
    try {
        const r = await query(
            `SELECT c.id, c.circle_id, c.doctor_name, c.specialty,
                    COALESCE(e.start_time, c.scheduled_at) AS scheduled_at, COALESCE(e.location, c.location) AS location,
                    c.reason, c.event_id, c.summary_status, c.approved_at, u.name AS approved_by_name,
                    c.transcript_status, c.created_at, c.updated_at,
                    (SELECT COUNT(*)::int FROM consultation_questions q WHERE q.consultation_id = c.id) AS question_count,
                    (SELECT COUNT(*)::int FROM consultation_recordings r WHERE r.consultation_id = c.id) AS recording_count,
                    (SELECT r.status FROM consultation_recordings r WHERE r.consultation_id = c.id
                       ORDER BY r.created_at DESC LIMIT 1) AS latest_recording_status
             FROM consultations c LEFT JOIN users u ON u.id = c.approved_by
             LEFT JOIN events e ON e.id = c.event_id AND e.circle_id = c.circle_id
             WHERE c.circle_id = $1
             ORDER BY COALESCE(e.start_time, c.scheduled_at) DESC NULLS LAST, c.created_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: r.rows.map((row: { transcript_status?: string | null; summary_status?: string | null }) => ({ ...row, locked: isLocked(row) })) });
    } catch (error) {
        return serverError(res, 'list', error);
    }
});

// POST /: neues Gespraech. Drei Wege (E59):
//  - mit event_id: Arzttermin wurde vorher ueber POST /api/events angelegt, das Gespraech wird damit
//    verknuepft (Zeit, Ort, Begleitung, Fahrt kommen dann aus dem Termin)
//  - "Gespraech jetzt aufnehmen": ohne Termin, scheduled_at = jetzt (Client schickt die Zeit)
//  - create_event (aeltere App-Seiten): legt den Termin hier mit an, Art Arzt
// Jedes neue Gespraech bekommt die Standardfrage (E61).
consultationsRouter.post('/', requirePreparer, async (req: CircleRequest, res: Response) => {
    const b = req.body ?? {};
    const scheduledAt = timestamp(b.scheduled_at);
    if (scheduledAt === undefined) return fail(res, 400, 'INVALID_SCHEDULED_AT');
    const doctor = text(b.doctor_name, 200);
    const specialty = text(b.specialty, 120);
    const location = text(b.location, 255);
    const reason = text(b.reason, 4000);
    const lang = req.headers['accept-language'];
    const linkEventId = typeof b.event_id === 'string' && b.event_id ? b.event_id : null;
    if (linkEventId && !UUID_RE.test(linkEventId)) return fail(res, 400, 'INVALID_EVENT');
    const client = await getClient();
    try {
        await client.query('BEGIN');
        let eventId: string | null = null;
        let eventCreated = false;
        if (linkEventId) {
            const ev = await client.query(
                `SELECT e.id, e.category FROM events e WHERE e.id = $1 AND e.circle_id = $2 FOR UPDATE`,
                [linkEventId, req.circleId]
            );
            if (!ev.rows[0]) { await client.query('ROLLBACK'); return fail(res, 404, 'Event not found'); }
            const taken = await client.query(`SELECT id FROM consultations WHERE event_id = $1`, [linkEventId]);
            // recipient verknuepft nur eigene, gerade angelegte Arzttermine (Rechte an fremden Terminen: keine).
            if (req.circleRole === 'recipient') {
                const own = await client.query(
                    `SELECT 1 FROM events WHERE id = $1 AND created_by = $2 AND category = 'doctor'
                       AND created_at > LOCALTIMESTAMP - interval '10 minutes'`,
                    [linkEventId, req.userId]
                );
                if (own.rows.length === 0) { await client.query('ROLLBACK'); return fail(res, 403, 'Insufficient role'); }
            }
            await client.query(`UPDATE events SET title = $1 WHERE id = $2`, [eventTitle(lang, doctor, specialty), linkEventId]);
            eventId = linkEventId;
            // Roadmap 21.4: Das Gespraech zum Arzttermin gibt es schon (beim Anlegen des Termins
            // entstanden). Dann nur die Angaben eintragen, kein zweites Gespraech.
            const existingId: string | undefined = taken.rows[0]?.id;
            if (existingId) {
                await client.query(
                    `UPDATE consultations SET doctor_name = $1, specialty = $2,
                        location = COALESCE($3, location), reason = COALESCE($4, reason), updated_at = CURRENT_TIMESTAMP
                     WHERE id = $5`,
                    [doctor, specialty, location, req.circleRole === 'recipient' ? null : reason, existingId]
                );
                await client.query('COMMIT');
                await notify(req.circleId!, 'updated');
                await broadcastToCircle(req.circleId!, { type: 'update', entity: 'events', action: 'updated' });
                return res.json({ success: true, data: await loadConsultation(existingId, req.circleId!) });
            }
        } else if (b.create_event === true && scheduledAt && req.circleRole !== 'recipient') {
            const ev = await client.query(
                `INSERT INTO events (circle_id, title, description, category, start_time, location, created_by, reminder_1hour)
                 VALUES ($1, $2, $3, 'doctor', $4, $5, $6, TRUE) RETURNING id`,
                [req.circleId, eventTitle(lang, doctor, specialty), reason, scheduledAt, location, req.userId]
            );
            eventId = ev.rows[0].id;
            eventCreated = true;
        }
        const created = await client.query(
            `INSERT INTO consultations (circle_id, doctor_name, specialty, scheduled_at, location, reason, event_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [req.circleId, doctor, specialty, scheduledAt, location, req.circleRole === 'recipient' ? null : reason, eventId, req.userId]
        );
        await addDefaultQuestion(client, created.rows[0].id, req.circleId!, lang, req.userId);
        await client.query('COMMIT');
        await notify(req.circleId!, 'created');
        if (eventId) await broadcastToCircle(req.circleId!, { type: 'update', entity: 'events', action: eventCreated ? 'created' : 'updated' });
        res.json({ success: true, data: await loadConsultation(created.rows[0].id, req.circleId!) });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        return serverError(res, 'create', error);
    } finally {
        client.release();
    }
});

consultationsRouter.get('/:id', requireReader, async (req: CircleRequest, res: Response) => {
    try {
        const consultation = await loadConsultation(String(req.params.id), req.circleId!);
        if (!consultation) return fail(res, 404, 'Consultation not found');
        const questions = await query(
            `SELECT id, text, answer, position, created_at FROM consultation_questions
             WHERE consultation_id = $1 ORDER BY position, created_at`,
            [consultation.id]
        );
        const recordings = await query(
            `SELECT ${RECORDING_PUBLIC}, transcript, transcript_edited FROM consultation_recordings
             WHERE consultation_id = $1 ORDER BY created_at`,
            [consultation.id]
        );
        const transcript = recordings.rows
            .map((r: { transcript: string | null }) => r.transcript)
            .filter((t: string | null): t is string => Boolean(t))
            .join('\n\n') || null;
        res.json({
            success: true,
            data: {
                consultation,
                questions: questions.rows,
                // E59: Mitschrift je Aufnahme (zum Pruefen und Bearbeiten), dazu alles zusammen.
                recordings: recordings.rows,
                transcript,
            },
        });
    } catch (error) {
        return serverError(res, 'detail', error);
    }
});

// PUT /:id: Angaben aendern (E59: auch recipient, bei jedem Arztgespraech, bis zur Sperre).
// Mit Termin: Zeit, Ort, Begleitung, Fahrt und Mitnehmen werden am Termin geaendert (eine Stelle).
consultationsRouter.put('/:id', requirePreparer, async (req: CircleRequest, res: Response) => {
    try {
        const existing = await loadConsultation(String(req.params.id), req.circleId!);
        if (!existing) return fail(res, 404, 'Consultation not found');
        if (existing.locked) return fail(res, 409, 'CONSULTATION_LOCKED');
        const b = req.body ?? {};
        const isRecipient = req.circleRole === 'recipient';
        const sets: string[] = [];
        const values: unknown[] = [];
        const add = (column: string, value: unknown) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        };
        if ('doctor_name' in b) add('doctor_name', text(b.doctor_name, 200));
        if ('specialty' in b) add('specialty', text(b.specialty, 120));
        if ('location' in b) add('location', text(b.location, 255));
        if (!isRecipient && 'reason' in b) add('reason', text(b.reason, 4000));
        if ('scheduled_at' in b) {
            const ts = timestamp(b.scheduled_at);
            if (ts === undefined) return fail(res, 400, 'INVALID_SCHEDULED_AT');
            add('scheduled_at', ts);
        }

        // Begleitung und Fahrt nur am Termin (ohne Termin gibt es keine).
        const eventSets: string[] = [];
        const eventValues: unknown[] = [];
        const addEvent = (column: string, value: unknown, cast = '') => {
            eventValues.push(value);
            eventSets.push(`${column} = $${eventValues.length}${cast}`);
        };
        if (existing.event_id) {
            if ('companion_needed' in b) {
                const needed = b.companion_needed === true;
                addEvent('companion_needed', needed);
                if (needed && ('companion_member_id' in b || 'companion_name' in b)) {
                    const memberId = typeof b.companion_member_id === 'string' && UUID_RE.test(b.companion_member_id) ? b.companion_member_id : null;
                    if (memberId) {
                        const ok = await query(`SELECT 1 FROM circle_members WHERE id = $1 AND circle_id = $2`, [memberId, req.circleId]);
                        if (ok.rows.length === 0) return fail(res, 400, 'Member not found in this circle');
                    }
                    const name = memberId ? null : cleanPersonName(b.companion_name);
                    addEvent('member_ids', JSON.stringify(memberId ? [memberId] : []), '::jsonb');
                    addEvent('guests', JSON.stringify(name ? [name] : []), '::jsonb');
                }
            }
            if ('travel_needed' in b) {
                const needed = b.travel_needed === true;
                addEvent('travel_needed', needed);
                if ('driver' in b) {
                    const driver = needed ? cleanPersonName(b.driver) : null;
                    addEvent('driver_to', driver);
                    addEvent('driver_back', driver);
                }
            }
            if ('take_along' in b) addEvent('take_along', text(b.take_along, 500));
        }

        if (sets.length > 0) {
            values.push(existing.id, req.circleId);
            await query(
                `UPDATE consultations SET ${sets.join(', ')} WHERE id = $${values.length - 1} AND circle_id = $${values.length}`,
                values
            );
        }
        if (existing.event_id && (sets.length > 0 || eventSets.length > 0)) {
            const now = await query(`SELECT doctor_name, specialty, scheduled_at, location FROM consultations WHERE id = $1`, [existing.id]);
            const c = now.rows[0];
            const scheduled = 'scheduled_at' in b ? c.scheduled_at : existing.scheduled_at;
            if (!scheduled) {
                // Ohne Zeit kein Termin mehr (wie bisher).
                await query(`DELETE FROM events WHERE id = $1 AND circle_id = $2`, [existing.event_id, req.circleId]);
            } else {
                addEvent('start_time', scheduled);
                addEvent('location', 'location' in b ? c.location : existing.location);
                addEvent('title', eventTitle(req.headers['accept-language'], c.doctor_name, c.specialty));
                eventValues.push(existing.event_id, req.circleId);
                await query(
                    `UPDATE events SET ${eventSets.join(', ')} WHERE id = $${eventValues.length - 1} AND circle_id = $${eventValues.length}`,
                    eventValues
                );
            }
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'events', action: 'updated' });
        }
        if (sets.length > 0 || eventSets.length > 0) await notify(req.circleId!, 'updated');
        res.json({ success: true, data: await loadConsultation(existing.id, req.circleId!) });
    } catch (error) {
        return serverError(res, 'update', error);
    }
});

consultationsRouter.delete('/:id', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        if (!UUID_RE.test(String(req.params.id))) return fail(res, 404, 'Consultation not found');
        const r = await query(`DELETE FROM consultations WHERE id = $1 AND circle_id = $2 RETURNING id, event_id`, [req.params.id, req.circleId]);
        if (r.rows.length === 0) return fail(res, 404, 'Consultation not found');
        // Der beim Anlegen erzeugte Termin gehoert zum Gespraech und wird mitgeloescht.
        if (r.rows[0].event_id) {
            await query(`DELETE FROM events WHERE id = $1 AND circle_id = $2`, [r.rows[0].event_id, req.circleId]);
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'events', action: 'deleted' });
        }
        await notify(req.circleId!, 'deleted');
        res.json({ success: true, data: null });
    } catch (error) {
        return serverError(res, 'delete', error);
    }
});

// ─── Fragen ──────────────────────────────────────────────────────────────────

consultationsRouter.post('/:id/questions', requirePreparer, async (req: CircleRequest, res: Response) => {
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c) return fail(res, 404, 'Consultation not found');
        if (c.locked) return fail(res, 409, 'CONSULTATION_LOCKED');
        const q = text(req.body?.text, 1000);
        if (!q) return fail(res, 400, 'TEXT_REQUIRED');
        const r = await query(
            `INSERT INTO consultation_questions (consultation_id, circle_id, text, position, created_by)
             VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM consultation_questions WHERE consultation_id = $1), 0), $4)
             RETURNING id, text, answer, position, created_at`,
            [c.id, req.circleId, q, req.userId]
        );
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: r.rows[0] });
    } catch (error) {
        return serverError(res, 'question_create', error);
    }
});

consultationsRouter.put('/:id/questions/:qid', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c || !UUID_RE.test(String(req.params.qid))) return fail(res, 404, 'Question not found');
        if (c.locked) return fail(res, 409, 'CONSULTATION_LOCKED');
        const b = req.body ?? {};
        const sets: string[] = [];
        const values: unknown[] = [];
        const add = (column: string, value: unknown) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        };
        if ('text' in b) {
            const q = text(b.text, 1000);
            if (!q) return fail(res, 400, 'TEXT_REQUIRED');
            add('text', q);
        }
        if ('answer' in b) add('answer', text(b.answer, 4000));
        if ('position' in b) {
            const p = Number(b.position);
            if (!Number.isInteger(p) || p < 0 || p > 10000) return fail(res, 400, 'INVALID_POSITION');
            add('position', p);
        }
        if (sets.length === 0) return fail(res, 400, 'NOTHING_TO_UPDATE');
        values.push(req.params.qid, c.id);
        const r = await query(
            `UPDATE consultation_questions SET ${sets.join(', ')}
             WHERE id = $${values.length - 1} AND consultation_id = $${values.length}
             RETURNING id, text, answer, position, created_at`,
            values
        );
        if (r.rows.length === 0) return fail(res, 404, 'Question not found');
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: r.rows[0] });
    } catch (error) {
        return serverError(res, 'question_update', error);
    }
});

consultationsRouter.delete('/:id/questions/:qid', requirePreparer, async (req: CircleRequest, res: Response) => {
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c || !UUID_RE.test(String(req.params.qid))) return fail(res, 404, 'Question not found');
        if (c.locked) return fail(res, 409, 'CONSULTATION_LOCKED');
        const r = await query(`DELETE FROM consultation_questions WHERE id = $1 AND consultation_id = $2 RETURNING id`, [req.params.qid, c.id]);
        if (r.rows.length === 0) return fail(res, 404, 'Question not found');
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: null });
    } catch (error) {
        return serverError(res, 'question_delete', error);
    }
});

// ─── Zusammenfassung ─────────────────────────────────────────────────────────

consultationsRouter.put('/:id/summary', requireWriterOrTeam, async (req: CircleRequest, res: Response) => {
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c) return fail(res, 404, 'Consultation not found');
        const ids = (await query(`SELECT id FROM consultation_questions WHERE consultation_id = $1 ORDER BY position, created_at`, [c.id])).rows.map((r: { id: string }) => r.id);
        const summary = sanitizeSummaryForQuestions(req.body?.summary, ids);
        await query(
            `UPDATE consultations SET summary = $1::jsonb, summary_status = 'draft', summary_source = 'human',
                approved_by = NULL, approved_at = NULL
             WHERE id = $2`,
            [JSON.stringify(summary), c.id]
        );
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: await loadConsultation(c.id, req.circleId!) });
    } catch (error) {
        return serverError(res, 'summary_update', error);
    }
});

consultationsRouter.post('/:id/summary/approve', requireWriterOrTeam, async (req: CircleRequest, res: Response) => {
    const client = await getClient();
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c) return fail(res, 404, 'Consultation not found');
        const questions = (await query(
            `SELECT id, answer FROM consultation_questions WHERE consultation_id = $1 ORDER BY position, created_at`,
            [c.id]
        )).rows as Array<{ id: string; answer: string | null }>;
        const source = req.body?.summary ?? c.summary;
        if (!source) return fail(res, 409, 'NO_SUMMARY');
        const summary: ConsultationSummary = sanitizeSummaryForQuestions(source, questions.map((q) => q.id));

        await client.query('BEGIN');
        await client.query(
            `UPDATE consultations SET summary = $1::jsonb, summary_status = 'approved', approved_by = $2, approved_at = NOW()
             WHERE id = $3`,
            // E64: im Teambereich kein Name (das Konto ist das der betreuten Person)
            [JSON.stringify(summary), req.teamAccess ? null : req.userId, c.id]
        );
        // Antworten aus dem Gespraech nur in noch leere Antwortfelder uebernehmen.
        for (const qa of summary.question_answers) {
            // Zuordnung ueber die Fragen-ID, nicht ueber den Listenplatz.
            const q = questions.find((x) => x.id === qa.question_id);
            if (q && qa.answer && !q.answer) {
                await client.query(`UPDATE consultation_questions SET answer = $1 WHERE id = $2`, [qa.answer, q.id]);
            }
        }
        await client.query('COMMIT');
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: await loadConsultation(c.id, req.circleId!) });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        return serverError(res, 'summary_approve', error);
    } finally {
        client.release();
    }
});

// E59: Freigabe der Zusammenfassung zuruecknehmen (hebt die Sperre auf).
consultationsRouter.post('/:id/summary/unapprove', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c) return fail(res, 404, 'Consultation not found');
        if (c.summary_status !== 'approved') return fail(res, 409, 'NOT_APPROVED');
        await query(`UPDATE consultations SET summary_status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = $1`, [c.id]);
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: await loadConsultation(c.id, req.circleId!) });
    } catch (error) {
        return serverError(res, 'summary_unapprove', error);
    }
});

// ─── Mitschrift (E59): bearbeiten und freigeben ──────────────────────────────

// PUT /:id/transcript: Mitschrift je Aufnahme bearbeiten. Body { recordings: [{ id, transcript }] }.
// Eine freigegebene Mitschrift wird dadurch wieder ungeprueft.
consultationsRouter.put('/:id/transcript', requireWriterOrTeam, async (req: CircleRequest, res: Response) => {
    const client = await getClient();
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c) return fail(res, 404, 'Consultation not found');
        const items = Array.isArray(req.body?.recordings) ? req.body.recordings.slice(0, 200) : [];
        if (items.length === 0) return fail(res, 400, 'NOTHING_TO_UPDATE');
        const edits: Array<{ id: string; transcript: string }> = [];
        for (const item of items) {
            const id = typeof item?.id === 'string' ? item.id : '';
            if (!UUID_RE.test(id)) return fail(res, 400, 'INVALID_RECORDING');
            const value = typeof item?.transcript === 'string' ? item.transcript.trim().slice(0, 200000) : '';
            if (!value) return fail(res, 400, 'TRANSCRIPT_REQUIRED');
            edits.push({ id, transcript: value });
        }
        await client.query('BEGIN');
        for (const e of edits) {
            const r = await client.query(
                `UPDATE consultation_recordings SET transcript = $1, transcript_edited = TRUE
                 WHERE id = $2 AND consultation_id = $3 AND transcript IS NOT NULL RETURNING id`,
                [e.transcript, e.id, c.id]
            );
            if (r.rows.length === 0) { await client.query('ROLLBACK'); return fail(res, 404, 'Recording not found'); }
        }
        await client.query(
            `UPDATE consultations SET transcript_status = 'draft', transcript_approved_by = NULL, transcript_approved_at = NULL,
                summary_outdated = (summary_status <> 'none') WHERE id = $1`,
            [c.id]
        );
        await client.query('COMMIT');
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: await loadConsultation(c.id, req.circleId!) });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        return serverError(res, 'transcript_update', error);
    } finally {
        client.release();
    }
});

// POST /:id/transcript/approve: Mitschrift freigeben (optional mit letzten Aenderungen wie PUT).
consultationsRouter.post('/:id/transcript/approve', requireWriterOrTeam, async (req: CircleRequest, res: Response) => {
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c) return fail(res, 404, 'Consultation not found');
        const has = await query(
            `SELECT 1 FROM consultation_recordings WHERE consultation_id = $1 AND transcript IS NOT NULL LIMIT 1`, [c.id]
        );
        if (has.rows.length === 0) return fail(res, 409, 'NO_TRANSCRIPT');
        await query(
            `UPDATE consultations SET transcript_status = 'approved', transcript_approved_by = $1, transcript_approved_at = NOW() WHERE id = $2`,
            [req.teamAccess ? null : req.userId, c.id]
        );
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: await loadConsultation(c.id, req.circleId!) });
    } catch (error) {
        return serverError(res, 'transcript_approve', error);
    }
});

// POST /:id/transcript/unapprove: Freigabe der Mitschrift zuruecknehmen (hebt die Sperre auf).
consultationsRouter.post('/:id/transcript/unapprove', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c) return fail(res, 404, 'Consultation not found');
        if (c.transcript_status !== 'approved') return fail(res, 409, 'NOT_APPROVED');
        await query(
            `UPDATE consultations SET transcript_status = 'draft', transcript_approved_by = NULL, transcript_approved_at = NULL WHERE id = $1`,
            [c.id]
        );
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: await loadConsultation(c.id, req.circleId!) });
    } catch (error) {
        return serverError(res, 'transcript_unapprove', error);
    }
});

consultationsRouter.post('/:id/summary/regenerate', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c) return fail(res, 404, 'Consultation not found');
        // Die zuletzt fertige Aufnahme mit Mitschrift erneut einreihen: die
        // Verarbeitung ueberspringt die Texterkennung und fasst ALLE Mitschriften zusammen.
        const r = await query(
            `UPDATE consultation_recordings SET status = 'queued', attempts = 0, next_attempt_at = NULL, error_code = NULL,
                force_summary = TRUE
             WHERE id = (
                SELECT id FROM consultation_recordings
                WHERE consultation_id = $1 AND transcript IS NOT NULL AND status IN ('done', 'failed')
                ORDER BY created_at DESC LIMIT 1
             ) RETURNING id`,
            [c.id]
        );
        if (r.rows.length === 0) return fail(res, 409, 'NO_TRANSCRIPT');
        await notify(req.circleId!, 'updated');
        kickConsultationProcessor();
        res.json({ success: true, data: { status: 'queued' } });
    } catch (error) {
        return serverError(res, 'summary_regenerate', error);
    }
});
