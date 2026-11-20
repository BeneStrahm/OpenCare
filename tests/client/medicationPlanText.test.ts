import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { TFunction } from 'i18next';
import { doseText, hintsText, shortDate, unitText } from '../../client/src/lib/medicationPlanText';
import { duplicateMedForm } from '../../client/src/lib/medications';

/** E54: Texte des gedruckten Plans, mit den echten deutschen Texten. E56: Duplizieren. */

const root = path.resolve(__dirname, '../..');
const read = (ns: string) => JSON.parse(fs.readFileSync(path.join(root, `client/src/i18n/locales/de/${ns}.json`), 'utf8'));
const NS: Record<string, Record<string, unknown>> = { medications: read('medications'), common: read('common') };

const t = ((key: string, options: Record<string, unknown> = {}) => {
    const [ns, rest] = key.includes(':') ? key.split(':') : ['medications', key];
    let value: unknown = NS[ns];
    for (const part of rest.split('.')) value = (value as Record<string, unknown> | undefined)?.[part];
    if (value === undefined && typeof (NS[ns] as Record<string, unknown>) === 'object') {
        const base = rest.split('.');
        const last = base.pop()!;
        const parent = base.reduce<unknown>((v, p) => (v as Record<string, unknown>)?.[p], NS[ns]) as Record<string, unknown>;
        value = parent?.[`${last}_${options.count === 1 ? 'one' : 'other'}`];
    }
    if (options.returnObjects) return value;
    if (typeof value !== 'string') return String(options.defaultValue ?? key);
    return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''));
}) as unknown as TFunction;

describe('Mengen in den Spalten', () => {
    it('ganze Zahlen, 0 und Bruchteile wie im BMP', () => {
        expect(doseText(0)).toBe('0');
        expect(doseText(2)).toBe('2');
        expect(doseText(0.5)).toBe('½');
        expect(doseText(1.5)).toBe('1½');
        expect(doseText(0.25)).toBe('¼');
        expect(doseText(0.75)).toBe('¾');
        expect(doseText(0.3)).toBe('0,3');
    });
});

describe('Hinweistexte', () => {
    it('ab Datum, Verordnet von, Uhrzeit, Wochentage, Mahlzeiten, Ausschleichplan', () => {
        const text = hintsText(t, [
            { kind: 'from', date: '2026-11-25' },
            { kind: 'until', date: '2026-12-01' },
            { kind: 'prescriber', name: 'Dr. Paula Beispiel' },
            { kind: 'time', time: '21:30' },
            { kind: 'days', days: [5, 1, 3], moment: 'evening', time: '21:30', time_fixed: true, only: true },
            { kind: 'instructions', text: 'Ausschleichplan 01.12.–03.12.: 2-0-0-0; 04.12.–06.12.: 1-0-0-0' },
        ], 'monday');
        expect(text).toBe('ab 25.11.2026; bis 01.12.2026; Verordnet von Dr. Paula Beispiel; um 21:30; Mo, Mi, Fr; Ausschleichplan 01.12.–03.12.: 2-0-0-0; 04.12.–06.12.: 1-0-0-0');
    });

    it('Wochentage bei mehreren Zeilen mit Tageszeit davor', () => {
        const text = hintsText(t, [{ kind: 'days', days: [2, 4], moment: 'evening', time: '18:00', time_fixed: false, only: false }], 'monday');
        expect(text).toBe(`${t('medications:moments.evening')}: Di, Do`);
    });

    it('Mahlzeiten mit den Texten der App', () => {
        expect(hintsText(t, [{ kind: 'withFood', value: 'with' }], 'monday')).toBe(t('medications:withFood.with'));
    });

    it('Datum und Einheit', () => {
        expect(shortDate('1941-03-12')).toBe('12.03.1941');
        expect(unitText(t, 'tablet', 'tablet')).toBe('Tablette');
        expect(unitText(t, null, 'syrup')).toBe('ml');
        expect(unitText(t, null, null)).toBe('');
    });
});

describe('Duplizieren (E56)', () => {
    it('Kopie hat alle Angaben und Einnahmezeiten, aber keine Kennungen der Einnahmezeiten', () => {
        const form = {
            name: 'Ramipril', dosage: '5 mg', instructions: 'morgens', plan_group: 'special', start_date: '2026-11-01',
            schedules: [{ id: 's1', time_of_day: '08:00', quantity: '1', days_of_week: [1, 3, 5] }],
        };
        const copy = duplicateMedForm(form);
        expect(copy).toEqual({ ...form, schedules: [{ time_of_day: '08:00', quantity: '1', days_of_week: [1, 3, 5] }] });
        expect(form.schedules[0].id).toBe('s1');
    });
});
