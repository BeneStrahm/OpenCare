import { describe, it, expect } from 'vitest';
import { plannedIntakes, schedulesToReopen, naiveTimestamp, type PlanSchedule } from '../../server/src/lib/intakes';

/**
 * E51 (Roadmap Punkt 2): Fehler bei neu angelegten Medikamenten, in der reinen Funktion
 * plannedIntakes (generateIntakes legt genau diese Einnahmen an) und schedulesToReopen.
 */

const DAILY = [1, 2, 3, 4, 5, 6, 7];
const TODAY = '2026-11-20';
const med = { id: 'm1', active: true, prn: false, start_date: null, end_date: null };
const sched = (extra: Partial<PlanSchedule> = {}): PlanSchedule => ({
    id: 's1', medication_id: 'm1', time_of_day: '08:00', days_of_week: DAILY, quantity: 1, unit: 'tablet',
    created_at: '2026-11-01T10:00:00', ...extra,
});

describe('Keine Einnahme vor dem Anlegen', () => {
    it('abends angelegt mit Morgens: heute keine Einnahme um 08:00, ab morgen schon', () => {
        const planned = plannedIntakes([med], [sched({ created_at: `${TODAY}T19:00:00` })], [], TODAY, '2026-11-21');
        expect(planned.map((p) => p.due_at)).toEqual(['2026-11-21T08:00:00']);
    });

    it('abends angelegt mit fester Abend-Uhrzeit 21:30: erscheint heute', () => {
        const planned = plannedIntakes([med], [sched({ time_of_day: '21:30', created_at: `${TODAY}T19:00:00` })], [], TODAY, TODAY);
        expect(planned.map((p) => p.due_at)).toEqual([`${TODAY}T21:30:00`]);
    });

    it('angelegt genau zur Einnahmezeit: zaehlt noch', () => {
        const planned = plannedIntakes([med], [sched({ created_at: `${TODAY}T08:00:00` })], [], TODAY, TODAY);
        expect(planned).toHaveLength(1);
    });

    it('alte Einnahmezeit ohne Anlegezeit: wie bisher', () => {
        expect(plannedIntakes([med], [sched({ created_at: null })], [], TODAY, TODAY)).toHaveLength(1);
    });
});

describe('Hoechstens eine Einnahme pro Einnahmezeit und Tag (E31)', () => {
    it('schon genommen um 08:00, Uhrzeit auf 21:30 geaendert: heute keine zweite', () => {
        const existing = [{ medication_id: 'm1', schedule_id: 's1', due_at: `${TODAY}T08:00:00` }];
        const planned = plannedIntakes([med], [sched({ time_of_day: '21:30' })], existing, TODAY, '2026-11-21');
        expect(planned.map((p) => p.due_at)).toEqual(['2026-11-21T21:30:00']);
    });

    it('alte bestaetigte Einnahme ohne Einnahmezeit zur selben Uhrzeit: keine neue', () => {
        const existing = [{ medication_id: 'm1', schedule_id: null, due_at: `${TODAY} 08:00:00` }];
        expect(plannedIntakes([med], [sched()], existing, TODAY, TODAY)).toEqual([]);
    });

    it('Menge und Einheit kommen aus der Einnahmezeit', () => {
        const [p] = plannedIntakes([med], [sched({ quantity: '2.00', unit: 'drop' })], [], TODAY, TODAY);
        expect(p).toMatchObject({ medication_id: 'm1', schedule_id: 's1', quantity: '2.00', unit: 'drop' });
    });
});

describe('Uhrzeit aendern oeffnet eine verpasste Einnahme wieder', () => {
    it('nur Zeilen mit geaenderter Uhrzeit', () => {
        const before = [{ id: 's1', time_of_day: '08:00' }, { id: 's2', time_of_day: '18:00' }];
        const after = [{ id: 's1', time_of_day: '21:30' }, { id: 's2', time_of_day: '18:00' }, { id: 'neu', time_of_day: '12:00' }];
        expect(schedulesToReopen(before, after).map((s) => s.id)).toEqual(['s1']);
    });

    it('nach dem Wiederoeffnen (verpasste entfaellt) entsteht sie heute mit der neuen Uhrzeit', () => {
        // Die verpasste 08:00-Einnahme ist beim Speichern geloescht, also nicht mehr vorhanden.
        const planned = plannedIntakes([med], [sched({ time_of_day: '21:30' })], [], TODAY, TODAY);
        expect(planned.map((p) => p.due_at)).toEqual([`${TODAY}T21:30:00`]);
    });

    it('Sekunden in der Uhrzeit zaehlen nicht als Aenderung', () => {
        expect(schedulesToReopen([{ id: 's1', time_of_day: '08:00:00' }], [{ id: 's1', time_of_day: '08:00' }])).toEqual([]);
    });
});

describe('Geloeschte und neu angelegte Zeile', () => {
    it('es entsteht keine 08:00-Einnahme mehr, die verwaist stehen bleiben koennte', () => {
        // Abends angelegt mit Morgens: keine Einnahme. Zeile geloescht, neue Zeile 21:30: nur 21:30.
        const first = plannedIntakes([med], [sched({ id: 'alt', created_at: `${TODAY}T19:00:00` })], [], TODAY, TODAY);
        expect(first).toEqual([]);
        const second = plannedIntakes([med], [sched({ id: 'neu', time_of_day: '21:30', created_at: `${TODAY}T19:05:00` })], [], TODAY, TODAY);
        expect(second.map((p) => `${p.schedule_id} ${p.due_at}`)).toEqual([`neu ${TODAY}T21:30:00`]);
    });
});

describe('Zeitraum, Wochentage, Bei Bedarf (Regel aus E52)', () => {
    it('Ende inklusive, kuenftiger Beginn, archiviert und bei Bedarf', () => {
        const meds = [
            { ...med, id: 'ende', end_date: TODAY },
            { ...med, id: 'kuenftig', start_date: '2026-11-25' },
            { ...med, id: 'archiv', active: false },
            { ...med, id: 'bedarf', prn: true },
        ];
        const schedules = meds.map((m) => sched({ id: `s-${m.id}`, medication_id: m.id }));
        const planned = plannedIntakes(meds, schedules, [], TODAY, '2026-11-21');
        expect(planned.map((p) => `${p.medication_id} ${p.due_at}`)).toEqual([`ende ${TODAY}T08:00:00`]);
    });

    it('nur Mo, Mi, Fr', () => {
        const planned = plannedIntakes([med], [sched({ days_of_week: [1, 3, 5] })], [], '2026-11-16', '2026-11-22');
        expect(planned.map((p) => p.due_at.slice(0, 10))).toEqual(['2026-11-16', '2026-11-18', '2026-11-20']);
    });
});

describe('naiveTimestamp', () => {
    it('vereinheitlicht die Schreibweisen', () => {
        expect(naiveTimestamp('2026-11-20 08:00:00.123')).toBe('2026-11-20T08:00:00');
        expect(naiveTimestamp('2026-11-20T08:00')).toBe('2026-11-20T08:00:00');
    });
});
