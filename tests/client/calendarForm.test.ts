import { describe, it, expect } from 'vitest';
import { NEW_EVENT_DEFAULTS, hasExtraDetails, longDatePattern } from '../../client/src/lib/calendarForm';
import { format } from 'date-fns';
import { de, enUS } from 'date-fns/locale';

const base = {
    endTime: '', location: '', member_ids: [] as string[], notes: '',
    reminder_30min: false, reminder_1hour: true, recurrence: { freq: '' },
};

describe('Terminformular', () => {
    it('neue Termine: kein Ende, Erinnerung 1 Stunde vorher an, 30 Minuten aus', () => {
        expect(NEW_EVENT_DEFAULTS).toEqual({ endTime: '', reminder_30min: false, reminder_1hour: true });
    });
    it('ein Termin nur mit Grundfeldern hat keine weiteren Angaben', () => {
        expect(hasExtraDetails(base)).toBe(false);
    });
    it('erkennt jede weitere Angabe', () => {
        expect(hasExtraDetails({ ...base, endTime: '10:00' })).toBe(true);
        expect(hasExtraDetails({ ...base, location: 'Praxis' })).toBe(true);
        expect(hasExtraDetails({ ...base, location: '   ' })).toBe(false);
        expect(hasExtraDetails({ ...base, member_ids: ['x'] })).toBe(true);
        expect(hasExtraDetails({ ...base, notes: 'Karte mitnehmen' })).toBe(true);
        expect(hasExtraDetails({ ...base, reminder_30min: true })).toBe(true);
        expect(hasExtraDetails({ ...base, reminder_1hour: false })).toBe(true);
        expect(hasExtraDetails({ ...base, recurrence: { freq: 'WEEKLY' } })).toBe(true);
    });
});

describe('Datumsformat', () => {
    const d = new Date(2026, 10, 20);
    it('Deutsch mit Komma und Punkt', () => {
        expect(format(d, longDatePattern('de', true), { locale: de })).toBe('Freitag, 20. November 2026');
        expect(format(d, longDatePattern('de-DE', false), { locale: de })).toBe('Freitag, 20. November');
    });
    it('Englisch', () => {
        expect(format(d, longDatePattern('en', true), { locale: enUS })).toBe('Friday, November 20, 2026');
    });
    it('Franzoesisch bleibt wie bisher', () => {
        expect(longDatePattern('fr', true)).toBe('EEEE d MMMM yyyy');
    });
});
