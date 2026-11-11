import { featureEnabledForCircle } from './features';
import cron from 'node-cron';
import { format } from 'date-fns';
import { query } from '../db';
import { createNotification } from './notifications';
import { checkLowStock } from './stockAlerts';
import { backupCheckEnabled, checkBackupStatus } from './backupAlerts';
import logger from './logger';
import { pickLang } from './i18n';
import { TRAVEL_ACTIVE_SQL } from './eventExtras';
import { expandEventOccurrences } from '../routes/events';
import { claimReminder, pruneReminderLog } from './reminderLog';
import { checkVitalReminders } from './vitalReminders';

// Rappels planifiés du cercle de soin:
//  - rappels d'événements (events.reminder_30min / reminder_1hour), notifiés
//    à TOUS les membres du cercle (notification interne + web push);
//    Fork, Block E: pour une série, chaque occurrence (reminder_log, sans doublon);
//  - Fork, Block E: rappels de mesure (lib/vitalReminders.ts);
//  - rappel quotidien (9h) de renouvellement d'ordonnance, notifié aux membres
//    admin + family du cercle, une seule fois par jour et par ordonnance.
// Les rappels de prise de médicaments (medication_intakes) sont gérés ailleurs.

interface EventRow {
    id: string;
    /** Fork: Serienregel; dann zaehlt jedes Vorkommen einzeln. */
    rrule?: string | null;
    exceptions?: unknown;
    end_time?: string | null;
    circle_id: string;
    title: string;
    /** Naive local timestamp string ('YYYY-MM-DDTHH:mm:ss'), see the pg type parser in db.ts */
    start_time: string;
    location?: string | null;
    /** Fork: Hinfahrt in Minuten vor Beginn; dann erinnert die App vor der Abfahrt. */
    travel_to_minutes?: number | null;
    driver_to?: string | null;
}

interface MemberRow {
    user_id: string;
    /** Recipient's preferred language ('fr' | 'en' | 'es' | 'de'), defaults to 'fr' */
    language: string;
}

// events.start_time is a naive TIMESTAMP holding LOCAL wall-clock time, so the
// comparison windows must be formatted as naive server-local strings, NOT
// toISOString(), which is UTC and would shift the windows by the UTC offset.
const toLocalNaive = (d: Date): string => format(d, "yyyy-MM-dd'T'HH:mm:ss");

interface ReminderTexts {
    title: string;
    body: string;
}

function buildEventTexts(event: EventRow, kind: '30min' | '1hour', language: string): ReminderTexts {
    // start_time is 'YYYY-MM-DDTHH:mm:ss': extract HH:mm directly, no Date round-trip.
    const timeStr = event.start_time.slice(11, 16);
    const suffix = `${timeStr}${event.location ? ` · ${event.location}` : ''}`;
    const lang = pickLang(language);

    // Fork: Mit Hinfahrt bezieht sich die Erinnerung auf die Abfahrt.
    const travel = event.travel_to_minutes ?? 0;
    if (travel > 0) {
        const departure = format(new Date(new Date(event.start_time).getTime() - travel * 60 * 1000), 'HH:mm');
        const driver = event.driver_to ? event.driver_to : '';
        if (lang === 'de') {
            return {
                title: `⏰ Abfahrt: ${event.title}`,
                body: `${kind === '30min' ? 'In 30 Minuten' : 'In 1 Stunde'} losfahren · Abfahrt ${departure} Uhr · Termin ${timeStr} Uhr${event.location ? ` · ${event.location}` : ''}${driver ? ` · Fahrdienst: ${driver}` : ''}`,
            };
        }
        if (lang === 'es') {
            return {
                title: `⏰ Salida: ${event.title}`,
                body: `${kind === '30min' ? 'Dentro de 30 minutos' : 'Dentro de 1 hora'} · salida ${departure} · cita ${suffix}${driver ? ` · conduce: ${driver}` : ''}`,
            };
        }
        if (lang === 'en') {
            return {
                title: `⏰ Departure: ${event.title}`,
                body: `${kind === '30min' ? 'In 30 minutes' : 'In 1 hour'} · leave at ${departure} · appointment ${suffix}${driver ? ` · driver: ${driver}` : ''}`,
            };
        }
        return {
            title: `⏰ Départ : ${event.title}`,
            body: `${kind === '30min' ? 'Dans 30 minutes' : 'Dans 1 heure'} · départ ${departure} · rendez-vous ${suffix}${driver ? ` · conduit : ${driver}` : ''}`,
        };
    }

    if (lang === 'de') {
        return {
            title: `⏰ Erinnerung: ${event.title}`,
            body: `${kind === '30min' ? 'In 30 Minuten' : 'In 1 Stunde'} · ${timeStr} Uhr${event.location ? ` · ${event.location}` : ''}`,
        };
    }
    if (lang === 'es') {
        return {
            title: `⏰ Recordatorio: ${event.title}`,
            body: `${kind === '30min' ? 'Dentro de 30 minutos' : 'Dentro de 1 hora'} · ${suffix}`,
        };
    }
    if (lang === 'en') {
        return {
            title: `⏰ Reminder: ${event.title}`,
            body: `${kind === '30min' ? 'In 30 minutes' : 'In 1 hour'} · ${suffix}`,
        };
    }
    return {
        title: `⏰ Rappel : ${event.title}`,
        body: `${kind === '30min' ? 'Dans 30 minutes' : 'Dans 1 heure'} · ${suffix}`,
    };
}

/** All members of the circle with their preferred language. */
async function circleMembers(circleId: string): Promise<MemberRow[]> {
    const { rows } = await query(
        `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
         FROM circle_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.circle_id = $1`,
        [circleId]
    );
    return rows as MemberRow[];
}

/**
 * Fork, Block E: Vorkommen eines Termins, deren Erinnerungszeitpunkt (Beginn,
 * mit Hinfahrt die Abfahrt) im Fenster liegt. Einzeltermine liefern hoechstens
 * eines, Serien jedes passende Vorkommen (Regel und Ausnahmen wie im Kalender,
 * expandEventOccurrences aus routes/events.ts).
 */
function dueOccurrences(event: EventRow, windowStart: Date, windowEnd: Date): Array<{ start: Date; occurrenceDate: string }> {
    const travelMs = (event.travel_to_minutes ?? 0) * 60 * 1000;
    const from = new Date(windowStart.getTime() + travelMs);
    const to = new Date(windowEnd.getTime() + travelMs);
    return expandEventOccurrences(
        { start_time: event.start_time, end_time: event.end_time ?? null, rrule: event.rrule ?? null, exceptions: event.exceptions },
        from,
        to
    ).filter((occ) => occ.start.getTime() >= from.getTime() && occ.start.getTime() <= to.getTime());
}

async function processEventWindow(
    windowStart: Date,
    windowEnd: Date,
    flagColumn: 'reminder_30min' | 'reminder_1hour',
    kind: '30min' | '1hour'
): Promise<void> {
    const type = flagColumn; // notification type mirrors the flag name
    const { rows } = await query(
        // Fork: Mit Hinfahrt zählt die Abfahrt (Beginn minus Fahrzeit), sonst der Beginn.
        // Fahrt mit abgehaktem Kästchen „Jemand muss fahren“ zählt nicht.
        // Fork, Block E: Serien (rrule) kommen alle mit, sofern sie vor dem Fenster
        // (plus hoechstens einem Tag Fahrzeit) begonnen haben; die Vorkommen
        // rechnet dueOccurrences aus. Vorher zaehlte nur der erste Termin einer Serie.
        `SELECT e.id, e.circle_id, e.title, e.start_time, e.end_time, e.location, e.rrule, e.exceptions,
                CASE WHEN ${TRAVEL_ACTIVE_SQL} THEN e.travel_to_minutes END AS travel_to_minutes,
                CASE WHEN ${TRAVEL_ACTIVE_SQL} THEN e.driver_to END AS driver_to
         FROM events e
         WHERE e.${flagColumn} = true
           AND (
             (e.rrule IS NULL
              AND (e.start_time - make_interval(mins => (CASE WHEN ${TRAVEL_ACTIVE_SQL}
                   THEN COALESCE(e.travel_to_minutes, 0) ELSE 0 END)::int)) BETWEEN $1 AND $2)
             OR (e.rrule IS NOT NULL AND e.start_time <= $2::timestamp + INTERVAL '1 day')
           )`,
        [toLocalNaive(windowStart), toLocalNaive(windowEnd)]
    );

    for (const event of rows as EventRow[]) {
        const occurrences = dueOccurrences(event, windowStart, windowEnd);
        if (occurrences.length === 0) continue;
        // Fork: Kalender ausgeschaltet -> keine Termin-Erinnerungen.
        if (!(await featureEnabledForCircle(event.circle_id, 'calendar'))) continue;
        const members = await circleMembers(event.circle_id);
        for (const occ of occurrences) {
            // Texte mit der Uhrzeit dieses Vorkommens (auch wenn es verschoben wurde).
            const occurrence: EventRow = { ...event, start_time: toLocalNaive(occ.start) };
            let sent = 0;
            // Every circle member gets the event reminder, once per occurrence
            // (reminder_log: Termin + Datum des Vorkommens + Person). A member added
            // between two ticks still gets notified; a double tick sends nothing twice.
            for (const member of members) {
                if (!(await claimReminder(type, event.id, occ.occurrenceDate, member.user_id))) continue;
                const { title, body } = buildEventTexts(occurrence, kind, member.language);
                await createNotification({
                    userId: member.user_id,
                    circleId: event.circle_id,
                    title,
                    message: body,
                    type,
                    relatedId: event.id,
                    url: '/calendar',
                    tag: `reminder-${event.id}-${occ.occurrenceDate}-${kind}`,
                });
                sent++;
            }
            if (sent > 0) {
                logger.info('reminder.event_sent', { eventId: event.id, occurrence: occ.occurrenceDate, type: kind, recipients: sent });
            }
        }
    }
}

async function checkEventReminders(): Promise<void> {
    const now = new Date();

    try {
        // Window: 25 to 35 min from now (covers the "30 min before" cron tick)
        await processEventWindow(
            new Date(now.getTime() + 25 * 60 * 1000),
            new Date(now.getTime() + 35 * 60 * 1000),
            'reminder_30min',
            '30min'
        );

        // Window: 55 to 65 min from now (covers the "1 hour before" cron tick)
        await processEventWindow(
            new Date(now.getTime() + 55 * 60 * 1000),
            new Date(now.getTime() + 65 * 60 * 1000),
            'reminder_1hour',
            '1hour'
        );
    } catch (err) {
        logger.error('reminder.scheduler_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

interface PrescriptionRow {
    id: string;
    circle_id: string;
    title: string;
    /** 'YYYY-MM-DD' */
    renewal_date: string;
}

function buildPrescriptionTexts(prescription: PrescriptionRow, language: string): ReminderTexts {
    const [y, m, d] = prescription.renewal_date.split('-');
    const lang = pickLang(language);
    if (lang === 'de') {
        return {
            title: '💊 Rezept erneuern',
            body: `„${prescription.title}“ muss bis zum ${d}.${m}.${y} erneuert werden`,
        };
    }
    if (lang === 'es') {
        return {
            title: '💊 Renovación de receta',
            body: `«${prescription.title}» debe renovarse antes del ${d}/${m}/${y}`,
        };
    }
    if (lang === 'en') {
        return {
            title: '💊 Prescription renewal',
            body: `"${prescription.title}" must be renewed by ${prescription.renewal_date}`,
        };
    }
    return {
        title: '💊 Renouvellement d\'ordonnance',
        body: `« ${prescription.title} » est à renouveler avant le ${d}/${m}/${y}`,
    };
}

/**
 * Daily prescription renewal reminders: for every prescription whose renewal
 * window is open (renewal_date - reminder_days <= today <= renewal_date),
 * notify the admin + family members of the circle. At most one notification
 * per prescription per day: the inner NOT EXISTS skips prescriptions that
 * already got a 'prescription_renewal' notification today (related_id check).
 */
async function checkPrescriptionRenewals(): Promise<void> {
    try {
        const { rows } = await query(
            `SELECT p.id, p.circle_id, p.title,
                    to_char(p.renewal_date, 'YYYY-MM-DD') AS renewal_date
             FROM prescriptions p
             WHERE p.renewal_date IS NOT NULL
               AND p.renewal_date - p.reminder_days <= CURRENT_DATE
               AND p.renewal_date >= CURRENT_DATE
               AND NOT EXISTS (
                 SELECT 1 FROM notifications n
                 WHERE n.related_id = p.id
                   AND n.type = 'prescription_renewal'
                   AND n.created_at >= CURRENT_DATE
               )`
        );

        for (const prescription of rows as PrescriptionRow[]) {
            if (!(await featureEnabledForCircle(prescription.circle_id, 'medications'))) continue;
            const { rows: memberRows } = await query(
                `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
                 FROM circle_members cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE cm.circle_id = $1
                   AND cm.role IN ('admin', 'family')`,
                [prescription.circle_id]
            );

            for (const member of memberRows as MemberRow[]) {
                const { title, body } = buildPrescriptionTexts(prescription, member.language);
                await createNotification({
                    userId: member.user_id,
                    circleId: prescription.circle_id,
                    title,
                    message: body,
                    type: 'prescription_renewal',
                    relatedId: prescription.id,
                    url: '/medications',
                    tag: `prescription-${prescription.id}`,
                });
            }
            logger.info('reminder.prescription_sent', {
                prescriptionId: prescription.id,
                recipients: (memberRows as MemberRow[]).length,
            });
        }
    } catch (err) {
        logger.error('reminder.prescription_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

function buildHydrationTexts(firstName: string, language: string): ReminderTexts {
    const lang = pickLang(language);
    if (lang === 'de') {
        return {
            title: '🌡️ Hitze: Zeit zum Trinken',
            body: firstName
                ? `Heute ist es sehr heiß. Bieten Sie ${firstName} ein Glas Wasser an und halten Sie die Wohnung kühl.`
                : 'Heute ist es sehr heiß. Bieten Sie ein Glas Wasser an und halten Sie die Wohnung kühl.',
        };
    }
    if (lang === 'es') {
        return {
            title: '🌡️ Calor: hora de hidratarse',
            body: firstName
                ? `Hace mucho calor hoy. Ofrezca un vaso de agua a ${firstName} y mantenga la casa fresca.`
                : 'Hace mucho calor hoy. Ofrezca un vaso de agua y mantenga la casa fresca.',
        };
    }
    if (lang === 'en') {
        return {
            title: '🌡️ Heat: time to hydrate',
            body: firstName
                ? `Strong heat today. Offer ${firstName} a glass of water and keep the home cool.`
                : 'Strong heat today. Offer a glass of water and keep the home cool.',
        };
    }
    return {
        title: '🌡️ Forte chaleur : pensez à hydrater',
        body: firstName
            ? `Forte chaleur aujourd'hui. Proposez un verre d'eau à ${firstName} et gardez le logement au frais.`
            : `Forte chaleur aujourd'hui. Proposez un verre d'eau et gardez le logement au frais.`,
    };
}

/**
 * Heat-episode hydration reminders: every minute, for circles with an ACTIVE
 * heat episode whose reminder_times contains the current local HH:mm, notify the
 * admin + family members. Dedup window of 5 minutes (keyed on the circle id in
 * related_id) guards against a double cron tick; reminder_times default 4 hours
 * apart, so the next slot fires normally. A missed minute (server down) simply
 * skips that slot: hydration reminders are preventive, not critical.
 */
async function checkHeatwaveHydration(): Promise<void> {
    try {
        // L'heure courante DOIT etre calculee dans le meme fuseau que le cron
        // (process.env.TZ ?? 'Europe/Paris'), pas dans le fuseau de l'OS: les
        // reminder_times sont saisis par l'aidant en heure locale. Sinon, sur un
        // Docker en UTC sans TZ, les rappels tomberaient a la mauvaise heure.
        const tz = process.env.TZ || 'Europe/Paris';
        const nowHm = new Intl.DateTimeFormat('en-GB', {
            timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).format(new Date());
        const { rows } = await query(
            `SELECT h.circle_id
             FROM heatwave_settings h
             WHERE h.enabled = TRUE AND h.active = TRUE
               AND h.reminder_times @> to_jsonb($1::text)
               AND NOT EXISTS (
                 SELECT 1 FROM notifications n
                 WHERE n.related_id = h.circle_id
                   AND n.type = 'heatwave_hydration'
                   AND n.created_at >= NOW() - INTERVAL '5 minutes'
               )`,
            [nowHm]
        );

        for (const { circle_id: circleId } of rows as Array<{ circle_id: string }>) {
            if (!(await featureEnabledForCircle(circleId, 'heatwave'))) continue;
            const recipientResult = await query(
                'SELECT first_name FROM care_recipients WHERE circle_id = $1',
                [circleId]
            );
            const firstName: string = recipientResult.rows[0]?.first_name?.trim() || '';

            const { rows: memberRows } = await query(
                `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
                 FROM circle_members cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE cm.circle_id = $1 AND cm.role IN ('admin', 'family')`,
                [circleId]
            );

            for (const member of memberRows as MemberRow[]) {
                const { title, body } = buildHydrationTexts(firstName, member.language);
                await createNotification({
                    userId: member.user_id,
                    circleId,
                    title,
                    message: body,
                    type: 'heatwave_hydration',
                    relatedId: circleId,
                    url: '/',
                    tag: `heatwave-${circleId}`,
                });
            }
            if ((memberRows as MemberRow[]).length > 0) {
                logger.info('reminder.heatwave_sent', { circleId, recipients: (memberRows as MemberRow[]).length });
            }
        }
    } catch (err) {
        logger.error('reminder.heatwave_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

export function startReminderScheduler(): void {
    const tz = process.env.TZ ?? 'Europe/Paris';

    // Event reminders: every minute
    cron.schedule('* * * * *', () => {
        void checkEventReminders();
    }, { timezone: tz });

    // Heat-episode hydration reminders: every minute (matches the configured
    // HH:mm slots; the per-circle dedup window makes a double tick idempotent)
    cron.schedule('* * * * *', () => {
        void checkHeatwaveHydration();
    }, { timezone: tz });

    // Fork: low medication stock, every minute (one alert per drop below the threshold)
    cron.schedule('* * * * *', () => {
        void checkLowStock();
    }, { timezone: tz });

    // Fork: Sicherungsstatus alle 15 Minuten, nur mit BACKUP_STATUS_FILE
    if (backupCheckEnabled()) {
        cron.schedule('*/15 * * * *', () => {
            void checkBackupStatus();
        }, { timezone: tz });
        void checkBackupStatus();
    }

    // Fork, Block E: Messwert-Erinnerungen, jede Minute (einmal pro Tag und Person)
    cron.schedule('* * * * *', () => {
        void checkVitalReminders();
    }, { timezone: tz });

    // Fork, Block E: alte Eintraege der Erinnerungs-Merkliste taeglich entfernen
    cron.schedule('20 3 * * *', () => {
        pruneReminderLog().catch((err) => logger.error('reminder.prune_error', {
            error: err instanceof Error ? err.message : String(err),
        }));
    }, { timezone: tz });

    // Prescription renewals: every day at 9:00 (the daily dedup makes it idempotent)
    cron.schedule('0 9 * * *', () => {
        void checkPrescriptionRenewals();
    }, { timezone: tz });

    logger.info('reminder.scheduler_started', { timezone: tz });
}
