/**
 * Medikamentenplan zum Drucken nach Vorbild BMP (E54, E55). Reine Logik ohne Datenbank:
 * welche Medikamente, in welcher Gruppe, was in den Spalten Mo/Mi/Ab/zN steht und welche
 * Hinweise. Die Texte setzt der Client (client/src/lib/medicationPlanText.ts), hier stehen
 * nur die Angaben. Regel fuer Zeitraum und Wochentage: scheduleRule.ts (E52).
 */

import type { CircleRole } from '../middleware/circle';
import { addDays, medicationEndedBefore, scheduleIsDaily } from './scheduleRule';

/** Drucken duerfen Administrator, Familie und Fachkraft (nicht Freunde, nicht die betreute Person). */
export const PLAN_PRINT_ROLES: CircleRole[] = ['admin', 'family', 'professional'];

/** Seite "Aenderungen der letzten 14 Tage": fest 14 Tage. */
export const PLAN_HISTORY_DAYS = 14;

export type PlanGroup = 'regular' | 'special' | 'prn';
export const PLAN_GROUP_VALUES = ['regular', 'special'] as const;
export type Moment = 'morning' | 'noon' | 'evening' | 'night';
export const MOMENTS: Moment[] = ['morning', 'noon', 'evening', 'night'];

/** Tageszeit einer Uhrzeit, gleiche Grenzen wie im Medikamentenplan der App (Medications.tsx). */
export const momentOf = (time: string): Moment => {
    const hour = parseInt(time.slice(0, 2), 10);
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 17) return 'noon';
    if (hour >= 17 && hour < 22) return 'evening';
    return 'night';
};

export interface PlanScheduleInput {
    time_of_day: string;
    days_of_week: number[] | null;
    quantity: number | string | null;
    unit: string | null;
    time_fixed: boolean | null;
}

export interface PlanMedicationInput {
    id: string;
    name: string;
    active_ingredient: string | null;
    dosage: string | null;
    form: string | null;
    instructions: string | null;
    prescriber: string | null;
    reason: string | null;
    with_food: string | null;
    start_date: string | null;
    end_date: string | null;
    active: boolean;
    prn: boolean;
    plan_group?: string | null;
    schedules: PlanScheduleInput[];
}

export type PlanHint =
    | { kind: 'from'; date: string }
    | { kind: 'until'; date: string }
    | { kind: 'prescriber'; name: string }
    | { kind: 'time'; time: string }
    | { kind: 'days'; days: number[]; moment: Moment; time: string; time_fixed: boolean; only: boolean }
    | { kind: 'withFood'; value: string }
    | { kind: 'instructions'; text: string };

export interface PlanRow {
    id: string;
    active_ingredient: string | null;
    name: string;
    dosage: string | null;
    form: string | null;
    /** Menge je Tageszeit, bei Bedarf null (Spalten leer) */
    doses: Record<Moment, number> | null;
    unit: string | null;
    hints: PlanHint[];
    reason: string | null;
}

export interface PlanSection {
    group: PlanGroup;
    rows: PlanRow[];
}

/** Gruppe: bei Bedarf immer Bedarfsmedikation, sonst das Feld (Standard Dauermedikation). */
export const planGroupOf = (med: Pick<PlanMedicationInput, 'prn' | 'plan_group'>): PlanGroup =>
    med.prn ? 'prn' : med.plan_group === 'special' ? 'special' : 'regular';

/** Im Plan am Druckdatum: aktiv und nicht beendet (gueltige und kuenftige). */
export const inPlanOn = (med: PlanMedicationInput, day: string): boolean =>
    med.active !== false && !medicationEndedBefore(med, day);

const roundDose = (value: number) => Math.round(value * 100) / 100;

/** Mengen je Tageszeit; mehrere Zeilen einer Tageszeit werden zusammengezaehlt. */
export const dosesOf = (med: PlanMedicationInput): Record<Moment, number> | null => {
    if (med.prn) return null;
    const doses: Record<Moment, number> = { morning: 0, noon: 0, evening: 0, night: 0 };
    for (const s of med.schedules) {
        const quantity = Number(s.quantity);
        if (!Number.isFinite(quantity)) continue;
        const moment = momentOf(s.time_of_day);
        doses[moment] = roundDose(doses[moment] + quantity);
    }
    return doses;
};

/**
 * Hinweise in fester Reihenfolge: ab Datum, bis Datum (wenn eingetragen, auch bei laufenden
 * Medikamenten), Verordnet von, feste Uhrzeit, Wochentage, Mahlzeiten, Hinweise.
 */
export const hintsOf = (med: PlanMedicationInput, _day: string): PlanHint[] => {
    const hints: PlanHint[] = [];
    if (med.start_date) hints.push({ kind: 'from', date: med.start_date.slice(0, 10) });
    if (med.end_date) hints.push({ kind: 'until', date: med.end_date.slice(0, 10) });
    if (med.prescriber?.trim()) hints.push({ kind: 'prescriber', name: med.prescriber.trim() });
    const schedules = med.prn ? [] : [...med.schedules].sort((a, b) => a.time_of_day.localeCompare(b.time_of_day));
    for (const s of schedules) {
        if (s.time_fixed !== false) hints.push({ kind: 'time', time: s.time_of_day.slice(0, 5) });
    }
    for (const s of schedules) {
        if (!scheduleIsDaily(s)) {
            hints.push({
                kind: 'days',
                days: [...(s.days_of_week ?? [])].sort((a, b) => a - b),
                moment: momentOf(s.time_of_day),
                time: s.time_of_day.slice(0, 5),
                time_fixed: s.time_fixed !== false,
                only: schedules.length === 1,
            });
        }
    }
    if (med.with_food && med.with_food !== 'any') hints.push({ kind: 'withFood', value: med.with_food });
    if (med.instructions?.trim()) hints.push({ kind: 'instructions', text: med.instructions.trim() });
    return hints;
};

/** Einheit der Einnahmen: die erste angegebene, sonst leer (der Client nimmt dann die Form). */
export const unitOf = (med: PlanMedicationInput): string | null =>
    med.prn ? null : [...med.schedules].sort((a, b) => a.time_of_day.localeCompare(b.time_of_day)).find((s) => s.unit)?.unit ?? null;

/** Der Plan am Druckdatum: drei Gruppen in fester Reihenfolge, innerhalb nach Name. */
export const buildMedicationPlan = (medications: readonly PlanMedicationInput[], day: string): PlanSection[] => {
    const sections: PlanSection[] = (['regular', 'special', 'prn'] as PlanGroup[]).map((group) => ({ group, rows: [] }));
    const sorted = [...medications].sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
    for (const med of sorted) {
        if (!inPlanOn(med, day)) continue;
        sections.find((s) => s.group === planGroupOf(med))!.rows.push({
            id: med.id,
            active_ingredient: med.active_ingredient,
            name: med.name,
            dosage: med.dosage,
            form: med.form,
            doses: dosesOf(med),
            unit: unitOf(med),
            hints: hintsOf(med, day),
            reason: med.reason,
        });
    }
    return sections;
};

/** Erster Tag der Seite "Aenderungen": 14 Tage vor dem Druckdatum, ab 00:00 Uhr. */
export const historyFrom = (day: string): string => addDays(day, -PLAN_HISTORY_DAYS);

/** Eintraege der letzten 14 Tage (changed_at naiv lokal), neueste zuerst. */
export const recentHistory = <T extends { changed_at: string }>(entries: readonly T[], day: string): T[] => {
    const from = historyFrom(day);
    const until = addDays(day, 1);
    return entries
        .filter((e) => e.changed_at.slice(0, 10) >= from && e.changed_at.slice(0, 10) < until)
        .sort((a, b) => b.changed_at.localeCompare(a.changed_at));
};
