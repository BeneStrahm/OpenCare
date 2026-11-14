import { describe, it, expect } from 'vitest';
import { diffMedication } from '../../server/src/lib/medicationHistory';

const schedule = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    time_of_day: '08:00',
    days_of_week: [1, 2, 3, 4, 5, 6, 7],
    label: null,
    time_fixed: false,
    quantity: '1.00',
    unit: null,
    view_color: null,
    ...extra,
});

const base = {
    name: 'Testmittel',
    dosage: '5 mg',
    form: 'tablet',
    prn: false,
    active: true,
    photo_url: null,
    schedules: [schedule('a')],
};

describe('Änderungshistorie Medikamentenplan', () => {
    it('erfasst beim Anlegen nur gefüllte Angaben und die Einnahmezeiten', () => {
        const changes = diffMedication(null, base);
        expect(changes.map((c) => c.field)).toEqual(['name', 'dosage', 'form', 'schedule']);
        expect(changes[3]).toMatchObject({ old: null, new: { time_of_day: '08:00', quantity: 1 } });
    });

    it('meldet ohne Änderung nichts (Menge als Text oder Zahl)', () => {
        const after = { ...base, schedules: [schedule('a', { quantity: 1 })] };
        expect(diffMedication(base, after)).toEqual([]);
    });

    it('erfasst geänderte Felder, Archivieren, Foto und Einnahmezeiten alt und neu', () => {
        const after = {
            ...base,
            dosage: '2,5 mg',
            active: false,
            photo_url: 'data:image/png;base64,AAAA',
            schedules: [schedule('a', { quantity: '0.50' }), schedule('b', { time_of_day: '18:00' })],
        };
        const changes = diffMedication(base, after);
        expect(changes).toContainEqual({ field: 'dosage', old: '5 mg', new: '2,5 mg' });
        expect(changes).toContainEqual({ field: 'active', old: true, new: false });
        expect(changes).toContainEqual({ field: 'photo', old: false, new: true });
        const schedules = changes.filter((c) => c.field === 'schedule');
        expect(schedules).toHaveLength(2);
        expect(schedules[0]).toMatchObject({ old: { quantity: 1 }, new: { quantity: 0.5 } });
        expect(schedules[1]).toMatchObject({ old: null, new: { time_of_day: '18:00' } });
    });

    it('erfasst entfernte Einnahmezeiten', () => {
        const changes = diffMedication(base, { ...base, schedules: [] });
        expect(changes).toEqual([{ field: 'schedule', old: expect.objectContaining({ time_of_day: '08:00' }), new: null }]);
    });
});
