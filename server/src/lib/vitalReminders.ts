import { query } from '../db';
import { createNotification } from './notifications';
import { claimReminder } from './reminderLog';
import { featureEnabledForCircle, isVitalTypeEnabled, loadCircleSettings } from './features';
import { pickLang, type Lang } from './i18n';
import logger from './logger';

// Fork, Block E: Messwert-Erinnerungen (Tabelle vital_reminders, db.ts).
// - Zur eingestellten Uhrzeit (Standard 7:30) bekommt die betreute Person
//   (Rolle recipient) eine Erinnerung, den Wert zu messen.
// - Erledigt, sobald heute ein Wert dieser Art eingetragen ist, egal von wem
//   und auf welchem Weg (Messwerte, Tagebuch, Sprachbefehl: alles landet in vitals).
// - Fehlt der Wert 2 Stunden nach der Uhrzeit noch, bekommen admin und family
//   einmal einen Hinweis.
// - Jede Erinnerung hoechstens einmal pro Tag und Person (reminder_log).
// - Wurde die Erinnerung heute erst nach der Uhrzeit eingeschaltet oder die Uhrzeit
//   geaendert (changed_at), beginnt sie erst morgen: kein Schwall beim Einrichten.
// Alle Zeiten rechnet die Datenbank (CURRENT_DATE, LOCALTIMESTAMP) in derselben
// Zeitzone wie vitals.measured_at (db.ts setzt die Zeitzone der Sitzung).

export const VITAL_REMINDER_TYPES = ['glucose', 'weight'] as const;
export type VitalReminderType = (typeof VITAL_REMINDER_TYPES)[number];

export const DEFAULT_REMIND_TIME = '07:30';
export const FAMILY_DELAY_MINUTES = 120;
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

export interface VitalReminderSetting {
    type: VitalReminderType;
    enabled: boolean;
    /** 'HH:MM' */
    remind_time: string;
    note: string | null;
}

/** Einstellungen beider Messwerte, fehlende Zeilen mit Standardwerten (aus). */
export async function loadVitalReminderSettings(circleId: string): Promise<VitalReminderSetting[]> {
    const { rows } = await query(
        `SELECT type, enabled, to_char(remind_time, 'HH24:MI') AS remind_time, note
         FROM vital_reminders WHERE circle_id = $1`,
        [circleId]
    );
    const byType = new Map((rows as VitalReminderSetting[]).map((r) => [r.type, r]));
    return VITAL_REMINDER_TYPES.map((type) => byType.get(type) ?? {
        type, enabled: false, remind_time: DEFAULT_REMIND_TIME, note: null,
    });
}

/** Speichert eine Einstellung. changed_at nur, wenn Ein/Aus oder Uhrzeit sich aendern. */
export async function saveVitalReminderSetting(
    circleId: string,
    type: VitalReminderType,
    enabled: boolean,
    remindTime: string,
    note: string | null
): Promise<VitalReminderSetting> {
    const { rows } = await query(
        `INSERT INTO vital_reminders (circle_id, type, enabled, remind_time, note)
         VALUES ($1, $2, $3, $4::time, $5)
         ON CONFLICT (circle_id, type) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           remind_time = EXCLUDED.remind_time,
           note = EXCLUDED.note,
           changed_at = CASE
             WHEN vital_reminders.enabled IS DISTINCT FROM EXCLUDED.enabled
               OR vital_reminders.remind_time IS DISTINCT FROM EXCLUDED.remind_time
             THEN CURRENT_TIMESTAMP ELSE vital_reminders.changed_at END
         RETURNING type, enabled, to_char(remind_time, 'HH24:MI') AS remind_time, note`,
        [circleId, type, enabled, remindTime, note]
    );
    return rows[0] as VitalReminderSetting;
}

/**
 * Eingeschaltete Erinnerungen, fuer die heute noch kein Wert eingetragen ist
 * (nur eingeschaltete Messwerte des Kreises). Fuer die einfache Ansicht: Sie
 * zeigt eine Zeile, sobald die Uhrzeit erreicht ist. Enthaelt keine Messwerte.
 */
export async function openVitalRemindersToday(circleId: string): Promise<VitalReminderSetting[]> {
    const { rows } = await query(
        `SELECT vr.type, vr.enabled, to_char(vr.remind_time, 'HH24:MI') AS remind_time, vr.note
         FROM vital_reminders vr
         WHERE vr.circle_id = $1 AND vr.enabled = TRUE
           AND NOT EXISTS (
             SELECT 1 FROM vitals v
             WHERE v.circle_id = vr.circle_id AND v.type = vr.type
               AND v.measured_at >= CURRENT_DATE AND v.measured_at < CURRENT_DATE + 1
           )
         ORDER BY vr.remind_time, vr.type`,
        [circleId]
    );
    const settings = await loadCircleSettings(circleId);
    return (rows as VitalReminderSetting[]).filter((r) => isVitalTypeEnabled(settings, r.type));
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

/** Jede Minute: Erinnerungen an die betreute Person und Hinweise an die Familie. */
export async function checkVitalReminders(): Promise<void> {
    try {
        const { rows } = await query(
            `SELECT vr.circle_id, vr.type, to_char(vr.remind_time, 'HH24:MI') AS remind_time, vr.note,
                    to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today,
                    LOCALTIMESTAMP >= LEAST(CURRENT_DATE + vr.remind_time + make_interval(mins => $1::int),
                                            CURRENT_DATE + TIME '23:59') AS family_due
             FROM vital_reminders vr
             WHERE vr.enabled = TRUE
               AND LOCALTIMESTAMP >= CURRENT_DATE + vr.remind_time
               AND vr.changed_at <= CURRENT_DATE + vr.remind_time
               AND NOT EXISTS (
                 SELECT 1 FROM vitals v
                 WHERE v.circle_id = vr.circle_id AND v.type = vr.type
                   AND v.measured_at >= CURRENT_DATE AND v.measured_at < CURRENT_DATE + 1
               )`,
            [FAMILY_DELAY_MINUTES]
        );

        for (const row of rows as DueRow[]) {
            if (!(await featureEnabledForCircle(row.circle_id, 'health'))) continue;
            if (!isVitalTypeEnabled(await loadCircleSettings(row.circle_id), row.type)) continue;

            // 1. Erinnerung an die betreute Person (einmal pro Tag)
            let sent = 0;
            for (const member of await membersWithRoles(row.circle_id, ['recipient'])) {
                if (!(await claimReminder(`vital_due_${row.type}`, row.circle_id, row.today, member.user_id))) continue;
                const { title, body } = recipientTexts(row.type, row.note, member.language);
                await createNotification({
                    userId: member.user_id,
                    circleId: row.circle_id,
                    title,
                    message: body,
                    type: 'vital_reminder',
                    relatedId: row.circle_id,
                    url: '/',
                    tag: `vital-reminder-${row.type}`,
                });
                sent++;
            }
            if (sent > 0) logger.info('reminder.vital_sent', { circleId: row.circle_id, type: row.type, recipients: sent });

            // 2. Nach 2 Stunden ohne Wert: einmal Hinweis an admin und family
            if (!row.family_due) continue;
            const recipient = await query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [row.circle_id]);
            const firstName: string = recipient.rows[0]?.first_name?.trim() || '';
            let hinted = 0;
            for (const member of await membersWithRoles(row.circle_id, ['admin', 'family'])) {
                if (!(await claimReminder(`vital_missing_${row.type}`, row.circle_id, row.today, member.user_id))) continue;
                const { title, body } = familyTexts(row.type, row.remind_time, firstName, member.language);
                await createNotification({
                    userId: member.user_id,
                    circleId: row.circle_id,
                    title,
                    message: body,
                    type: 'vital_missing',
                    relatedId: row.circle_id,
                    url: '/health',
                    tag: `vital-missing-${row.type}`,
                });
                hinted++;
            }
            if (hinted > 0) logger.info('reminder.vital_missing_sent', { circleId: row.circle_id, type: row.type, recipients: hinted });
        }
    } catch (err) {
        logger.error('reminder.vital_error', { error: err instanceof Error ? err.message : String(err) });
    }
}
