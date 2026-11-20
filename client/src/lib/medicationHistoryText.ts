import type { TFunction } from 'i18next';
import { format, parseISO } from 'date-fns';
import { formatAmount, momentOf } from './medications';
import { medicationColorOf } from './viewColors';
import { sortIsoDays, type WeekStart } from './weekStart';
import { dateLocale, formatClock } from '../i18n/format';

/**
 * Texte der Änderungshistorie des Medikamentenplans (E49), gemeinsam für den Reiter
 * "Änderungen" (Medications.tsx) und die Seite "Änderungen der letzten 14 Tage" im Druck (E54).
 * Einträge kommen aus server/src/lib/medicationHistory.ts.
 */

export interface HistorySchedule {
    time_of_day: string;
    time_fixed: boolean;
    days_of_week: number[];
    quantity: number;
    unit: string | null;
    view_color: string | null;
    label: string | null;
}

export interface HistoryChange {
    field: string;
    old: unknown;
    new: unknown;
}

export interface HistoryEntry {
    id: string;
    medication_name: string;
    /** Dosierung zum Zeitpunkt der Änderung (ältere Einträge ohne) */
    medication_dosage?: string | null;
    /** Form des Medikaments (null, wenn gelöscht) */
    medication_form?: string | null;
    action: 'created' | 'updated' | 'deleted';
    changes: HistoryChange[];
    changed_at: string;
    changed_by_name: string | null;
}

/** Name des Medikaments mit Dosierung, z. B. "Ramipril 5 mg". */
export const historyMedicationLabel = (entry: HistoryEntry): string =>
    entry.medication_dosage ? `${entry.medication_name} ${entry.medication_dosage}` : entry.medication_name;

/** Feldname in der Historie -> Beschriftung (vorhandene Texte des Formulars). */
export const HISTORY_FIELD_LABELS: Record<string, string> = {
    name: 'medications:form.name',
    active_ingredient: 'medications:form.activeIngredient',
    dosage: 'medications:form.dosage',
    form: 'medications:form.form',
    instructions: 'medications:form.instructions',
    prescriber: 'medications:form.prescriber',
    start_date: 'medications:form.startDate',
    end_date: 'medications:form.endDate',
    prn: 'medications:form.prn',
    with_food: 'medications:form.withFood',
    reason: 'medications:form.reason',
    appearance: 'medications:form.appearance',
    plan_group: 'medications:form.planGroup',
    photo: 'medications:form.photo',
    active: 'medications:history.fields.active',
    schedule: 'medications:history.fields.schedule',
};

export const historyTexts = (t: TFunction, weekStart: WeekStart) => {
    const daysShort = t('common:daysShort', { returnObjects: true }) as unknown as string[];
    const fmtDate = (value: string) => format(parseISO(value.slice(0, 10)), 'PP', { locale: dateLocale() });
    const formLabel = (value: string) => t(`medications:forms.${value}`, { defaultValue: value });

    const fieldLabel = (field: string) => t(HISTORY_FIELD_LABELS[field] ?? field, { defaultValue: field });

    const scheduleText = (s: HistorySchedule, form: string | null) => {
        const when = s.time_fixed === false
            ? t(`medications:moments.${momentOf(parseInt(s.time_of_day.slice(0, 2), 10))}`)
            : t('medications:history.atTime', { time: formatClock(s.time_of_day) });
        const parts = [`${when}: ${formatAmount(t, s.quantity, s.unit, form)}`];
        if (Array.isArray(s.days_of_week) && s.days_of_week.length < 7) {
            parts.push(sortIsoDays(s.days_of_week, weekStart).map((d) => daysShort[d - 1]).join(', '));
        }
        const color = medicationColorOf(s.view_color);
        if (color) parts.push(t(`medications:form.viewColors.${color.id}`));
        if (s.label) parts.push(s.label);
        return parts.join(' · ');
    };

    const valueText = (field: string, value: unknown, form: string | null): string => {
        if (field === 'active') return value ? t('medications:history.values.active') : t('medications:treatments.archived');
        if (field === 'photo') return value ? t('medications:history.values.photo') : t('medications:history.values.noPhoto');
        if (field === 'prn') return value ? t('medications:history.values.yes') : t('medications:history.values.no');
        if (value === null || value === undefined || value === '') return t('medications:history.values.empty');
        if (field === 'schedule') return scheduleText(value as HistorySchedule, form);
        if (field === 'form') return formLabel(String(value));
        if (field === 'with_food') return t(`medications:withFood.${String(value)}`, { defaultValue: String(value) });
        if (field === 'plan_group') return t(`medications:planGroups.${String(value)}`, { defaultValue: String(value) });
        if (field === 'start_date' || field === 'end_date') return fmtDate(String(value));
        return String(value);
    };

    return { fieldLabel, scheduleText, valueText, fmtDate };
};
