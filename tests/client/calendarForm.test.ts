import { describe, it, expect } from 'vitest';
import { NEW_EVENT_DEFAULTS, addParticipant, hasExtraDetails, longDatePattern, shiftClock, stepTravel } from '../../client/src/lib/calendarForm';
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

describe('Fahrt und Teilnehmende', () => {
    it('Fahrzeit in 15-Minuten-Schritten zwischen 15 und 240 Minuten', () => {
        expect(stepTravel(30, 1)).toBe(45);
        expect(stepTravel(30, -1)).toBe(15);
        expect(stepTravel(15, -1)).toBe(15);
        expect(stepTravel(240, 1)).toBe(240);
    });
    it('verschiebt Uhrzeiten, auch über Mitternacht', () => {
        expect(shiftClock('10:00', -30)).toBe('09:30');
        expect(shiftClock('23:45', 30)).toBe('00:15');
        expect(shiftClock('00:10', -15)).toBe('23:55');
    });
    it('wählt Mitglieder über den Namen, sonst freier Name, ohne Doppelte', () => {
        const members = [{ id: 'm1', name: 'Ida' }];
        const empty = { member_ids: [] as string[], guests: [] as string[] };
        expect(addParticipant(empty, ' ida ', members)).toEqual({ member_ids: ['m1'], guests: [] });
        const withGuest = addParticipant(empty, 'Herr  Meier', members);
        expect(withGuest).toEqual({ member_ids: [], guests: ['Herr Meier'] });
        expect(addParticipant(withGuest, 'herr meier', members)).toBe(withGuest);
        expect(addParticipant(empty, '   ', members)).toBe(empty);
    });
});
