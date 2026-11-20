import { describe, it, expect } from 'vitest';
import {
    addDays, daysBetween, isoWeekday, medicationValidOn, medicationEndedBefore, medicationStartsAfter,
    scheduleAppliesOn, scheduleIsDaily,
} from '../../server/src/lib/scheduleRule';

/**
 * E52: eine Regel "gilt diese Einnahmezeit an Tag X?". Die Faelle folgen den Dosier- und
 * Zeitraum-Beispielen der gematik (ePA Medication Service, dgMP-Ueberblick und Render API eMP):
 * taeglich morgens, taeglich um 08:00, Wochentags-Bezug (Dienstag und Donnerstag),
 * Anwendungszeitraum Start/Ende (effectiveDosePeriod, auch ohne Ende "ongoing").
 * Wiederkehrende Intervalle ("alle 8 Tage") kennt die App nicht.
 */

const DAILY = [1, 2, 3, 4, 5, 6, 7];
const med = (extra: Record<string, unknown> = {}) => ({ active: true, prn: false, start_date: null, end_date: null, ...extra });

describe('Wochentage und Tage', () => {
    it('ISO-Wochentag: Montag 1 bis Sonntag 7', () => {
        expect(isoWeekday('2026-11-16')).toBe(1);
        expect(isoWeekday('2026-11-20')).toBe(5);
        expect(isoWeekday('2026-11-22')).toBe(7);
    });

    it('Tage zaehlen ueber Monats- und Jahresgrenzen und die Zeitumstellung', () => {
        expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
        expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
        expect(daysBetween('2026-03-28', '2026-03-30')).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
        expect(daysBetween('2026-10-24', '2026-10-26')).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
        expect(daysBetween('2026-11-21', '2026-11-20')).toEqual([]);
    });

    it('taeglich heisst alle sieben Tage', () => {
        expect(scheduleIsDaily({ days_of_week: DAILY })).toBe(true);
        expect(scheduleIsDaily({ days_of_week: [1, 3, 5] })).toBe(false);
        expect(scheduleIsDaily({ days_of_week: [] })).toBe(false);
    });
});

describe('Zeitraum des Medikaments (Beginn und Ende inklusive)', () => {
    const m = med({ start_date: '2026-12-01', end_date: '2026-12-03' });

    it('erster und letzter Tag gelten, die Tage davor und danach nicht', () => {
        expect(medicationValidOn(m, '2026-11-30')).toBe(false);
        expect(medicationValidOn(m, '2026-12-01')).toBe(true);
        expect(medicationValidOn(m, '2026-12-03')).toBe(true);
        expect(medicationValidOn(m, '2026-12-04')).toBe(false);
    });

    it('leere Daten: ohne Beginn bzw. ohne Ende offen (gematik: "ongoing")', () => {
        expect(medicationValidOn(med(), '1990-01-01')).toBe(true);
        expect(medicationValidOn(med({ start_date: '2027-02-01' }), '2027-01-31')).toBe(false);
        expect(medicationValidOn(med({ start_date: '2027-02-01' }), '2099-12-31')).toBe(true);
        expect(medicationValidOn(med({ end_date: '2026-11-20' }), '2026-11-20')).toBe(true);
    });

    it('beendet und kuenftig am Stichtag', () => {
        expect(medicationEndedBefore(med({ end_date: '2026-11-19' }), '2026-11-20')).toBe(true);
        expect(medicationEndedBefore(med({ end_date: '2026-11-20' }), '2026-11-20')).toBe(false);
        expect(medicationStartsAfter(med({ start_date: '2026-11-21' }), '2026-11-20')).toBe(true);
        expect(medicationStartsAfter(med({ start_date: '2026-11-20' }), '2026-11-20')).toBe(false);
    });

    it('auch Zeitpunkte statt Tage werden auf den Tag gekuerzt', () => {
        expect(medicationValidOn(med({ end_date: '2026-11-20T00:00:00' }), '2026-11-20')).toBe(true);
    });
});

describe('Einnahmezeit an Tag X', () => {
    it('taeglich morgens (1-0-0-0): jeden Tag', () => {
        for (const day of daysBetween('2026-11-16', '2026-11-22')) {
            expect(scheduleAppliesOn(med(), { days_of_week: DAILY }, day)).toBe(true);
        }
    });

    it('Wochentags-Bezug Dienstag und Donnerstag', () => {
        const s = { days_of_week: [2, 4] };
        const hits = daysBetween('2026-11-16', '2026-11-22').filter((d) => scheduleAppliesOn(med(), s, d));
        expect(hits).toEqual(['2026-11-17', '2026-11-19']);
    });

    it('Mo, Mi, Fr im Zeitraum: nur Tage, die beides erfuellen', () => {
        const m = med({ start_date: '2026-11-18', end_date: '2026-11-23' });
        const hits = daysBetween('2026-11-16', '2026-11-30').filter((d) => scheduleAppliesOn(m, { days_of_week: [1, 3, 5] }, d));
        expect(hits).toEqual(['2026-11-18', '2026-11-20', '2026-11-23']);
    });

    it('leere oder fehlende Wochentage: nie (wie bisher)', () => {
        expect(scheduleAppliesOn(med(), { days_of_week: [] }, '2026-11-20')).toBe(false);
        expect(scheduleAppliesOn(med(), { days_of_week: null }, '2026-11-20')).toBe(false);
    });

    it('archiviert oder bei Bedarf: nie', () => {
        expect(scheduleAppliesOn(med({ active: false }), { days_of_week: DAILY }, '2026-11-20')).toBe(false);
        expect(scheduleAppliesOn(med({ prn: true }), { days_of_week: DAILY }, '2026-11-20')).toBe(false);
    });
});
