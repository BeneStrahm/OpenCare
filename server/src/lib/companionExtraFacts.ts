import { query } from '../db';
import { expandEventOccurrences, toLocalISO } from '../routes/events';
import { getPublicSettings } from './circleSettings';
import { formatVital, isVitalType, numberLocale } from './units';
import type { FactsEvent, FactsStock, FactsTask, FactsVital, CompanionLang } from './companionAnswers';

/**
 * Fork: Fakten fuer die zusaetzlichen festen Themen des Assistenten
 * (Vorrat, letzte Messwerte, Aufgaben heute, Termine der Woche).
 * Gesundheitsdaten (Vorrat, Messwerte) nur mit includeHealth, sonst null.
 */
export interface CompanionExtraFacts {
    medication_stock: FactsStock[] | null;
    vitals_latest: FactsVital[] | null;
    tasks_due: FactsTask[];
    events_week: FactsEvent[];
}

const stamp = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return toLocalISO(value);
    return String(value);
};

export async function loadCompanionExtraFacts(
    circleId: string,
    includeHealth: boolean,
    lang: CompanionLang,
    now: Date = new Date()
): Promise<CompanionExtraFacts> {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 6, 23, 59, 59);
    const none = Promise.resolve({ rows: [] as unknown[] });

    const [stockResult, vitalsResult, settings, tasksResult, eventsResult] = await Promise.all([
        includeHealth
            ? query(
                `SELECT m.name, m.stock_quantity, m.stock_alert_threshold,
                        (SELECT s.unit FROM medication_schedules s WHERE s.medication_id = m.id AND s.unit IS NOT NULL LIMIT 1) AS unit
                 FROM medications m
                 WHERE m.circle_id = $1 AND m.active = TRUE AND m.stock_quantity IS NOT NULL
                 ORDER BY m.name`,
                [circleId]
            )
            : none,
        includeHealth
            ? query(
                `SELECT DISTINCT ON (type) type, value, value2, measured_at
                 FROM vitals
                 WHERE circle_id = $1
                 ORDER BY type, measured_at DESC`,
                [circleId]
            )
            : none,
        includeHealth ? getPublicSettings(circleId) : Promise.resolve(null),
        // Offene Aufgaben, die heute faellig oder schon ueberfaellig sind.
        query(
            `SELECT title, due_date
             FROM tasks
             WHERE circle_id = $1 AND is_completed = FALSE AND due_date IS NOT NULL AND due_date <= $2
             ORDER BY due_date, title
             LIMIT 50`,
            [circleId, toLocalISO(dayEnd)]
        ),
        query(
            `SELECT * FROM events
             WHERE circle_id = $1
               AND start_time <= $3
               AND (rrule IS NOT NULL OR COALESCE(end_time, start_time) >= $2)
             ORDER BY start_time`,
            [circleId, toLocalISO(dayStart), toLocalISO(weekEnd)]
        ),
    ]);

    const medication_stock: FactsStock[] | null = includeHealth
        ? (stockResult.rows as any[]).map((r) => {
            const threshold = r.stock_alert_threshold === null ? null : Number(r.stock_alert_threshold);
            return {
                name: String(r.name),
                quantity: Number(r.stock_quantity),
                threshold: threshold !== null && Number.isFinite(threshold) ? threshold : null,
                unit: r.unit ?? null,
            };
        }).filter((s) => Number.isFinite(s.quantity))
        : null;

    const system = settings?.unit_system ?? 'metric';
    const vitals_latest: FactsVital[] | null = includeHealth
        ? (vitalsResult.rows as any[]).filter((r) => isVitalType(r.type)).map((r) => ({
            type: r.type,
            display: formatVital(r.type, Number(r.value), r.value2 === null ? null : Number(r.value2), system, numberLocale(lang)),
            measured_at: stamp(r.measured_at) ?? '',
        }))
        : null;

    const tasks_due: FactsTask[] = (tasksResult.rows as any[]).map((r) => ({ title: String(r.title), due_date: stamp(r.due_date) }));

    // Termine ab jetzt bis Ende des siebten Tages (Serien aufgeloest).
    const events_week: FactsEvent[] = [];
    for (const event of eventsResult.rows as any[]) {
        for (const occ of expandEventOccurrences(event, dayStart, weekEnd)) {
            const end = occ.end ?? occ.start;
            if (end.getTime() < now.getTime()) continue;
            events_week.push({
                title: event.title,
                category: event.category,
                location: event.location ?? null,
                start_time: toLocalISO(occ.start),
            });
        }
    }
    events_week.sort((a, b) => a.start_time.localeCompare(b.start_time));

    return { medication_stock, vitals_latest, tasks_due, events_week };
}
