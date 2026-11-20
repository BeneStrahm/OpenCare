import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import {
    PLAN_PRINT_ROLES, buildMedicationPlan, dosesOf, hintsOf, historyFrom, inPlanOn, planGroupOf, recentHistory,
    type PlanMedicationInput,
} from '../../server/src/lib/medicationPlan';
import { CIRCLE_ROLES, recipientMayAccess, requireRole, type CircleRequest, type CircleRole } from '../../server/src/middleware/circle';

/** E54, E55: Medikamentenplan zum Drucken (Logik, nicht das Layout). Nur fiktive Daten. */

const DAY = '2026-11-20';
const DAILY = [1, 2, 3, 4, 5, 6, 7];
const med = (extra: Partial<PlanMedicationInput> = {}): PlanMedicationInput => ({
    id: 'm1', name: 'Metformin', active_ingredient: 'Metforminhydrochlorid', dosage: '500 mg', form: 'tablet',
    instructions: null, prescriber: null, reason: 'Diabetes', with_food: null, start_date: null, end_date: null,
    active: true, prn: false, plan_group: 'regular',
    schedules: [
        { time_of_day: '08:00', days_of_week: DAILY, quantity: '1.00', unit: 'tablet', time_fixed: false },
        { time_of_day: '18:00', days_of_week: DAILY, quantity: '1.00', unit: 'tablet', time_fixed: false },
    ],
    ...extra,
});

describe('Gruppen', () => {
    it('Standard Dauermedikation, von Hand zu besonderen Zeiten, bei Bedarf immer Bedarf', () => {
        expect(planGroupOf({ prn: false, plan_group: 'regular' })).toBe('regular');
        expect(planGroupOf({ prn: false, plan_group: null })).toBe('regular');
        expect(planGroupOf({ prn: false, plan_group: 'special' })).toBe('special');
        expect(planGroupOf({ prn: true, plan_group: 'special' })).toBe('prn');
    });

    it('kein automatischer Vorschlag: nicht taeglich und befristet bleibt Dauermedikation', () => {
        const m = med({ end_date: '2026-11-30', schedules: [{ time_of_day: '21:30', days_of_week: [1, 3, 5], quantity: 1, unit: null, time_fixed: true }] });
        expect(planGroupOf(m)).toBe('regular');
    });

    it('drei Gruppen in fester Reihenfolge, innerhalb nach Name', () => {
        const plan = buildMedicationPlan([
            med({ id: 'p', name: 'Paracetamol', prn: true, schedules: [] }),
            med({ id: 'z', name: 'Torasemid', plan_group: 'special' }),
            med({ id: 'r', name: 'Ramipril' }),
            med({ id: 'a', name: 'ASS' }),
        ], DAY);
        expect(plan.map((s) => [s.group, s.rows.map((r) => r.id)])).toEqual([
            ['regular', ['a', 'r']], ['special', ['z']], ['prn', ['p']],
        ]);
    });
});

describe('Spalten Mo, Mi, Ab, zN', () => {
    it('Tageszeit nach Uhrzeit, leere Tageszeit 0 (1-0-1-0)', () => {
        expect(dosesOf(med())).toEqual({ morning: 1, noon: 0, evening: 1, night: 0 });
    });

    it('Grenzen wie im Plan: 05:00 Mo, 11:00 Mi, 17:00 Ab, 22:00 und 04:59 zN', () => {
        const at = (time: string) => dosesOf(med({ schedules: [{ time_of_day: time, days_of_week: DAILY, quantity: 1, unit: null, time_fixed: true }] }));
        expect(at('05:00')).toMatchObject({ morning: 1 });
        expect(at('11:00')).toMatchObject({ noon: 1 });
        expect(at('17:00')).toMatchObject({ evening: 1 });
        expect(at('21:30')).toMatchObject({ evening: 1 });
        expect(at('22:00')).toMatchObject({ night: 1 });
        expect(at('04:59')).toMatchObject({ night: 1 });
    });

    it('zwei Zeilen einer Tageszeit werden zusammengezaehlt, halbe Tabletten bleiben', () => {
        const m = med({ schedules: [
            { time_of_day: '07:00', days_of_week: DAILY, quantity: '0.50', unit: null, time_fixed: true },
            { time_of_day: '09:00', days_of_week: DAILY, quantity: '1.00', unit: null, time_fixed: true },
        ] });
        expect(dosesOf(m)).toEqual({ morning: 1.5, noon: 0, evening: 0, night: 0 });
    });

    it('bei Bedarf: Spalten leer', () => {
        expect(dosesOf(med({ prn: true, schedules: [] }))).toBeNull();
    });
});

describe('Hinweise', () => {
    it('Reihenfolge: ab, bis, Verordnet von, Uhrzeit, Wochentage, Mahlzeiten, Hinweise', () => {
        const m = med({
            start_date: '2026-11-25', end_date: '2026-12-01', prescriber: ' Dr. Paula Beispiel ', with_food: 'with',
            instructions: 'Ausschleichplan 01.12.–03.12.: 2-0-0-0; 04.12.–06.12.: 1-0-0-0',
            schedules: [{ time_of_day: '21:30', days_of_week: [5, 1, 3], quantity: 1, unit: null, time_fixed: true }],
        });
        expect(hintsOf(m, DAY)).toEqual([
            { kind: 'from', date: '2026-11-25' },
            { kind: 'until', date: '2026-12-01' },
            { kind: 'prescriber', name: 'Dr. Paula Beispiel' },
            { kind: 'time', time: '21:30' },
            { kind: 'days', days: [1, 3, 5], moment: 'evening', time: '21:30', time_fixed: true, only: true },
            { kind: 'withFood', value: 'with' },
            { kind: 'instructions', text: 'Ausschleichplan 01.12.–03.12.: 2-0-0-0; 04.12.–06.12.: 1-0-0-0' },
        ]);
    });

    it('Tageszeit ohne feste Uhrzeit, taeglich, egal wann gegessen: keine Hinweise', () => {
        expect(hintsOf(med({ with_food: 'any' }), DAY)).toEqual([]);
    });

    it('ab und bis auch bei laufenden Medikamenten, nur was eingetragen ist', () => {
        expect(hintsOf(med({ start_date: '2026-11-01' }), DAY)).toEqual([{ kind: 'from', date: '2026-11-01' }]);
        expect(hintsOf(med({ end_date: '2026-11-30T00:00:00' }), DAY)).toEqual([{ kind: 'until', date: '2026-11-30' }]);
        expect(hintsOf(med(), DAY)).toEqual([]);
    });

    it('Wochentage bei mehreren Zeilen mit Tageszeit', () => {
        const m = med({ schedules: [
            { time_of_day: '08:00', days_of_week: DAILY, quantity: 1, unit: null, time_fixed: false },
            { time_of_day: '18:00', days_of_week: [2, 4], quantity: 1, unit: null, time_fixed: false },
        ] });
        expect(hintsOf(m, DAY)).toEqual([{ kind: 'days', days: [2, 4], moment: 'evening', time: '18:00', time_fixed: false, only: false }]);
    });
});

describe('Umfang am Druckdatum', () => {
    it('gueltig und kuenftig ja, beendet und archiviert nein, letzter Tag zaehlt noch', () => {
        expect(inPlanOn(med(), DAY)).toBe(true);
        expect(inPlanOn(med({ start_date: '2026-11-25' }), DAY)).toBe(true);
        expect(inPlanOn(med({ end_date: DAY }), DAY)).toBe(true);
        expect(inPlanOn(med({ end_date: '2026-11-17' }), DAY)).toBe(false);
        expect(inPlanOn(med({ active: false }), DAY)).toBe(false);
    });

    it('beendete stehen nicht im Plan', () => {
        const plan = buildMedicationPlan([med({ id: 'alt', end_date: '2026-11-17' }), med({ id: 'neu', start_date: '2026-11-25' })], DAY);
        expect(plan.flatMap((s) => s.rows.map((r) => r.id))).toEqual(['neu']);
    });
});

describe('Aenderungen der letzten 14 Tage', () => {
    const entry = (changed_at: string) => ({ id: changed_at, changed_at });

    it('ab 00:00 Uhr 14 Tage vor dem Druckdatum, neueste zuerst', () => {
        expect(historyFrom(DAY)).toBe('2026-11-06');
        const kept = recentHistory([
            entry('2026-11-05T23:59:59'), entry('2026-11-06T00:00:00'), entry('2026-11-15T10:00:00'), entry('2026-10-31T10:00:00'),
            entry('2026-11-20T20:00:00'),
        ], DAY);
        expect(kept.map((e) => e.id)).toEqual(['2026-11-20T20:00:00', '2026-11-15T10:00:00', '2026-11-06T00:00:00']);
    });

    it('Aenderung vor 5 Tagen ja, vor 20 Tagen nein (Szenario 5)', () => {
        const kept = recentHistory([entry('2026-11-15T09:00:00'), entry('2026-10-31T09:00:00')], DAY);
        expect(kept.map((e) => e.id)).toEqual(['2026-11-15T09:00:00']);
    });
});

describe('Rechte', () => {
    const guard = (role: CircleRole) => {
        let status = 200;
        let passed = false;
        const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
        requireRole(...PLAN_PRINT_ROLES)({ circleRole: role } as CircleRequest, res, () => { passed = true; });
        return { status, passed };
    };

    it('admin, family und professional duerfen drucken', () => {
        for (const role of ['admin', 'family', 'professional'] as CircleRole[]) expect(guard(role), role).toEqual({ status: 200, passed: true });
    });

    it('neighbor und recipient nicht (403), recipient auch nicht ueber die Freigabeliste', () => {
        expect(guard('neighbor')).toEqual({ status: 403, passed: false });
        expect(guard('recipient')).toEqual({ status: 403, passed: false });
        expect(recipientMayAccess('GET', '/api/medications/plan')).toBe(false);
        expect(CIRCLE_ROLES).toHaveLength(5);
    });
});
