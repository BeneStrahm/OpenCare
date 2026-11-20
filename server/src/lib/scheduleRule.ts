/**
 * Eine Regel fuer "gilt diese Einnahmezeit an Tag X?" (E52). Nur hier, nur auf dem
 * Server: die Einnahmen (generateIntakes in lib/intakes.ts) und der Druck des
 * Medikamentenplans (lib/medicationPlan.ts) rechnen damit. Die App rechnet offline
 * nicht selbst, sie zeigt die zuletzt geladenen Einnahmen.
 *
 * Alle Tage sind Texte YYYY-MM-DD (so liefert pg DATE, db.ts), Zeiten naive lokale
 * Texte YYYY-MM-DDTHH:MM:SS (so liefert pg TIMESTAMP). Kein Date-Objekt, damit keine
 * Zeitzone dazwischenkommt.
 */

export interface RuleMedication {
    active?: boolean | null;
    prn?: boolean | null;
    /** Einnehmen ab, inklusive; leer = ohne Beginn */
    start_date?: string | null;
    /** Einnehmen bis, inklusive (letzter Einnahmetag); leer = ohne Ende */
    end_date?: string | null;
}

export interface RuleSchedule {
    /** ISO-Wochentage 1 = Montag ... 7 = Sonntag */
    days_of_week?: readonly number[] | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isDateString = (value: unknown): value is string => typeof value === 'string' && DATE_RE.test(value);

/** Nur der Tagesteil eines Datums oder Zeitpunkts ("2026-11-20T08:00:00" -> "2026-11-20"). */
export const dayOf = (value: string): string => value.slice(0, 10);

/** ISO-Wochentag eines Tages, 1 = Montag ... 7 = Sonntag. */
export const isoWeekday = (day: string): number => {
    const [y, m, d] = day.split('-').map(Number);
    const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return js === 0 ? 7 : js;
};

/** Tag + n Tage (n darf negativ sein). */
export const addDays = (day: string, n: number): string => {
    const [y, m, d] = day.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + n));
    return date.toISOString().slice(0, 10);
};

/** Alle Tage von from bis to, beide inklusive. Hoechstens maxDays Tage. */
export const daysBetween = (from: string, to: string, maxDays = 366): string[] => {
    const days: string[] = [];
    for (let day = from; day <= to && days.length < maxDays; day = addDays(day, 1)) days.push(day);
    return days;
};

/** Liegt der Tag im Zeitraum des Medikaments (Beginn und Ende inklusive, leer = offen)? */
export const medicationValidOn = (med: RuleMedication, day: string): boolean => {
    if (med.start_date && day < dayOf(med.start_date)) return false;
    if (med.end_date && day > dayOf(med.end_date)) return false;
    return true;
};

/** Ist das Medikament am Tag schon beendet (Ende vor dem Tag)? */
export const medicationEndedBefore = (med: RuleMedication, day: string): boolean =>
    Boolean(med.end_date && dayOf(med.end_date) < day);

/** Beginnt das Medikament erst nach dem Tag? */
export const medicationStartsAfter = (med: RuleMedication, day: string): boolean =>
    Boolean(med.start_date && dayOf(med.start_date) > day);

/** Gilt die Einnahmezeit am Wochentag des Tages? Leere oder fehlende Liste: nie (wie bisher in SQL). */
export const scheduleOnWeekday = (schedule: RuleSchedule, day: string): boolean =>
    Array.isArray(schedule.days_of_week) && schedule.days_of_week.includes(isoWeekday(day));

/** Taeglich, wenn alle sieben Wochentage gewaehlt sind. */
export const scheduleIsDaily = (schedule: RuleSchedule): boolean =>
    Array.isArray(schedule.days_of_week) && [1, 2, 3, 4, 5, 6, 7].every((d) => schedule.days_of_week!.includes(d));

/**
 * Die Regel: Einnahmezeit gilt am Tag, wenn das Medikament aktiv ist, nicht "bei Bedarf",
 * der Tag im Zeitraum des Medikaments liegt und der Wochentag gewaehlt ist.
 */
export const scheduleAppliesOn = (med: RuleMedication, schedule: RuleSchedule, day: string): boolean =>
    med.active !== false && med.prn !== true && medicationValidOn(med, day) && scheduleOnWeekday(schedule, day);
