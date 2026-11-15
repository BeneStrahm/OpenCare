import { getClient, query } from '../db';
import { createNotification } from './notifications';
import { claimReminder } from './reminderLog';
import { featureEnabledForCircle, isVitalTypeEnabled, loadCircleSettings } from './features';
import { pickLang, type Lang } from './i18n';
import logger from './logger';

// Fork, Block E: Messwert-Erinnerungen (Tabellen vital_reminders und
// vital_reminder_times, db.ts).
// - Je Messwert bis zu 6 Uhrzeiten (Standard 7:30), je Uhrzeit ein Hinweis. Zu jeder
//   Uhrzeit bekommt die betreute Person (Rolle recipient) eine Erinnerung.
// - Eine Uhrzeit ist erledigt, sobald ein Wert dieser Art bis zu 2 Stunden davor oder
//   danach eingetragen ist, egal von wem und auf welchem Weg (Messwerte, Tagebuch,
//   Sprachbefehl: alles landet in vitals).
// - Fehlt der Wert 2 Stunden nach der Uhrzeit noch, bekommen admin und family
//   einmal einen Hinweis.
// - Jede Erinnerung hoechstens einmal pro Tag, Uhrzeit und Person (reminder_log).
// - Wurde die Erinnerung heute erst nach der Uhrzeit eingeschaltet oder die Uhrzeit
//   neu eingetragen (changed_at), beginnt sie erst morgen: kein Schwall beim Einrichten.
// Alle Zeiten rechnet die Datenbank (CURRENT_DATE, LOCALTIMESTAMP) in derselben
// Zeitzone wie vitals.measured_at (db.ts setzt die Zeitzone der Sitzung).

export const VITAL_REMINDER_TYPES = ['glucose', 'weight'] as const;
export type VitalReminderType = (typeof VITAL_REMINDER_TYPES)[number];

export const DEFAULT_REMIND_TIME = '07:30';
/** Ein Wert zaehlt fuer eine Uhrzeit, wenn er hoechstens so viele Minuten davor oder danach liegt.
 *  Am Ende dieses Fensters bekommt die Familie den Hinweis. */
export const MEASURE_WINDOW_MINUTES = 120;
export const MAX_REMIND_TIMES = 6;
export const MAX_NOTE_LENGTH = 80;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isVitalReminderType(value: unknown): value is VitalReminderType {
    return typeof value === 'string' && (VITAL_REMINDER_TYPES as readonly string[]).includes(value);
}

/** 'HH:MM' oder null, wenn ungueltig. */
export function cleanRemindTime(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const time = value.trim().slice(0, 5);
    return TIME_RE.test(time) ? time : null;
}

/** Freier Hinweis (z. B. "vor dem Fruehstueck"), gekuerzt, leer = null. */
export function cleanNote(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const note = value.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LENGTH);
    return note || null;
}

export interface VitalReminderTime {
    /** 'HH:MM' */
    time: string;
    note: string | null;
}

export interface VitalReminderSetting {
    type: VitalReminderType;
    enabled: boolean;
    /** Aufsteigend sortiert, mindestens eine Uhrzeit. */
    times: VitalReminderTime[];
}

/** Eine faellige Uhrzeit (einfache Ansicht, Planer). */
export interface VitalReminderSlot {
    type: VitalReminderType;
    /** 'HH:MM' */
    remind_time: string;
    note: string | null;
}

/**
 * Prueft die Liste der Uhrzeiten aus der Anfrage: 1 bis MAX_REMIND_TIMES, gueltig,
 * jede nur einmal. Gibt die sortierte Liste oder einen Fehlerschluessel zurueck.
 */
export function cleanRemindTimes(value: unknown): { times: VitalReminderTime[] } | { error: 'time' | 'count' | 'duplicate' } {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REMIND_TIMES) return { error: 'count' };
    const times: VitalReminderTime[] = [];
    for (const item of value) {
        const time = cleanRemindTime(item && typeof item === 'object' ? (item as { time?: unknown }).time : undefined);
        if (!time) return { error: 'time' };
        if (times.some((t) => t.time === time)) return { error: 'duplicate' };
        times.push({ time, note: cleanNote((item as { note?: unknown }).note) });
    }
    times.sort((a, b) => a.time.localeCompare(b.time));
    return { times };
}

/** Einstellungen beider Messwerte, fehlende Zeilen mit Standardwerten (aus). */
export async function loadVitalReminderSettings(circleId: string): Promise<VitalReminderSetting[]> {
    const { rows: heads } = await query(
        'SELECT type, enabled FROM vital_reminders WHERE circle_id = $1',
        [circleId]
    );
    const { rows: timeRows } = await query(
        `SELECT type, to_char(remind_time, 'HH24:MI') AS time, note
         FROM vital_reminder_times WHERE circle_id = $1
         ORDER BY remind_time`,
        [circleId]
    );
    const enabledByType = new Map((heads as { type: string; enabled: boolean }[]).map((r) => [r.type, r.enabled]));
    return VITAL_REMINDER_TYPES.map((type) => {
        const times = (timeRows as { type: string; time: string; note: string | null }[])
            .filter((r) => r.type === type)
            .map(({ time, note }) => ({ time, note }));
        return {
            type,
            enabled: enabledByType.get(type) ?? false,
            times: times.length > 0 ? times : [{ time: DEFAULT_REMIND_TIME, note: null }],
        };
    });
}

/**
 * Speichert eine Einstellung in einer Transaktion. changed_at einer Uhrzeit wird neu
 * gesetzt, wenn sie neu ist oder Ein/Aus sich aendert; ein geaenderter Hinweis allein
 * zaehlt nicht. vital_reminders.remind_time und note halten die erste Uhrzeit.
 */
export async function saveVitalReminderSetting(
    circleId: string,
    type: VitalReminderType,
    enabled: boolean,
    times: VitalReminderTime[]
): Promise<VitalReminderSetting> {
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const before = await client.query(
            'SELECT enabled FROM vital_reminders WHERE circle_id = $1 AND type = $2 FOR UPDATE',
            [circleId, type]
        );
        const toggled = before.rows.length === 0 || before.rows[0].enabled !== enabled;
        await client.query(
            `INSERT INTO vital_reminders (circle_id, type, enabled, remind_time, note)
             VALUES ($1, $2, $3, $4::time, $5)
             ON CONFLICT (circle_id, type) DO UPDATE SET
               enabled = EXCLUDED.enabled,
               remind_time = EXCLUDED.remind_time,
               note = EXCLUDED.note,
               changed_at = CASE WHEN vital_reminders.enabled IS DISTINCT FROM EXCLUDED.enabled
                 THEN CURRENT_TIMESTAMP ELSE vital_reminders.changed_at END`,
            [circleId, type, enabled, times[0].time, times[0].note]
        );
        await client.query(
            `DELETE FROM vital_reminder_times
             WHERE circle_id = $1 AND type = $2 AND NOT (to_char(remind_time, 'HH24:MI') = ANY($3::text[]))`,
            [circleId, type, times.map((t) => t.time)]
        );
        for (const t of times) {
            await client.query(
                `INSERT INTO vital_reminder_times (circle_id, type, remind_time, note)
                 VALUES ($1, $2, $3::time, $4)
                 ON CONFLICT (circle_id, type, remind_time) DO UPDATE SET note = EXCLUDED.note`,
                [circleId, type, t.time, t.note]
            );
        }
        if (toggled) {
            await client.query(
                'UPDATE vital_reminder_times SET changed_at = CURRENT_TIMESTAMP WHERE circle_id = $1 AND type = $2',
                [circleId, type]
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    return { type, enabled, times };
}

/** SQL: Gibt es fuer diese Uhrzeit (Alias t, heute) einen Wert im Fenster? Parameter $FENSTER = Minuten. */
const valueInWindow = (windowParam: string) => `EXISTS (
    SELECT 1 FROM vitals v
    WHERE v.circle_id = t.circle_id AND v.type = t.type
      AND v.measured_at >= CURRENT_DATE + t.remind_time - make_interval(mins => ${windowParam}::int)
      AND v.measured_at <= CURRENT_DATE + t.remind_time + make_interval(mins => ${windowParam}::int)
)`;

/**
 * Eingeschaltete Uhrzeiten von heute ohne passenden Wert, deren Fenster noch nicht
 * vorbei ist (nur eingeschaltete Messwerte des Kreises). Fuer die einfache Ansicht:
 * Sie zeigt eine Zeile, sobald die Uhrzeit erreicht ist. Enthaelt keine Messwerte.
 */
export async function openVitalRemindersToday(circleId: string): Promise<VitalReminderSlot[]> {
    const { rows } = await query(
        `SELECT t.type, to_char(t.remind_time, 'HH24:MI') AS remind_time, t.note
         FROM vital_reminder_times t
         JOIN vital_reminders vr ON vr.circle_id = t.circle_id AND vr.type = t.type
         WHERE t.circle_id = $1 AND vr.enabled = TRUE
           AND LOCALTIMESTAMP < CURRENT_DATE + t.remind_time + make_interval(mins => $2::int)
           AND NOT ${valueInWindow('$2')}
         ORDER BY t.remind_time, t.type`,
        [circleId, MEASURE_WINDOW_MINUTES]
    );
    const settings = await loadCircleSettings(circleId);
    return (rows as VitalReminderSlot[]).filter((r) => isVitalTypeEnabled(settings, r.type));
}

// ── Texte ──

const TYPE_NAMES: Record<Lang, Record<VitalReminderType, string>> = {
    de: { glucose: 'Blutzucker', weight: 'Gewicht' },
    en: { glucose: 'blood sugar', weight: 'weight' },
    fr: { glucose: 'glycémie', weight: 'poids' },
    es: { glucose: 'glucosa', weight: 'peso' },
};

function recipientTexts(type: VitalReminderType, note: string | null, language: string): { title: string; body: string } {
    const lang = pickLang(language);
    const name = TYPE_NAMES[lang][type];
    const extra = note ? ` (${note})` : '';
    if (lang === 'de') {
        return type === 'glucose'
            ? { title: 'Zeit zum Messen: Blutzucker', body: `Bitte messen Sie jetzt Ihren Blutzucker${extra}.` }
            : { title: 'Zeit zum Wiegen', body: `Bitte wiegen Sie sich jetzt${extra}.` };
    }
    if (lang === 'es') return { title: `Hora de medir: ${name}`, body: `Por favor, mida ahora su ${name}${extra}.` };
    if (lang === 'en') return { title: `Time to measure: ${name}`, body: `Please measure your ${name} now${extra}.` };
    return { title: `C'est l'heure de mesurer : ${name}`, body: `Merci de mesurer maintenant votre ${name}${extra}.` };
}

function familyTexts(type: VitalReminderType, time: string, firstName: string, language: string): { title: string; body: string } {
    const lang = pickLang(language);
    const name = TYPE_NAMES[lang][type];
    if (lang === 'de') {
        const who = firstName ? ` für ${firstName}` : '';
        return {
            title: `Heute noch kein ${name} eingetragen`,
            body: `Die Erinnerung war um ${time} Uhr. Bis jetzt ist${who} noch kein Wert eingetragen. Bitte fragen Sie kurz nach.`,
        };
    }
    if (lang === 'es') {
        const who = firstName ? ` para ${firstName}` : '';
        return {
            title: `Hoy aún sin ${name}`,
            body: `El recordatorio fue a las ${time}. Todavía no hay ningún valor${who}. Por favor, pregunte.`,
        };
    }
    if (lang === 'en') {
        const who = firstName ? ` for ${firstName}` : '';
        return {
            title: `No ${name} recorded today yet`,
            body: `The reminder was at ${time}. No value has been recorded${who} so far. Please check in.`,
        };
    }
    const who = firstName ? ` pour ${firstName}` : '';
    return {
        title: `Pas encore de ${name} aujourd'hui`,
        body: `Le rappel était à ${time}. Aucune valeur n'est encore saisie${who}. Pensez à prendre des nouvelles.`,
    };
}

// ── Planer ──

interface DueRow {
    circle_id: string;
    type: VitalReminderType;
    remind_time: string;
    note: string | null;
    /** 'YYYY-MM-DD' (lokaler Tag) */
    today: string;
    /** Fenster noch offen: Erinnerung an die betreute Person lohnt sich noch. */
    recipient_due: boolean;
    family_due: boolean;
}

interface MemberRow { user_id: string; language: string }

async function membersWithRoles(circleId: string, roles: string[]): Promise<MemberRow[]> {
    const { rows } = await query(
        `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
         FROM circle_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.circle_id = $1 AND cm.role = ANY($2)`,
        [circleId, roles]
    );
    return rows as MemberRow[];
}

/** Jede Minute: Erinnerungen an die betreute Person und Hinweise an die Familie, je Uhrzeit. */
export async function checkVitalReminders(): Promise<void> {
    try {
        const { rows } = await query(
            `SELECT t.circle_id, t.type, to_char(t.remind_time, 'HH24:MI') AS remind_time, t.note,
                    to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today,
                    LOCALTIMESTAMP < CURRENT_DATE + t.remind_time + make_interval(mins => $1::int) AS recipient_due,
                    LOCALTIMESTAMP >= LEAST(CURRENT_DATE + t.remind_time + make_interval(mins => $1::int),
                                            CURRENT_DATE + TIME '23:59') AS family_due
             FROM vital_reminder_times t
             JOIN vital_reminders vr ON vr.circle_id = t.circle_id AND vr.type = t.type
             WHERE vr.enabled = TRUE
               AND LOCALTIMESTAMP >= CURRENT_DATE + t.remind_time
               AND t.changed_at <= CURRENT_DATE + t.remind_time
               AND NOT ${valueInWindow('$1')}`,
            [MEASURE_WINDOW_MINUTES]
        );

        for (const row of rows as DueRow[]) {
            if (!(await featureEnabledForCircle(row.circle_id, 'health'))) continue;
            if (!isVitalTypeEnabled(await loadCircleSettings(row.circle_id), row.type)) continue;

            // Ein Eintrag je Tag und Uhrzeit, z. B. '2026-11-15 07:30'
            const slot = `${row.today} ${row.remind_time}`;

            // 1. Erinnerung an die betreute Person (einmal je Uhrzeit, solange das Fenster offen ist)
            let sent = 0;
            const recipients = row.recipient_due ? await membersWithRoles(row.circle_id, ['recipient']) : [];
            for (const member of recipients) {
                if (!(await claimReminder(`vital_due_${row.type}`, row.circle_id, slot, member.user_id))) continue;
                const { title, body } = recipientTexts(row.type, row.note, member.language);
                await createNotification({
                    userId: member.user_id,
                    circleId: row.circle_id,
                    title,
                    message: body,
                    type: 'vital_reminder',
                    relatedId: row.circle_id,
                    url: '/',
                    tag: `vital-reminder-${row.type}-${row.remind_time}`,
                });
                sent++;
            }
            if (sent > 0) logger.info('reminder.vital_sent', { circleId: row.circle_id, type: row.type, time: row.remind_time, recipients: sent });

            // 2. Nach 2 Stunden ohne Wert: einmal je Uhrzeit Hinweis an admin und family
            if (!row.family_due) continue;
            const recipient = await query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [row.circle_id]);
            const firstName: string = recipient.rows[0]?.first_name?.trim() || '';
            let hinted = 0;
            for (const member of await membersWithRoles(row.circle_id, ['admin', 'family'])) {
                if (!(await claimReminder(`vital_missing_${row.type}`, row.circle_id, slot, member.user_id))) continue;
                const { title, body } = familyTexts(row.type, row.remind_time, firstName, member.language);
                await createNotification({
                    userId: member.user_id,
                    circleId: row.circle_id,
                    title,
                    message: body,
                    type: 'vital_missing',
                    relatedId: row.circle_id,
                    url: '/health',
                    tag: `vital-missing-${row.type}-${row.remind_time}`,
                });
                hinted++;
            }
            if (hinted > 0) logger.info('reminder.vital_missing_sent', { circleId: row.circle_id, type: row.type, time: row.remind_time, recipients: hinted });
        }
    } catch (err) {
        logger.error('reminder.vital_error', { error: err instanceof Error ? err.message : String(err) });
    }
}
