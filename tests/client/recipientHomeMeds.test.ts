import { describe, it, expect } from 'vitest';
import {
    showOnHome, isOverdue, effectiveDue,
    HOME_MEDS_LEAD_MS, HOME_MEDS_OVERDUE_MS, HOME_MEDS_HIDE_AFTER_MS, type HomeIntake,
} from '../../client/src/lib/recipientView';
import { clockDate } from '../../client/src/lib/clock';

/**
 * Block M (E23): Medikamenten-Kachel auf der Startseite der einfachen Ansicht.
 * Wann eine Einnahme erscheint, wann sie den hellroten Rahmen bekommt und wann
 * "Spaeter erinnern" angeboten wird. Fiktive Zeiten, keine echten Daten.
 */

const at = (hm: string) => clockDate(`2026-11-12T${hm}:00`) as Date;
const intake = (extra: Partial<HomeIntake> = {}): HomeIntake => ({
    due_at: '2026-11-12T08:00:00', status: 'pending', time_fixed: false, snooze_count: 0, ...extra,
});

describe('Kachel: wann eine Einnahme erscheint', () => {
    it('ab 30 Minuten vor der Zeit', () => {
        expect(HOME_MEDS_LEAD_MS).toBe(30 * 60 * 1000);
        expect(showOnHome(intake(), at('07:29'), clockDate)).toBe(false);
        expect(showOnHome(intake(), at('07:30'), clockDate)).toBe(true);
    });

    it('bleibt hoechstens 4 Stunden nach der Zeit (Nachholfrist)', () => {
        expect(HOME_MEDS_HIDE_AFTER_MS).toBe(4 * 60 * 60 * 1000);
        expect(showOnHome(intake(), at('11:59'), clockDate)).toBe(true);
        expect(showOnHome(intake(), at('12:00'), clockDate)).toBe(false);
        expect(showOnHome(intake(), at('22:00'), clockDate)).toBe(false);
        // Die Uhr entscheidet, nicht der Status vom Server
        expect(showOnHome(intake({ status: 'missed' }), at('09:00'), clockDate)).toBe(true);
        expect(showOnHome(intake({ status: 'missed' }), at('12:00'), clockDate)).toBe(false);
    });

    it('nach Spaeter erinnern laeuft die Frist ab der neuen Zeit', () => {
        const snoozed = intake({ snoozed_until: '2026-11-12T09:00:00', snooze_count: 2 });
        expect(showOnHome(snoozed, at('12:30'), clockDate)).toBe(true);
        expect(showOnHome(snoozed, at('13:00'), clockDate)).toBe(false);
    });

    it('nicht, wenn genommen oder uebersprungen, nie Bedarfsmedikamente', () => {
        expect(showOnHome(intake({ status: 'taken' }), at('08:00'), clockDate)).toBe(false);
        expect(showOnHome(intake({ status: 'skipped' }), at('08:00'), clockDate)).toBe(false);
        expect(showOnHome(intake({ prn: true }), at('08:00'), clockDate)).toBe(false);
    });

    it('nach Spaeter erinnern erst wieder zur neuen Zeit', () => {
        const snoozed = intake({ snoozed_until: '2026-11-12T08:30:00', snooze_count: 1 });
        expect(showOnHome(snoozed, at('08:10'), clockDate)).toBe(false);
        expect(showOnHome(snoozed, at('08:30'), clockDate)).toBe(true);
    });
});

describe('Kachel: hellroter Rahmen', () => {
    it('30 Minuten nach der Zeit', () => {
        expect(HOME_MEDS_OVERDUE_MS).toBe(30 * 60 * 1000);
        expect(isOverdue(intake(), at('08:30'), clockDate)).toBe(false);
        expect(isOverdue(intake(), at('08:31'), clockDate)).toBe(true);
        expect(isOverdue(intake({ status: 'missed' }), at('13:00'), clockDate)).toBe(true);
    });

    it('rechnet ab der verschobenen Zeit', () => {
        const snoozed = intake({ snoozed_until: '2026-11-12T08:30:00', snooze_count: 1 });
        expect(effectiveDue(snoozed, clockDate)?.getTime()).toBe(at('08:30').getTime());
        expect(isOverdue(snoozed, at('08:45'), clockDate)).toBe(false);
        expect(isOverdue(snoozed, at('09:01'), clockDate)).toBe(true);
    });

    it('nie bei genommenen oder uebersprungenen', () => {
        expect(isOverdue(intake({ status: 'taken' }), at('12:00'), clockDate)).toBe(false);
        expect(isOverdue(intake({ status: 'skipped' }), at('12:00'), clockDate)).toBe(false);
    });
});
