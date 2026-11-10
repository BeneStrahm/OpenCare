import { describe, it, expect } from 'vitest';
import {
    chooseActiveCircleId, recipientCircleOf, recipientRedirect, RECIPIENT_VIEW_PATH,
    isCompanionActive, isTravelActive, momentOf, localDay, FONT_SCALES,
} from '../../client/src/lib/recipientView';
import * as serverRules from '../../server/src/lib/eventExtras';

/**
 * Einfache Ansicht der betreuten Person (Launch Block C): welche Konten sie
 * sehen, welcher Kreis aktiv ist und dass jede andere Adresse zurueckfuehrt.
 * Die Darstellung selbst braucht einen Browser; die Regeln hier nicht.
 */

const ROLES = ['admin', 'family', 'professional', 'neighbor', 'recipient'] as const;

describe('wer die einfache Ansicht bekommt', () => {
    it('nur ein Konto, das in einem Kreis recipient ist', () => {
        for (const role of ROLES) {
            const circles = [{ id: 'kreis-1', role }];
            expect(recipientCircleOf(circles)?.id ?? null, role).toBe(role === 'recipient' ? 'kreis-1' : null);
        }
    });

    it('in mehreren Kreisen gilt der Kreis, in dem das Konto recipient ist', () => {
        const circles = [
            { id: 'kreis-familie', role: 'family' },
            { id: 'kreis-eigen', role: 'recipient' },
            { id: 'kreis-admin', role: 'admin' },
        ];
        expect(recipientCircleOf(circles)?.id).toBe('kreis-eigen');
        // Auch wenn vorher ein anderer Kreis gemerkt war.
        expect(chooseActiveCircleId(circles, 'kreis-familie')).toBe('kreis-eigen');
        expect(chooseActiveCircleId(circles, null)).toBe('kreis-eigen');
    });

    it('bei mehreren recipient-Kreisen der erste der Liste', () => {
        const circles = [{ id: 'a', role: 'recipient' }, { id: 'b', role: 'recipient' }];
        expect(chooseActiveCircleId(circles, 'b')).toBe('a');
    });

    it('andere Rollen behalten die bisherige Kreiswahl', () => {
        const circles = [{ id: 'a', role: 'family' }, { id: 'b', role: 'admin' }];
        expect(chooseActiveCircleId(circles, 'b')).toBe('b');
        expect(chooseActiveCircleId(circles, 'weg')).toBe('a');
        expect(chooseActiveCircleId(circles, null)).toBe('a');
        expect(chooseActiveCircleId([], 'a')).toBeNull();
    });
});

describe('Umleitung', () => {
    it('die einfache Ansicht hat nur die Startadresse', () => {
        expect(RECIPIENT_VIEW_PATH).toBe('/');
        expect(recipientRedirect('/')).toBeNull();
    });

    it('jede Seite der normalen App fuehrt zurueck', () => {
        for (const path of ['/journal', '/calendar', '/medications', '/health', '/settings', '/circle', '/recipient',
            '/consultations', '/consultations/abc', '/onboarding', '/join', '/kiosk', '/kiosk/pair', '/myday', '/unbekannt']) {
            expect(recipientRedirect(path), path).toBe('/');
        }
    });
});

describe('Termine: gleiche Regeln wie der Server (eventExtras.ts)', () => {
    const cases = [
        {},
        { companion_needed: true },
        { companion_needed: false, member_ids: ['m1'] },
        { member_ids: ['m1'] },
        { guests: ['Gast'] },
        { travel_needed: false, travel_to_minutes: 30 },
        { travel_to_minutes: 30 },
        { travel_back_minutes: 15 },
        { travel_needed: true },
    ];
    it.each(cases)('%o', (event) => {
        expect(isCompanionActive(event)).toBe(serverRules.isCompanionActive(event));
        expect(isTravelActive(event)).toBe(serverRules.isTravelActive(event));
    });
});

describe('kleine Helfer', () => {
    it('Tageszeiten wie Medikamente > Heute', () => {
        expect(momentOf(5)).toBe('morning');
        expect(momentOf(10)).toBe('morning');
        expect(momentOf(11)).toBe('noon');
        expect(momentOf(17)).toBe('evening');
        expect(momentOf(22)).toBe('night');
        expect(momentOf(3)).toBe('night');
    });

    it('lokales Datum fuer die Termin-API', () => {
        expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
    });

    it('Textgroessen: normal zuerst, alle groesser oder gleich 1', () => {
        expect(FONT_SCALES[0]).toBe(1);
        for (const scale of FONT_SCALES) expect(scale).toBeGreaterThanOrEqual(1);
    });
});
