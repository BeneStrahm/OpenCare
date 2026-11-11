import { Router, Response, NextFunction } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import {
    circleMiddleware, requireRole, CircleRequest, HEALTH_READER_ROLES,
    RECIPIENT_UNDO_MS, recipientMayRecordVital, recipientVitalUndoMsLeft,
} from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';
import { createNotification } from '../lib/notifications';
import { langFromRequest, t, pick, pickLang, type Lang } from '../lib/i18n';
import { getPublicSettings } from '../lib/circleSettings';
import { formatVital, isVitalType, numberLocale } from '../lib/units';
import { isVitalTypeEnabled, loadCircleSettings } from '../lib/features';
import {
    cleanNote, cleanRemindTime, isVitalReminderType, loadVitalReminderSettings,
    openVitalRemindersToday, saveVitalReminderSetting,
} from '../lib/vitalReminders';

const router = Router();

// Donnees de sante: la matrice de docs/SPEC.md exclut le role neighbor
// (ecriture pour admin/family/professional; recipient siehe middleware/circle.ts:
// nur die freigegebenen Routen, schreibt nur Blutzucker und Gewicht, Block K).
router.use(authMiddleware, circleMiddleware, requireRole(...HEALTH_READER_ROLES));

const requireHealthWriter = requireRole('admin', 'family', 'professional');

/** Alter eines Eintrags in ms, in der Datenbankzeit gerechnet (wie created_at). */
const CREATED_AGE_MS_SQL = 'EXTRACT(EPOCH FROM (LOCALTIMESTAMP - created_at)) * 1000';

/**
 * Block K (E20): Schreiben wie bisher fuer admin, family, professional; dazu
 * recipient, aber nur Blutzucker und Gewicht (RECIPIENT_VITAL_TYPES).
 */
const requireVitalWriter = (req: CircleRequest, res: Response, next: NextFunction) => {
    if (req.circleRole === 'recipient') {
        if (!recipientMayRecordVital(req.body?.type)) {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }
        return next();
    }
    return requireHealthWriter(req, res, next);
};

const VITAL_TYPES = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'];

const parseDate = (value: unknown): Date | null => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
};

// List measurements, oldest first (ready for charts).
// Optional filters: ?type=, ?from= and ?to= (bounds on measured_at), ?limit= (default 500).
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const parsedLimit = parseInt(String(req.query.limit), 10);
        const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 500 : parsedLimit, 1), 2000);

        const conditions: string[] = ['circle_id = $1'];
        const values: unknown[] = [req.circleId];
        let idx = 2;

        if (typeof req.query.type === 'string' && req.query.type) {
            if (!VITAL_TYPES.includes(req.query.type)) {
                return res.status(400).json({ success: false, error: 'Invalid vital type' });
            }
            conditions.push(`type = $${idx++}`);
            values.push(req.query.type);
        }

        if (typeof req.query.from === 'string' && req.query.from) {
            const from = parseDate(req.query.from);
            if (!from) {
                return res.status(400).json({ success: false, error: 'Invalid from date' });
            }
            conditions.push(`measured_at >= $${idx++}`);
            values.push(from);
        }

        if (typeof req.query.to === 'string' && req.query.to) {
            const to = parseDate(req.query.to);
            if (!to) {
                return res.status(400).json({ success: false, error: 'Invalid to date' });
            }
            conditions.push(`measured_at <= $${idx++}`);
            values.push(to);
        }

        values.push(limit);
        const result = await query(
            `SELECT * FROM vitals
             WHERE ${conditions.join(' AND ')}
             ORDER BY measured_at ASC
             LIMIT $${idx}`,
            values
        );

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List vitals error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Latest measurement of each type
router.get('/latest', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT DISTINCT ON (type) *
             FROM vitals
             WHERE circle_id = $1
             ORDER BY type, measured_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Latest vitals error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// Seuils d'alerte
// ============================================================

interface ThresholdRow {
    type: string;
    min_value: number | null;
    max_value: number | null;
    min_value2: number | null;
    max_value2: number | null;
    min_pulse?: number | null;
    max_pulse?: number | null;
}

const THRESHOLD_COLUMNS = 'type, min_value, max_value, min_value2, max_value2, min_pulse, max_pulse';

/** Puls nur beim Blutdruck: leer ist erlaubt, sonst eine Zahl groesser 0. */
const parsePulse = (raw: unknown): number | null | 'invalid' => {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 'invalid';
};

/** Libelles serveur des constantes, pour le texte des notifications. */
const VITAL_LABELS: Record<string, Record<Lang, string>> = {
    weight: { fr: 'Poids', en: 'Weight', es: 'Peso', de: 'Gewicht' },
    bp: { fr: 'Tension', en: 'Blood pressure', es: 'Tensión', de: 'Blutdruck' },
    pain: { fr: 'Douleur', en: 'Pain', es: 'Dolor', de: 'Schmerz' },
    mood: { fr: 'Moral', en: 'Mood', es: 'Ánimo', de: 'Stimmung' },
    temperature: { fr: 'Température', en: 'Temperature', es: 'Temperatura', de: 'Temperatur' },
    glucose: { fr: 'Glycémie', en: 'Blood sugar', es: 'Glucemia', de: 'Blutzucker' },
};

const num = (raw: unknown): number | null => {
    if (raw === null || raw === '' || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
};

/** La mesure sort-elle de la plage ? Renvoie null quand tout va bien. */
export const outOfRange = (
    threshold: ThresholdRow,
    value: number,
    value2: number | null,
    pulse: number | null = null
): 'low' | 'high' | null => {
    if (threshold.min_value !== null && value < Number(threshold.min_value)) return 'low';
    if (threshold.max_value !== null && value > Number(threshold.max_value)) return 'high';
    if (value2 !== null) {
        if (threshold.min_value2 !== null && value2 < Number(threshold.min_value2)) return 'low';
        if (threshold.max_value2 !== null && value2 > Number(threshold.max_value2)) return 'high';
    }
    if (pulse !== null) {
        if (threshold.min_pulse != null && pulse < Number(threshold.min_pulse)) return 'low';
        if (threshold.max_pulse != null && pulse > Number(threshold.max_pulse)) return 'high';
    }
    return null;
};

/** Previent les admins et la famille quand une mesure sort de la plage fixee. */
export async function notifyOutOfRange(
    circleId: string,
    type: string,
    value: number,
    value2: number | null,
    direction: 'low' | 'high',
    vitalId: string,
    pulse: number | null = null
): Promise<void> {
    const [{ rows: members }, { rows: recipientRows }, settings] = await Promise.all([
        query(
            `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
             FROM circle_members cm JOIN users u ON u.id = cm.user_id
             WHERE cm.circle_id = $1 AND cm.role IN ('admin', 'family')`,
            [circleId]
        ),
        query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [circleId]),
        getPublicSettings(circleId),
    ]);
    const who = (recipientRows[0]?.first_name as string | undefined)?.trim() ?? '';
    // La mesure est stockee en metrique : on la lit dans le systeme du cercle, avec
    // son unite ("150 lb", pas "68.04"), et les nombres dans la langue de chacun.
    const readingFor = (language: string): string => {
        const base = isVitalType(type)
            ? formatVital(type, value, value2, settings.unit_system, numberLocale(language))
            : (value2 !== null ? `${value}/${value2}` : String(value));
        if (pulse === null) return base;
        const word = pick(pickLang(language), { fr: 'pouls', en: 'pulse', es: 'pulso', de: 'Puls' });
        return `${base}, ${word} ${pulse.toLocaleString(numberLocale(language))}/min`;
    };

    await Promise.all((members as Array<{ user_id: string; language: string }>).map((member) => {
        const lang = pickLang(member.language);
        const reading = readingFor(lang);
        const label = VITAL_LABELS[type]?.[lang] ?? type;
        const high = direction === 'high';
        const title = pick(lang, {
            fr: `${label} hors de la plage${who ? ` pour ${who}` : ''}`,
            en: `${label} out of range${who ? ` for ${who}` : ''}`,
            es: `${label} fuera de rango${who ? ` para ${who}` : ''}`,
            de: `${label} außerhalb des Bereichs${who ? ` bei ${who}` : ''}`,
        });
        const message = pick(lang, {
            fr: `Dernière mesure : ${reading}, ${high ? 'au-dessus' : 'en dessous'} de la plage définie pour ce cercle.`,
            en: `Last measurement: ${reading}, ${high ? 'above' : 'below'} the range set for this circle.`,
            es: `Última medición: ${reading}, ${high ? 'por encima' : 'por debajo'} del rango definido para este círculo.`,
            de: `Letzte Messung: ${reading}, ${high ? 'über' : 'unter'} dem für diesen Kreis festgelegten Bereich.`,
        });
        return createNotification({
            userId: member.user_id,
            circleId,
            title,
            message,
            type: 'vital_out_of_range',
            relatedId: vitalId,
            url: '/health',
            tag: `vital-${type}-${circleId}`,
        });
    }));
}

// GET /api/vitals/thresholds : the ranges set for this circle.
router.get('/thresholds', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT ${THRESHOLD_COLUMNS} FROM vital_thresholds WHERE circle_id = $1 ORDER BY type`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Get vital thresholds error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/vitals/thresholds : set or clear the range of one vital type.
// Body { type, min_value, max_value, min_value2, max_value2 }; a null bound is
// no bound, and a row with no bound at all is removed.
router.put('/thresholds', requireRole('admin', 'family'), async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const type = typeof req.body?.type === 'string' ? req.body.type : '';
        if (!VITAL_TYPES.includes(type)) {
            return res.status(400).json({ success: false, error: t(lang, 'vitals.thresholdType') });
        }
        const bounds = ['min_value', 'max_value', 'min_value2', 'max_value2', 'min_pulse', 'max_pulse'].map((key) =>
            num(req.body?.[key])
        );
        if (bounds.some((b) => Number.isNaN(b))) {
            return res.status(400).json({ success: false, error: t(lang, 'vitals.thresholdInvalid') });
        }
        const [minV, maxV, minV2, maxV2] = bounds;
        // Puls-Bereich gibt es nur beim Blutdruck.
        const [minP, maxP] = type === 'bp' ? [bounds[4], bounds[5]] : [null, null];
        if (
            (minV !== null && maxV !== null && minV >= maxV) ||
            (minV2 !== null && maxV2 !== null && minV2 >= maxV2) ||
            (minP !== null && maxP !== null && minP >= maxP)
        ) {
            return res.status(400).json({ success: false, error: t(lang, 'vitals.thresholdInvalid') });
        }

        if ([minV, maxV, minV2, maxV2, minP, maxP].every((b) => b === null)) {
            await query('DELETE FROM vital_thresholds WHERE circle_id = $1 AND type = $2', [req.circleId, type]);
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'updated' });
            return res.json({ success: true, data: null });
        }

        const result = await query(
            `INSERT INTO vital_thresholds (circle_id, type, min_value, max_value, min_value2, max_value2, min_pulse, max_pulse)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (circle_id, type) DO UPDATE
               SET min_value = EXCLUDED.min_value, max_value = EXCLUDED.max_value,
                   min_value2 = EXCLUDED.min_value2, max_value2 = EXCLUDED.max_value2,
                   min_pulse = EXCLUDED.min_pulse, max_pulse = EXCLUDED.max_pulse,
                   updated_at = CURRENT_TIMESTAMP
             RETURNING ${THRESHOLD_COLUMNS}`,
            [req.circleId, type, minV, maxV, minV2, maxV2, minP, maxP]
        );
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update vital threshold error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Fork, Block E: Messwert-Erinnerungen (lib/vitalReminders.ts).
// GET /api/vitals/reminders : Einstellungen fuer Blutzucker und Gewicht.
router.get('/reminders', async (req: CircleRequest, res: Response) => {
    try {
        res.json({ success: true, data: await loadVitalReminderSettings(req.circleId!) });
    } catch (error) {
        console.error('Get vital reminders error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/vitals/reminders/today : eingeschaltete Erinnerungen ohne Wert von heute.
// Auch fuer recipient freigegeben (einfache Ansicht), liefert keine Messwerte.
router.get('/reminders/today', async (req: CircleRequest, res: Response) => {
    try {
        const open = await openVitalRemindersToday(req.circleId!);
        res.json({ success: true, data: open.map(({ type, remind_time, note }) => ({ type, remind_time, note })) });
    } catch (error) {
        console.error('Get open vital reminders error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/vitals/reminders : { type, enabled, remind_time 'HH:MM', note } (admin/family)
router.put('/reminders', requireRole('admin', 'family'), async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const type = req.body?.type;
        const remindTime = cleanRemindTime(req.body?.remind_time);
        if (!isVitalReminderType(type)) {
            return res.status(400).json({ success: false, error: t(lang, 'vitals.thresholdType') });
        }
        if (!remindTime) {
            return res.status(400).json({ success: false, error: t(lang, 'vitals.reminderTime') });
        }
        const saved = await saveVitalReminderSetting(
            req.circleId!, type, req.body?.enabled === true, remindTime, cleanNote(req.body?.note)
        );
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'updated' });
        res.json({ success: true, data: saved });
    } catch (error) {
        console.error('Update vital reminder error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Block K: eigene Eintraege, die noch rueckgaengig gemacht werden koennen
// (betreute Person, RECIPIENT_UNDO_MINUTES). Liefert nur eigene Werte.
router.get('/mine/undoable', async (req: CircleRequest, res: Response) => {
    try {
        const { rows } = await query(
            `SELECT id, type, value, unit, measured_at, recorded_by_user, ${CREATED_AGE_MS_SQL} AS created_age_ms
             FROM vitals
             WHERE circle_id = $1 AND recorded_by_user = $2
               AND type IN ('glucose', 'weight')
               AND created_at > LOCALTIMESTAMP - ($3 || ' milliseconds')::interval
             ORDER BY created_at DESC`,
            [req.circleId, req.userId, String(RECIPIENT_UNDO_MS)]
        );
        const data = rows
            .map((row) => ({
                id: row.id as string,
                type: row.type as string,
                value: Number(row.value),
                unit: row.unit as string | null,
                measured_at: row.measured_at,
                undo_ms_left: recipientVitalUndoMsLeft(row, req.userId),
            }))
            .filter((row) => row.undo_ms_left > 0);
        res.json({ success: true, data });
    } catch (error) {
        console.error('List undoable vitals error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.post('/', requireVitalWriter, async (req: CircleRequest, res: Response) => {
    try {
        const isRecipient = req.circleRole === 'recipient';
        const { type, value } = req.body;
        // Block K: Die betreute Person traegt nur einen Wert "jetzt" ein, ohne
        // zweiten Wert, Puls, Zeit oder Notiz; die Einheit ist die gespeicherte.
        const value2 = isRecipient ? undefined : req.body.value2;
        const pulse = isRecipient ? undefined : req.body.pulse;
        const measured_at = isRecipient ? undefined : req.body.measured_at;
        const notes = isRecipient ? undefined : req.body.notes;
        const unit = isRecipient ? (type === 'glucose' ? 'g/L' : 'kg') : req.body.unit;

        if (typeof type !== 'string' || !VITAL_TYPES.includes(type)) {
            return res.status(400).json({ success: false, error: 'Invalid vital type' });
        }
        const parsedPulse = parsePulse(pulse);
        if (parsedPulse === 'invalid') {
            return res.status(400).json({ success: false, error: 'Invalid pulse' });
        }
        const numPulse = type === 'bp' ? parsedPulse : null;
        // Fork: nur ausgewaehlte Messwerte duerfen erfasst werden.
        if (!isVitalTypeEnabled(await loadCircleSettings(req.circleId!), type)) {
            return res.status(403).json({ success: false, error: 'FEATURE_DISABLED' });
        }

        const numValue = Number(value);
        if (value === undefined || value === null || value === '' || !Number.isFinite(numValue)) {
            return res.status(400).json({ success: false, error: 'Invalid value' });
        }
        if (isRecipient && numValue <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid value' });
        }

        let numValue2: number | null = null;
        if (value2 !== undefined && value2 !== null && value2 !== '') {
            numValue2 = Number(value2);
            if (!Number.isFinite(numValue2)) {
                return res.status(400).json({ success: false, error: 'Invalid value2' });
            }
        }

        let measuredAt: Date | null = null;
        if (measured_at !== undefined && measured_at !== null) {
            measuredAt = parseDate(measured_at);
            if (!measuredAt) {
                return res.status(400).json({ success: false, error: 'Invalid measured_at date' });
            }
        }

        const result = await query(
            `INSERT INTO vitals (circle_id, type, value, value2, pulse, unit, measured_at, recorded_by_user, notes)
             VALUES ($1, $2, $3, $4, $9, $5, COALESCE($6, CURRENT_TIMESTAMP), $7, $8)
             RETURNING *`,
            [
                req.circleId,
                type,
                numValue,
                numValue2,
                typeof unit === 'string' && unit.trim() ? unit.trim() : null,
                measuredAt,
                req.userId,
                typeof notes === 'string' && notes.trim() ? notes.trim() : null,
                numPulse,
            ]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'created' });

        // Hors de la plage fixee par la famille : on previent, sans bloquer la reponse.
        const thresholdResult = await query(
            `SELECT ${THRESHOLD_COLUMNS} FROM vital_thresholds WHERE circle_id = $1 AND type = $2`,
            [req.circleId, type]
        );
        const threshold = thresholdResult.rows[0] as ThresholdRow | undefined;
        if (threshold) {
            const direction = outOfRange(threshold, numValue, numValue2, numPulse);
            if (direction) {
                await notifyOutOfRange(req.circleId!, type, numValue, numValue2, direction, result.rows[0].id, numPulse);
            }
        }

        const created = result.rows[0];
        res.json({
            success: true,
            data: isRecipient ? { ...created, undo_ms_left: RECIPIENT_UNDO_MS } : created,
        });
    } catch (error) {
        console.error('Create vital error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update a measurement: its author (recorded_by_user) or an admin
router.put('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id, recorded_by_user FROM vitals WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Vital not found' });
        }
        const isAuthor = existing.rows[0].recorded_by_user === req.userId;
        if (!isAuthor && req.circleRole !== 'admin') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        const { type, value, value2, pulse, unit, measured_at, notes } = req.body;
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (type !== undefined) {
            if (typeof type !== 'string' || !VITAL_TYPES.includes(type)) {
                return res.status(400).json({ success: false, error: 'Invalid vital type' });
            }
            if (!isVitalTypeEnabled(await loadCircleSettings(req.circleId!), type)) {
                return res.status(403).json({ success: false, error: 'FEATURE_DISABLED' });
            }
            fields.push(`type = $${idx++}`);
            values.push(type);
        }

        if (value !== undefined) {
            const numValue = Number(value);
            if (value === null || value === '' || !Number.isFinite(numValue)) {
                return res.status(400).json({ success: false, error: 'Invalid value' });
            }
            fields.push(`value = $${idx++}`);
            values.push(numValue);
        }

        if (value2 !== undefined) {
            if (value2 === null || value2 === '') {
                fields.push(`value2 = $${idx++}`);
                values.push(null);
            } else {
                const numValue2 = Number(value2);
                if (!Number.isFinite(numValue2)) {
                    return res.status(400).json({ success: false, error: 'Invalid value2' });
                }
                fields.push(`value2 = $${idx++}`);
                values.push(numValue2);
            }
        }

        if (pulse !== undefined) {
            const parsedPulse = parsePulse(pulse);
            if (parsedPulse === 'invalid') {
                return res.status(400).json({ success: false, error: 'Invalid pulse' });
            }
            fields.push(`pulse = $${idx++}`);
            values.push(parsedPulse);
        }

        if (unit !== undefined) {
            fields.push(`unit = $${idx++}`);
            values.push(typeof unit === 'string' && unit.trim() ? unit.trim() : null);
        }

        if (measured_at !== undefined) {
            const measuredAt = parseDate(measured_at);
            if (!measuredAt) {
                return res.status(400).json({ success: false, error: 'Invalid measured_at date' });
            }
            fields.push(`measured_at = $${idx++}`);
            values.push(measuredAt);
        }

        if (notes !== undefined) {
            fields.push(`notes = $${idx++}`);
            values.push(typeof notes === 'string' && notes.trim() ? notes.trim() : null);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.params.id, req.circleId);
        const result = await query(
            `UPDATE vitals SET ${fields.join(', ')} WHERE id = $${idx} AND circle_id = $${idx + 1} RETURNING *`,
            values
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update vital error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete a measurement: its author or an admin (recipient: own entry, 10 minutes)
router.delete('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            `SELECT id, type, recorded_by_user, ${CREATED_AGE_MS_SQL} AS created_age_ms
             FROM vitals WHERE id = $1 AND circle_id = $2`,
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Vital not found' });
        }
        // Block K: die betreute Person nur den eigenen Eintrag, nur RECIPIENT_UNDO_MINUTES lang.
        if (req.circleRole === 'recipient' && recipientVitalUndoMsLeft(existing.rows[0], req.userId) <= 0) {
            return res.status(403).json({ success: false, error: 'UNDO_EXPIRED' });
        }
        const isAuthor = existing.rows[0].recorded_by_user === req.userId;
        if (!isAuthor && req.circleRole !== 'admin') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        await query('DELETE FROM vitals WHERE id = $1 AND circle_id = $2', [req.params.id, req.circleId]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete vital error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
