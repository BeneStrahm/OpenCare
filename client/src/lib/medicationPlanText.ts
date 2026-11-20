import type { TFunction } from 'i18next';
import { unitFor } from './medications';
import { sortIsoDays, type WeekStart } from './weekStart';

/**
 * Texte des gedruckten Medikamentenplans (E54). Die Angaben berechnet der Server
 * (server/src/lib/medicationPlan.ts), hier werden sie nur in Worte gefasst.
 */

export type PlanMoment = 'morning' | 'noon' | 'evening' | 'night';
export const PLAN_MOMENTS: PlanMoment[] = ['morning', 'noon', 'evening', 'night'];

export type PlanHint =
    | { kind: 'from'; date: string }
    | { kind: 'until'; date: string }
    | { kind: 'prescriber'; name: string }
    | { kind: 'time'; time: string }
    | { kind: 'days'; days: number[]; moment: PlanMoment; time: string; time_fixed: boolean; only: boolean }
    | { kind: 'withFood'; value: string }
    | { kind: 'instructions'; text: string };

export interface PlanRow {
    id: string;
    active_ingredient: string | null;
    name: string;
    dosage: string | null;
    form: string | null;
    doses: Record<PlanMoment, number> | null;
    unit: string | null;
    hints: PlanHint[];
    reason: string | null;
}

export interface PlanSection {
    group: 'regular' | 'special' | 'prn';
    rows: PlanRow[];
}

const FRACTIONS: Record<string, string> = { '0.25': '¼', '0.5': '½', '0.75': '¾' };

/** Menge in einer Spalte Mo/Mi/Ab/zN: 0, 1, ½, 1½, 0,3 (Dezimalkomma je nach Sprache). */
export const doseText = (value: number, locale = 'de-DE'): string => {
    const whole = Math.floor(value);
    const rest = Math.round((value - whole) * 100) / 100;
    const fraction = FRACTIONS[String(rest)];
    if (fraction) return whole > 0 ? `${whole}${fraction}` : fraction;
    return value.toLocaleString(locale, { maximumFractionDigits: 2 });
};

/** "TT.MM.JJJJ" aus "JJJJ-MM-TT". */
export const shortDate = (day: string): string => {
    const [y, m, d] = day.slice(0, 10).split('-');
    return `${d}.${m}.${y}`;
};

/** Ein Hinweis in Worten. */
export const hintText = (t: TFunction, hint: PlanHint, weekStart: WeekStart): string => {
    switch (hint.kind) {
        case 'from':
            return t('medications:print.hints.from', { date: shortDate(hint.date) });
        case 'until':
            return t('medications:print.hints.until', { date: shortDate(hint.date) });
        case 'prescriber':
            return t('medications:print.hints.prescriber', { name: hint.name });
        case 'time':
            return t('medications:print.hints.time', { time: hint.time });
        case 'days': {
            const daysShort = t('common:daysShort', { returnObjects: true }) as unknown as string[];
            const days = sortIsoDays(hint.days, weekStart).map((d) => daysShort[d - 1]).join(', ');
            if (hint.only) return days;
            const when = hint.time_fixed
                ? t('medications:print.hints.time', { time: hint.time })
                : t(`medications:moments.${hint.moment}`);
            return `${when}: ${days}`;
        }
        case 'withFood':
            return t(`medications:withFood.${hint.value}`, { defaultValue: hint.value });
        case 'instructions':
            return hint.text;
    }
};

/** Alle Hinweise einer Zeile, getrennt mit Semikolon. */
export const hintsText = (t: TFunction, hints: readonly PlanHint[], weekStart: WeekStart): string =>
    hints.map((hint) => hintText(t, hint, weekStart)).filter(Boolean).join('; ');

/** Einheit in Worten (Texte der App, Einzahl): aus der Einnahmezeit, sonst aus der Form. */
export const unitText = (t: TFunction, unit: string | null, form: string | null): string => {
    if (!unit && !form) return '';
    const key = unitFor(unit, form);
    return t(`medications:units.${key}`, { count: 1, defaultValue: key });
};
