import { describe, it, expect } from 'vitest';
import { cleanGuests, cleanPersonName, cleanTravelMinutes, isInvalidTravelMinutes } from '../../server/src/lib/eventExtras';

describe('Termin-Zusatzangaben', () => {
    it('Fahrzeit: nur 15 bis 240 Minuten in 15er-Schritten', () => {
        expect(cleanTravelMinutes(30)).toBe(30);
        expect(cleanTravelMinutes('45')).toBe(45);
        expect(cleanTravelMinutes(null)).toBeNull();
        expect(cleanTravelMinutes(20)).toBeNull();
        expect(cleanTravelMinutes(0)).toBeNull();
        expect(cleanTravelMinutes(255)).toBeNull();
        expect(isInvalidTravelMinutes(20)).toBe(true);
        expect(isInvalidTravelMinutes(null)).toBe(false);
        expect(isInvalidTravelMinutes('')).toBe(false);
    });
    it('Namen werden bereinigt, Doppelte entfernt', () => {
        expect(cleanPersonName('  Herr   Meier ')).toBe('Herr Meier');
        expect(cleanPersonName('')).toBeNull();
        expect(cleanPersonName(42)).toBeNull();
        expect(cleanGuests(['Anna', 'anna', ' ', 3, 'Ben'])).toEqual(['Anna', 'Ben']);
        expect(cleanGuests('Anna')).toEqual([]);
    });
});
