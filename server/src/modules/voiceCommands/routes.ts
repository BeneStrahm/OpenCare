// Sprachsteuerung: POST /api/voice-commands/parse, /preview, /execute.
//
// Ablauf in der App: Sprache -> Text (bestehendes /api/voice/transcribe) ->
// /parse -> Bestaetigungsdialog (fehlende Werte kann der Nutzer eintragen,
// dann /preview) -> Ja -> /execute. Nichts wird ohne Ja gespeichert; nur das
// Abfragen von Terminen braucht keine Bestaetigung.
//
// Rechte (gleiche Regeln wie die bestehenden Routen):
//  - Termine abfragen: jedes Mitglied (wie GET /api/events) und Patienten-Geraete.
//  - Termin anlegen: admin, family (wie POST /api/events fuer die Kategorien
//    'medical' und 'other'; professional darf diese Kategorien dort nicht).
//  - Aufgabe anlegen: admin, family (wie POST /api/tasks).
//  - Aufgabe erledigt: admin, family, professional. In /api/tasks darf auch
//    neighbor abhaken; fuer die Sprachsteuerung gilt bewusst: neighbor und
//    viewer schreiben nichts.
//  - Gewicht und Blutzucker: admin, family, professional (wie POST /api/vitals).
//
// Patienten-Geraete (Tablet, Kiosk): Heute schreibt der Kiosk schon selbst
// Gesundheitsdaten (Medikamenten-Einnahme bestaetigen) sowie Tagebuch und
// Besuche. Deshalb darf er per Sprache auch Gewicht und Blutzucker eintragen
// und Termine und Aufgaben ANLEGEN: Die Person kann so selbst "Termin beim
// Hausarzt am Montag um 10" festhalten, und jeder Eintrag traegt den Vermerk,
// an welchem Geraet er entstand. Abhaken, Aendern oder Loeschen bleibt den
// Angehoerigen vorbehalten, damit am Tablet nichts versehentlich verschwindet.

import { isFeatureEnabled, loadCircleSettings, type FeatureId } from '../../lib/features';
import { Router, Response } from 'express';
import { query } from '../../db';
import { CircleRole } from '../../middleware/circle';
import { kioskOrMember, KioskRequest } from '../../middleware/kioskDevice';
import { broadcastToCircle } from '../../lib/broadcaster';
import { getPublicSettings } from '../../lib/circleSettings';
import { expandEventOccurrences, toLocalISO } from '../../routes/events';
import { notifyOutOfRange, outOfRange } from '../../routes/vitals';
import logger from '../../lib/logger';
import {
    parseCommand,
    validateCommand,
    matchTask,
    glucoseToGl,
    weightToKg,
    isoDate,
    type ParseResult,
    type VoiceIntent,
    type VoiceParams,
    type MissingField,
} from './parser';
import { extractDateTimeWithLocalModel } from './llm';
import { confirmationText, doneText, eventsSpoken, deviceNote, toVoiceLang, type VoiceLang } from './texts';

const router = Router();
router.use(kioskOrMember());

const WRITE_RULES: Record<VoiceIntent, { roles: CircleRole[]; device: boolean }> = {
    list_events: { roles: ['admin', 'family', 'professional', 'neighbor', 'viewer'], device: true },
    create_event: { roles: ['admin', 'family'], device: true },
    create_task: { roles: ['admin', 'family'], device: true },
    complete_task: { roles: ['admin', 'family', 'professional'], device: false },
    record_weight: { roles: ['admin', 'family', 'professional'], device: true },
    record_glucose: { roles: ['admin', 'family', 'professional'], device: true },
};

const allowed = (req: KioskRequest, intent: VoiceIntent): boolean => {
    const rule = WRITE_RULES[intent];
    if (req.kioskDevice) return rule.device;
    return !!req.circleRole && rule.roles.includes(req.circleRole);
};

const langOf = (req: KioskRequest): VoiceLang => toVoiceLang(req.headers['accept-language']);

/** Lokales Datum des Servers (gleiche Zeitzone wie die Termine in der Datenbank). */
const today = () => new Date();

const MAX_TEXT = 500;

interface OpenTask { id: string; title: string }

async function openTasks(circleId: string): Promise<OpenTask[]> {
    const result = await query(
        'SELECT id, title FROM tasks WHERE circle_id = $1 AND (is_completed IS NOT TRUE) ORDER BY created_at DESC LIMIT 500',
        [circleId]
    );
    return result.rows as OpenTask[];
}

/** Fehlende Einheit beim Gewicht: das Einheitensystem des Kreises. */
async function withDefaultUnits(circleId: string, intent: VoiceIntent, params: VoiceParams, missing: MissingField[]) {
    if (intent === 'record_weight' && params.value !== undefined && !params.unit) {
        const settings = await getPublicSettings(circleId);
        params.unit = settings.unit_system === 'imperial' ? 'lb' : 'kg';
    }
    return { params, missing };
}

/**
 * Vervollstaendigt und prueft einen Befehl. Bei "Aufgabe erledigt" wird die
 * Aufgabe gesucht: genau ein Treffer oder eine klare Rueckmeldung.
 */
async function prepare(req: KioskRequest, intent: VoiceIntent, rawParams: unknown) {
    const lang = langOf(req);
    const checked = validateCommand(intent, rawParams);
    if ('error' in checked) return { error: checked.error } as const;
    const params: VoiceParams & { task_id?: string; task_title?: string } = { ...checked.params };

    if (intent === 'complete_task') {
        const raw = rawParams && typeof rawParams === 'object' ? (rawParams as Record<string, unknown>) : {};
        const tasks = await openTasks(req.circleId!);
        if (typeof raw.task_id === 'string') {
            const chosen = tasks.find((t) => t.id === raw.task_id);
            if (!chosen) return { error: 'TASK_NOT_FOUND' } as const;
            params.task_id = chosen.id;
            params.task_title = chosen.title;
        } else {
            const found = matchTask(tasks, params.query!);
            if ('error' in found) {
                return {
                    error: found.error,
                    candidates: 'candidates' in found ? found.candidates.slice(0, 5) : undefined,
                } as const;
            }
            params.task_id = found.match.id;
            params.task_title = found.match.title;
        }
    }
    return { params, confirmation_text: confirmationText(intent, params, lang) } as const;
}

// POST /api/voice-commands/parse { text }
router.post('/parse', async (req: KioskRequest, res: Response) => {
    try {
        const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, MAX_TEXT) : '';
        if (!text) return res.status(400).json({ success: false, error: 'TEXT_REQUIRED' });

        const now = today();
        const parsed: ParseResult & { source?: 'rules' | 'local_ai' } = { ...parseCommand(text, now), source: 'rules' };

        if (!parsed.intent) {
            return res.json({ success: true, data: { intent: null, params: {}, missing: [], confirmation_text: null, text } });
        }
        if (!allowed(req, parsed.intent)) {
            return res.status(403).json({ success: false, error: 'NOT_ALLOWED', data: { intent: parsed.intent } });
        }

        // Nur Datum/Uhrzeit, nur lokales Modell, nur wenn die Regeln den Befehl kennen.
        if (parsed.intent === 'create_event' && (parsed.missing.includes('date') || parsed.missing.includes('time'))) {
            const llm = await extractDateTimeWithLocalModel(req.circleId!, text, now);
            if (llm) {
                if (!parsed.params.date && llm.date) parsed.params.date = llm.date;
                if (!parsed.params.time && llm.time) parsed.params.time = llm.time;
                const before = parsed.missing.length;
                parsed.missing = parsed.missing.filter((f) =>
                    !(f === 'date' && parsed.params.date) && !(f === 'time' && parsed.params.time));
                if (parsed.missing.length < before) parsed.source = 'local_ai';
            }
        }

        const { params, missing } = await withDefaultUnits(req.circleId!, parsed.intent, parsed.params, parsed.missing);

        let confirmation_text: string | null = null;
        let extra: Record<string, unknown> = {};
        if (missing.length === 0) {
            const prepared = await prepare(req, parsed.intent, params);
            if ('error' in prepared) {
                extra = { error: prepared.error, candidates: prepared.candidates };
            } else {
                Object.assign(params, prepared.params);
                confirmation_text = prepared.confirmation_text;
            }
        }

        res.json({
            success: true,
            data: {
                intent: parsed.intent,
                params,
                missing,
                source: parsed.source,
                confirmation_text,
                needs_confirmation: parsed.intent !== 'list_events',
                text,
                ...extra,
            },
        });
    } catch (error) {
        logger.error('voice_commands.parse_error', { error: error instanceof Error ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/voice-commands/preview { intent, params }: nach Ergaenzung im Dialog
router.post('/preview', async (req: KioskRequest, res: Response) => {
    try {
        const intent = req.body?.intent as VoiceIntent;
        const checked = validateCommand(intent, req.body?.params);
        if ('error' in checked) return res.status(400).json({ success: false, error: checked.error });
        if (!allowed(req, checked.intent)) return res.status(403).json({ success: false, error: 'NOT_ALLOWED' });
        const prepared = await prepare(req, checked.intent, req.body?.params);
        if ('error' in prepared) {
            return res.status(400).json({ success: false, error: prepared.error, data: { candidates: prepared.candidates } });
        }
        res.json({ success: true, data: { intent: checked.intent, params: prepared.params, confirmation_text: prepared.confirmation_text } });
    } catch (error) {
        logger.error('voice_commands.preview_error', { error: error instanceof Error ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/voice-commands/execute { intent, params }
router.post('/execute', async (req: KioskRequest, res: Response) => {
    const lang = langOf(req);
    try {
        const intent = req.body?.intent as VoiceIntent;
        const checked = validateCommand(intent, req.body?.params);
        if ('error' in checked) return res.status(400).json({ success: false, error: checked.error });
        if (!allowed(req, checked.intent)) return res.status(403).json({ success: false, error: 'NOT_ALLOWED' });

        // Fork: ausgeschaltete Funktionen auch per Sprache nicht nutzbar.
        const circleSettings = await loadCircleSettings(req.circleId!);
        const needed: FeatureId = checked.intent === 'list_events' || checked.intent === 'create_event'
            ? 'calendar'
            : checked.intent === 'create_task' || checked.intent === 'complete_task' ? 'tasks' : 'health';
        if (!isFeatureEnabled(circleSettings, needed)) return res.status(403).json({ success: false, error: 'FEATURE_DISABLED' });

        const prepared = await prepare(req, checked.intent, req.body?.params);
        if ('error' in prepared) {
            return res.status(400).json({ success: false, error: prepared.error, data: { candidates: prepared.candidates } });
        }
        const p = prepared.params;
        const circleId = req.circleId!;
        const userId = req.kioskDevice ? null : (req.userId ?? null);
        const note = req.kioskDevice ? deviceNote(req.kioskDevice.name, lang) : null;

        switch (checked.intent) {
            case 'list_events': {
                const [y, m, d] = p.date!.split('-').map(Number);
                const from = new Date(y, m - 1, d, 0, 0, 0);
                const to = new Date(y, m - 1, d, 23, 59, 59);
                const rows = await query(
                    `SELECT * FROM events
                     WHERE circle_id = $1 AND start_time <= $3
                       AND (rrule IS NOT NULL OR COALESCE(end_time, start_time) >= $2)
                     ORDER BY start_time`,
                    [circleId, toLocalISO(from), toLocalISO(to)]
                );
                const items: Array<{ title: string; time: string; start_time: string }> = [];
                for (const ev of rows.rows) {
                    for (const occ of expandEventOccurrences(ev, from, to)) {
                        const start = toLocalISO(occ.start);
                        items.push({ title: ev.title, time: start.slice(11, 16), start_time: start });
                    }
                }
                items.sort((a, b) => a.start_time.localeCompare(b.start_time));
                const now = today();
                const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
                const spoken = eventsSpoken(p.date!, items, p.date === isoDate(now), p.date === isoDate(tomorrow), lang);
                return res.json({ success: true, data: { intent: 'list_events', events: items, spoken_text: spoken } });
            }
            case 'create_event': {
                const result = await query(
                    `INSERT INTO events (circle_id, title, description, category, start_time, member_ids, created_by)
                     VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6) RETURNING id`,
                    [circleId, p.title, note, p.category === 'medical' ? 'medical' : 'other', `${p.date}T${p.time}:00`, userId]
                );
                await broadcastToCircle(circleId, { type: 'update', entity: 'events', action: 'created' });
                return res.json({ success: true, data: { intent: 'create_event', id: result.rows[0].id, spoken_text: doneText('create_event', lang) } });
            }
            case 'create_task': {
                const result = await query(
                    `INSERT INTO tasks (circle_id, title, description, category, due_date, assigned_to)
                     VALUES ($1, $2, $3, 'other', $4, '[]'::jsonb) RETURNING id`,
                    [circleId, p.title, note, p.due_date ?? null]
                );
                await broadcastToCircle(circleId, { type: 'update', entity: 'tasks', action: 'created' });
                return res.json({ success: true, data: { intent: 'create_task', id: result.rows[0].id, spoken_text: doneText('create_task', lang) } });
            }
            case 'complete_task': {
                const result = await query(
                    `UPDATE tasks SET is_completed = true, completed_at = NOW(), completed_by = $1
                     WHERE id = $2 AND circle_id = $3 AND (is_completed IS NOT TRUE) RETURNING id`,
                    [userId, p.task_id, circleId]
                );
                if (result.rows.length === 0) return res.status(400).json({ success: false, error: 'TASK_NOT_FOUND' });
                await broadcastToCircle(circleId, { type: 'update', entity: 'tasks', action: 'updated' });
                return res.json({ success: true, data: { intent: 'complete_task', id: p.task_id, spoken_text: doneText('complete_task', lang) } });
            }
            case 'record_weight':
            case 'record_glucose': {
                // Gespeichert wird immer metrisch: kg und g/L (siehe lib/units.ts).
                const type = checked.intent === 'record_weight' ? 'weight' : 'glucose';
                const metric = type === 'weight'
                    ? Math.round(weightToKg(p.value!, p.unit === 'lb' ? 'lb' : 'kg') * 100) / 100
                    : Math.round(glucoseToGl(p.value!, p.unit as 'mg/dL' | 'mmol/L' | 'g/L') * 100) / 100;
                const unit = type === 'weight' ? 'kg' : 'g/L';
                const result = await query(
                    `INSERT INTO vitals (circle_id, type, value, unit, recorded_by_user, notes)
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                    [circleId, type, metric, unit, userId, note]
                );
                await broadcastToCircle(circleId, { type: 'update', entity: 'vitals', action: 'created' });
                const thresholdResult = await query(
                    'SELECT type, min_value, max_value, min_value2, max_value2 FROM vital_thresholds WHERE circle_id = $1 AND type = $2',
                    [circleId, type]
                );
                const threshold = thresholdResult.rows[0];
                if (threshold) {
                    const direction = outOfRange(threshold, metric, null);
                    if (direction) await notifyOutOfRange(circleId, type, metric, null, direction, result.rows[0].id);
                }
                return res.json({ success: true, data: { intent: checked.intent, id: result.rows[0].id, spoken_text: doneText(checked.intent, lang) } });
            }
        }
    } catch (error) {
        logger.error('voice_commands.execute_error', { error: error instanceof Error ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
