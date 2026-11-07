// Routen des Arztgespraech-Moduls. Vertrag: docs/consultations-api.md
//
// Zwei Router:
//  - recordingsRouter (/api/consultations/recordings): Upload in Stuecken,
//    auch fuer gekoppelte Patienten-Geraete (Tablet der betreuten Person).
//  - consultationsRouter (/api/consultations): alles andere, nur Mitglieder.

import express, { Router, Response } from 'express';
import { query, getClient } from '../../db';
import { authMiddleware } from '../../middleware/auth';
import { circleMiddleware, requireRole, CircleRequest, CircleRole } from '../../middleware/circle';
import { kioskOrMember, allowDeviceOr, KioskRequest } from '../../middleware/kioskDevice';
import { broadcastToCircle } from '../../lib/broadcaster';
import logger from '../../lib/logger';
import { sanitizeEditedSummary, isValidIsoDate, isValidTime, type ConsultationSummary } from './summary';
import { loadVocabulary, normalizeTerm } from './vocabulary';
import { kickConsultationProcessor } from './processing';
import { consultationText } from './texts';

export const READER_ROLES: CircleRole[] = ['admin', 'family', 'professional', 'viewer'];
export const WRITER_ROLES: CircleRole[] = ['admin', 'family'];

const requireReader = requireRole(...READER_ROLES);
const requireWriter = requireRole(...WRITER_ROLES);

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

const CONSULTATION_COLUMNS = `c.id, c.circle_id, c.doctor_name, c.specialty, c.scheduled_at, c.location, c.reason,
    c.event_id, c.notes, c.summary, c.summary_status, c.approved_at, u.name AS approved_by_name, c.applied,
    c.created_at, c.updated_at`;

async function loadConsultation(id: string, circleId: string) {
    if (!UUID_RE.test(id)) return null;
    const result = await query(
        `SELECT ${CONSULTATION_COLUMNS} FROM consultations c
         LEFT JOIN users u ON u.id = c.approved_by
         WHERE c.id = $1 AND c.circle_id = $2`,
        [id, circleId]
    );
    return result.rows[0] ?? null;
}

async function questionCount(consultationId: string): Promise<number> {
    const r = await query(`SELECT COUNT(*)::int AS n FROM consultation_questions WHERE consultation_id = $1`, [consultationId]);
    return r.rows[0]?.n ?? 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// Aufnahmen
// ═════════════════════════════════════════════════════════════════════════════

export const recordingsRouter = Router();
recordingsRouter.use(kioskOrMember());

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
recordingsRouter.post('/', allowDeviceOr(...WRITER_ROLES), async (req: KioskRequest, res: Response) => {
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

        let consultationId: string | null = typeof body.consultation_id === 'string' ? body.consultation_id : null;
        if (consultationId) {
            const c = await loadConsultation(consultationId, circleId);
            if (!c) return fail(res, 404, 'Consultation not found');
        } else {
            // Vom Tablet ohne vorbereitetes Gespraech: neues Gespraech mit Startzeit anlegen.
            const created = await query(
                `INSERT INTO consultations (circle_id, scheduled_at, created_by, created_by_device)
                 VALUES ($1, COALESCE($2::timestamp, date_trunc('minute', NOW()::timestamp)), $3, $4) RETURNING id`,
                [circleId, startedAt, req.kioskDevice ? null : req.userId, req.kioskDevice?.id ?? null]
            );
            consultationId = created.rows[0].id as string;
        }

        const inserted = await query(
            `INSERT INTO consultation_recordings
                (consultation_id, circle_id, client_id, mime_type, consent_at, consent_by_user, consent_by_device, started_at)
             VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7)
             RETURNING ${RECORDING_PUBLIC}`,
            [consultationId, circleId, clientId, mime, req.kioskDevice ? null : req.userId, req.kioskDevice?.id ?? null, startedAt]
        );
        await notify(circleId, 'created');
        res.json({ success: true, data: { ...inserted.rows[0], received: [] } });
    } catch (error) {
        return serverError(res, 'recording_create', error);
    }
});

// GET /recordings/:clientId: Stand des Uploads
recordingsRouter.get('/:clientId', allowDeviceOr(...WRITER_ROLES), async (req: KioskRequest, res: Response) => {
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
    allowDeviceOr(...WRITER_ROLES),
    (req: KioskRequest, res: Response, next: express.NextFunction) =>
        express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK_BYTES })(req, res, (err?: unknown) => {
            if (err) {
                const status = (err as { status?: number }).status;
                return fail(res, status === 413 ? 413 : 400, status === 413 ? 'CHUNK_TOO_LARGE' : 'INVALID_BODY');
            }
            next();
        }),
    async (req: KioskRequest, res: Response) => {
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
            if (Number(rec.size_bytes) + data.length > MAX_RECORDING_BYTES) return fail(res, 413, 'RECORDING_TOO_LARGE');

            const inserted = await query(
                `INSERT INTO consultation_recording_chunks (recording_id, chunk_index, data)
                 VALUES ($1, $2, $3) ON CONFLICT (recording_id, chunk_index) DO NOTHING RETURNING chunk_index`,
                [rec.id, index, data]
            );
            if (inserted.rows.length > 0) {
                await query(`UPDATE consultation_recordings SET size_bytes = size_bytes + $1 WHERE id = $2`, [data.length, rec.id]);
            }
            res.json({ success: true, data: { received: index } });
        } catch (error) {
            return serverError(res, 'recording_chunk', error);
        }
    }
);

// POST /recordings/:clientId/complete: alle Stuecke da, Verarbeitung einreihen
recordingsRouter.post('/:clientId/complete', allowDeviceOr(...WRITER_ROLES), async (req: KioskRequest, res: Response) => {
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
recordingsRouter.post('/:id/retry', allowDeviceOr(...WRITER_ROLES), async (req: KioskRequest, res: Response) => {
    if (req.kioskDevice) return fail(res, 403, 'Insufficient role');
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
recordingsRouter.delete('/:id/audio', allowDeviceOr(...WRITER_ROLES), async (req: KioskRequest, res: Response) => {
    if (req.kioskDevice) return fail(res, 403, 'Insufficient role');
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

// ═════════════════════════════════════════════════════════════════════════════
// Gespraeche, Fragen, Zusammenfassung, Fachwoerter
// ═════════════════════════════════════════════════════════════════════════════

export const consultationsRouter = Router();
consultationsRouter.use(authMiddleware);
consultationsRouter.use(circleMiddleware);

// ─── Fachwoerter ─────────────────────────────────────────────────────────────

consultationsRouter.get('/vocabulary', requireReader, async (req: CircleRequest, res: Response) => {
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
            `SELECT c.id, c.circle_id, c.doctor_name, c.specialty, c.scheduled_at, c.location, c.reason, c.event_id,
                    c.summary_status, c.approved_at, u.name AS approved_by_name, c.created_at, c.updated_at,
                    (SELECT COUNT(*)::int FROM consultation_questions q WHERE q.consultation_id = c.id) AS question_count,
                    (SELECT COUNT(*)::int FROM consultation_recordings r WHERE r.consultation_id = c.id) AS recording_count,
                    (SELECT r.status FROM consultation_recordings r WHERE r.consultation_id = c.id
                       ORDER BY r.created_at DESC LIMIT 1) AS latest_recording_status
             FROM consultations c LEFT JOIN users u ON u.id = c.approved_by
             WHERE c.circle_id = $1
             ORDER BY c.scheduled_at DESC NULLS LAST, c.created_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: r.rows });
    } catch (error) {
        return serverError(res, 'list', error);
    }
});

consultationsRouter.post('/', requireWriter, async (req: CircleRequest, res: Response) => {
    const b = req.body ?? {};
    const scheduledAt = timestamp(b.scheduled_at);
    if (scheduledAt === undefined) return fail(res, 400, 'INVALID_SCHEDULED_AT');
    const doctor = text(b.doctor_name, 200);
    const specialty = text(b.specialty, 120);
    const location = text(b.location, 255);
    const reason = text(b.reason, 4000);
    const client = await getClient();
    try {
        await client.query('BEGIN');
        let eventId: string | null = null;
        if (b.create_event === true && scheduledAt) {
            const label = consultationText(req.headers['accept-language'], 'defaultTitle');
            const who = [doctor, specialty].filter(Boolean).join(', ');
            const title = who ? `${label}: ${who}` : label;
            const ev = await client.query(
                `INSERT INTO events (circle_id, title, description, category, start_time, location, created_by, reminder_1hour)
                 VALUES ($1, $2, $3, 'medical', $4, $5, $6, TRUE) RETURNING id`,
                [req.circleId, title.slice(0, 255), reason, scheduledAt, location, req.userId]
            );
            eventId = ev.rows[0].id;
        }
        const created = await client.query(
            `INSERT INTO consultations (circle_id, doctor_name, specialty, scheduled_at, location, reason, event_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [req.circleId, doctor, specialty, scheduledAt, location, reason, eventId, req.userId]
        );
        await client.query('COMMIT');
        await notify(req.circleId!, 'created');
        if (eventId) await broadcastToCircle(req.circleId!, { type: 'update', entity: 'events', action: 'created' });
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
            `SELECT ${RECORDING_PUBLIC}, transcript FROM consultation_recordings
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
                recordings: recordings.rows.map(({ transcript: _t, ...rest }: { transcript: unknown }) => rest),
                transcript,
            },
        });
    } catch (error) {
        return serverError(res, 'detail', error);
    }
});

consultationsRouter.put('/:id', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        const existing = await loadConsultation(String(req.params.id), req.circleId!);
        if (!existing) return fail(res, 404, 'Consultation not found');
        const b = req.body ?? {};
        const sets: string[] = [];
        const values: unknown[] = [];
        const add = (column: string, value: unknown) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        };
        if ('doctor_name' in b) add('doctor_name', text(b.doctor_name, 200));
        if ('specialty' in b) add('specialty', text(b.specialty, 120));
        if ('location' in b) add('location', text(b.location, 255));
        if ('reason' in b) add('reason', text(b.reason, 4000));
        if ('notes' in b) add('notes', text(b.notes, 20000));
        if ('scheduled_at' in b) {
            const ts = timestamp(b.scheduled_at);
            if (ts === undefined) return fail(res, 400, 'INVALID_SCHEDULED_AT');
            add('scheduled_at', ts);
        }
        if (sets.length > 0) {
            values.push(existing.id, req.circleId);
            await query(
                `UPDATE consultations SET ${sets.join(', ')} WHERE id = $${values.length - 1} AND circle_id = $${values.length}`,
                values
            );
            await notify(req.circleId!, 'updated');
        }
        res.json({ success: true, data: await loadConsultation(existing.id, req.circleId!) });
    } catch (error) {
        return serverError(res, 'update', error);
    }
});

consultationsRouter.delete('/:id', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        if (!UUID_RE.test(String(req.params.id))) return fail(res, 404, 'Consultation not found');
        const r = await query(`DELETE FROM consultations WHERE id = $1 AND circle_id = $2 RETURNING id`, [req.params.id, req.circleId]);
        if (r.rows.length === 0) return fail(res, 404, 'Consultation not found');
        await notify(req.circleId!, 'deleted');
        res.json({ success: true, data: null });
    } catch (error) {
        return serverError(res, 'delete', error);
    }
});

// ─── Fragen ──────────────────────────────────────────────────────────────────

consultationsRouter.post('/:id/questions', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c) return fail(res, 404, 'Consultation not found');
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

consultationsRouter.delete('/:id/questions/:qid', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c || !UUID_RE.test(String(req.params.qid))) return fail(res, 404, 'Question not found');
        const r = await query(`DELETE FROM consultation_questions WHERE id = $1 AND consultation_id = $2 RETURNING id`, [req.params.qid, c.id]);
        if (r.rows.length === 0) return fail(res, 404, 'Question not found');
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: null });
    } catch (error) {
        return serverError(res, 'question_delete', error);
    }
});

// ─── Zusammenfassung ─────────────────────────────────────────────────────────

consultationsRouter.put('/:id/summary', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c) return fail(res, 404, 'Consultation not found');
        const summary = sanitizeEditedSummary(req.body?.summary, await questionCount(c.id));
        await query(
            `UPDATE consultations SET summary = $1::jsonb, summary_status = 'draft', approved_by = NULL, approved_at = NULL
             WHERE id = $2`,
            [JSON.stringify(summary), c.id]
        );
        await notify(req.circleId!, 'updated');
        res.json({ success: true, data: await loadConsultation(c.id, req.circleId!) });
    } catch (error) {
        return serverError(res, 'summary_update', error);
    }
});

consultationsRouter.post('/:id/summary/approve', requireWriter, async (req: CircleRequest, res: Response) => {
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
        const summary: ConsultationSummary = sanitizeEditedSummary(source, questions.length);

        await client.query('BEGIN');
        await client.query(
            `UPDATE consultations SET summary = $1::jsonb, summary_status = 'approved', approved_by = $2, approved_at = NOW()
             WHERE id = $3`,
            [JSON.stringify(summary), req.userId, c.id]
        );
        // Antworten aus dem Gespraech nur in noch leere Antwortfelder uebernehmen.
        for (const qa of summary.question_answers) {
            const q = questions[qa.question_index];
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

consultationsRouter.post('/:id/summary/regenerate', requireWriter, async (req: CircleRequest, res: Response) => {
    try {
        const c = await loadConsultation(String(req.params.id), req.circleId!);
        if (!c) return fail(res, 404, 'Consultation not found');
        // Die zuletzt fertige Aufnahme mit Mitschrift erneut einreihen: die
        // Verarbeitung ueberspringt die Texterkennung und fasst ALLE Mitschriften zusammen.
        const r = await query(
            `UPDATE consultation_recordings SET status = 'queued', attempts = 0, next_attempt_at = NULL, error_code = NULL
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

// ─── Vorschlaege uebernehmen (nur nach Bestaetigung) ─────────────────────────
//
// Aus dem Gespraech entstehen nur VORSCHLAEGE. Angelegt wird erst hier, wenn
// ein Mensch einzelne Vorschlaege bestaetigt (und vorher ggf. geaendert) hat.
// Bereits uebernommene Vorschlaege werden ueber ihren Inhalt erkannt, damit
// nach dem Neuerzeugen der Zusammenfassung nichts doppelt angelegt wird.

/** Schluessel eines Vorschlags: Art + Text ohne Gross/Klein und Mehrfach-Leerzeichen. */
export function appliedKey(kind: 'task' | 'event' | 'note', textValue: string): string {
    return `${kind}:${textValue.replace(/\s+/g, ' ').trim().toLocaleLowerCase()}`;
}

consultationsRouter.post('/:id/apply', requireWriter, async (req: CircleRequest, res: Response) => {
    const c = await loadConsultation(String(req.params.id), req.circleId!).catch(() => null);
    if (!c) return fail(res, 404, 'Consultation not found');
    const b = req.body ?? {};
    const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 20) : []);

    // Erst alles pruefen, dann alles in einer Transaktion anlegen.
    const tasks: Array<{ title: string; due: string | null }> = [];
    for (const item of list(b.tasks)) {
        const title = text(item?.text, 255);
        if (!title) return fail(res, 400, 'TASK_TEXT_REQUIRED');
        const due = item?.due === null || item?.due === undefined || item?.due === '' ? null : String(item.due);
        if (due !== null && !isValidIsoDate(due)) return fail(res, 400, 'INVALID_TASK_DUE');
        tasks.push({ title, due });
    }
    const events: Array<{ title: string; start: string; location: string | null }> = [];
    for (const item of list(b.appointments)) {
        const title = text(item?.title, 255);
        if (!title) return fail(res, 400, 'APPOINTMENT_TITLE_REQUIRED');
        const date = typeof item?.date === 'string' ? item.date : '';
        const time = typeof item?.time === 'string' ? item.time : '';
        // Kein Termin ohne Datum UND Uhrzeit: lieber nachfragen als eine Zeit erfinden.
        if (!isValidIsoDate(date) || !isValidTime(time)) return fail(res, 400, 'APPOINTMENT_DATE_TIME_REQUIRED');
        events.push({ title, start: `${date}T${time}:00`, location: text(item?.location, 255) });
    }
    const notes: string[] = [];
    for (const item of list(b.notes)) {
        const content = text(item?.content, 500);
        if (!content) return fail(res, 400, 'NOTE_TEXT_REQUIRED');
        notes.push(content);
    }
    if (tasks.length + events.length + notes.length === 0) return fail(res, 400, 'NOTHING_TO_APPLY');

    const label = consultationText(req.headers['accept-language'], 'defaultTitle');
    const who = [c.doctor_name, c.specialty].filter(Boolean).join(', ');
    const origin = who ? `${label}: ${who}` : label;

    const client = await getClient();
    try {
        await client.query('BEGIN');
        const current = (await client.query(
            `SELECT applied FROM consultations WHERE id = $1 FOR UPDATE`, [c.id]
        )).rows[0]?.applied ?? {};
        const applied: Record<string, string> = { ...current };
        const result = { tasks: 0, appointments: 0, notes: 0, skipped: 0 };

        for (const t of tasks) {
            const key = appliedKey('task', t.title);
            if (applied[key]) { result.skipped++; continue; }
            const r = await client.query(
                `INSERT INTO tasks (circle_id, title, description, category, due_date, assigned_to)
                 VALUES ($1, $2, $3, 'other', $4, '[]'::jsonb) RETURNING id`,
                [req.circleId, t.title, origin, t.due]
            );
            applied[key] = r.rows[0].id;
            result.tasks++;
        }
        for (const e of events) {
            const key = appliedKey('event', `${e.title} ${e.start}`);
            if (applied[key]) { result.skipped++; continue; }
            const r = await client.query(
                `INSERT INTO events (circle_id, title, description, category, start_time, location, created_by, reminder_1hour)
                 VALUES ($1, $2, $3, 'medical', $4, $5, $6, TRUE) RETURNING id`,
                [req.circleId, e.title, origin, e.start, e.location, req.userId]
            );
            applied[key] = r.rows[0].id;
            result.appointments++;
        }
        if (notes.length > 0) {
            const author = (await client.query(`SELECT name FROM users WHERE id = $1`, [req.userId])).rows[0]?.name ?? label;
            for (const n of notes) {
                const key = appliedKey('note', n);
                if (applied[key]) { result.skipped++; continue; }
                const r = await client.query(
                    `INSERT INTO circle_notes (circle_id, author_name, content, color) VALUES ($1, $2, $3, 'blue') RETURNING id`,
                    [req.circleId, String(author).slice(0, 100), n]
                );
                applied[key] = r.rows[0].id;
                result.notes++;
            }
        }
        await client.query(`UPDATE consultations SET applied = $1::jsonb WHERE id = $2`, [JSON.stringify(applied), c.id]);
        await client.query('COMMIT');

        await notify(req.circleId!, 'updated');
        if (result.tasks) await broadcastToCircle(req.circleId!, { type: 'update', entity: 'tasks', action: 'created' });
        if (result.appointments) await broadcastToCircle(req.circleId!, { type: 'update', entity: 'events', action: 'created' });
        if (result.notes) await broadcastToCircle(req.circleId!, { type: 'update', entity: 'notes', action: 'created' });
        res.json({ success: true, data: { ...result, applied: Object.keys(applied) } });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        return serverError(res, 'apply', error);
    } finally {
        client.release();
    }
});
