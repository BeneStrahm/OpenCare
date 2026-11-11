import { describe, it, expect } from 'vitest';
import { MEDICATION_COLORS, VIEW_COLORS, contrastRatio, medicationColorOf, viewColorOf } from '../../client/src/lib/viewColors';
import { MEDICATION_COLOR_IDS, VIEW_COLOR_IDS } from '../../server/src/lib/viewColors';

// Block D: waehlbare Farben der einfachen Ansicht, Vorgaben aus Phase 3b.
const WHITE = '#ffffff';
const BG = '#f5f7fb'; // Hintergrund der einfachen Ansicht (RecipientView.tsx)
const TEXT = '#1d2433';

describe('Farben der einfachen Ansicht', () => {
    it('6 bis 8 Farben, gleiche Kennungen wie im Server', () => {
        expect(VIEW_COLORS.length).toBeGreaterThanOrEqual(6);
        expect(VIEW_COLORS.length).toBeLessThanOrEqual(8);
        expect(VIEW_COLORS.map((c) => c.id)).toEqual([...VIEW_COLOR_IDS]);
    });

    it.each(VIEW_COLORS.map((c) => [c.id, c] as const))('%s erfuellt die Kontrastvorgaben', (_id, c) => {
        expect(contrastRatio(WHITE, c.strong)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(c.dark, WHITE)).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(c.dark, c.soft)).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(TEXT, c.soft)).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(c.strong, BG)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(c.strong, c.soft)).toBeGreaterThanOrEqual(3);
    });

    it('unbekannte Kennung ergibt Blau', () => {
        expect(viewColorOf(null).id).toBe('blue');
        expect(viewColorOf('neon').id).toBe('blue');
    });
});

// Block L2: Farbe pro Medikament, gleiche Werte wie oben, aber ohne Gruen ("Genommen").
describe('Farben der Medikamente', () => {
    it('ohne Gruen, gleiche Kennungen wie im Server', () => {
        expect(MEDICATION_COLORS.map((c) => c.id)).not.toContain('green');
        expect(MEDICATION_COLORS.map((c) => c.id)).toEqual([...MEDICATION_COLOR_IDS]);
    });

    it.each(MEDICATION_COLORS.map((c) => [c.id, c] as const))('%s: Schrift auf der Karte und Rand gut sichtbar', (_id, c) => {
        expect(contrastRatio(TEXT, c.soft)).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(c.strong, WHITE)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(c.strong, c.soft)).toBeGreaterThanOrEqual(3);
    });

    it('leer oder unbekannt ergibt keine Farbe', () => {
        expect(medicationColorOf(null)).toBeNull();
        expect(medicationColorOf('green')).toBeNull();
        expect(medicationColorOf('teal')?.id).toBe('teal');
    });
});
