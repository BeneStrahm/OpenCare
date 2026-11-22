// Arztgespraech: Standardfrage und Gespraech zum Arzttermin (E61, Roadmap 21.4).
// Klein gehalten, weil routes/events.ts diese Datei laedt.
import { getClient } from '../../db';
import { broadcastToCircle } from '../../lib/broadcaster';
import { featureEnabledForCircle } from '../../lib/features';
import { consultationText } from './texts';

/** Standardfrage in jedem neuen Gespraech (E61), loeschbar wie jede Frage. */
export async function addDefaultQuestion(db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, consultationId: string, circleId: string, lang: unknown, userId: string | undefined) {
    await db.query(
        `INSERT INTO consultation_questions (consultation_id, circle_id, text, position, created_by) VALUES ($1, $2, $3, 0, $4)`,
        [consultationId, circleId, consultationText(lang, 'defaultQuestion'), userId ?? null]
    );
}

/**
 * Roadmap 21.4: Zu jedem Termin mit Art "Arzt" gehoert ein Arztgespraech (mit Standardfrage),
 * egal wer den Termin anlegt oder spaeter auf "Arzt" aendert. Hat der Termin schon ein Gespraech,
 * passiert nichts. Wird die Art spaeter geaendert, bleibt das Gespraech (nichts geht verloren).
 * Aufgerufen aus routes/events.ts (eigene Datei, damit events.ts das Modul nicht ganz laedt). Fehler hier lassen den Termin selbst bestehen.
 */
export async function ensureConsultationForEvent(circleId: string, eventId: string, lang: unknown, userId: string | undefined): Promise<void> {
    if (!(await featureEnabledForCircle(circleId, 'consultations'))) return;
    const db = await getClient();
    let createdId: string | null = null;
    try {
        await db.query('BEGIN');
        // Sperre auf den Termin: zwei gleichzeitige Aufrufe legen nicht zwei Gespraeche an.
        await db.query(`SELECT 1 FROM events WHERE id = $1 AND circle_id = $2 FOR UPDATE`, [eventId, circleId]);
        const created = await db.query(
            `INSERT INTO consultations (circle_id, scheduled_at, location, event_id, created_by)
             SELECT e.circle_id, e.start_time, e.location, e.id, $3
             FROM events e
             WHERE e.id = $1 AND e.circle_id = $2 AND e.category = 'doctor'
               AND NOT EXISTS (SELECT 1 FROM consultations c WHERE c.event_id = e.id)
             RETURNING id`,
            [eventId, circleId, userId ?? null]
        );
        createdId = created.rows[0]?.id ?? null;
        if (createdId) await addDefaultQuestion(db, createdId, circleId, lang, userId);
        await db.query('COMMIT');
    } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        db.release();
    }
    if (createdId) await broadcastToCircle(circleId, { type: 'update', entity: 'consultations', action: 'created' });
}
