import { describe, it, expect } from 'vitest';
import { stockState, stockAction, stockAlertTexts, formatAmount } from '../../server/src/lib/stockAlerts';

describe('Vorrats-Erinnerung', () => {
    it('meldet, sobald der Vorrat laut Plan noch 7 Tage oder weniger reicht', () => {
        // 2 pro Tag: Grenze bei 14
        expect(stockState('15', 2)).toBe('ok');
        expect(stockState('14', 2)).toBe('low');
        expect(stockState('6.5', 2)).toBe('low');
        // nur an einzelnen Tagen: 1 an 3 von 7 Tagen, Grenze bei 3
        expect(stockState('4', 3 / 7)).toBe('ok');
        expect(stockState('3', 3 / 7)).toBe('low');
    });

    it('meldet leeren Vorrat auch ohne Plan (bei Bedarf)', () => {
        expect(stockState(0, 0)).toBe('low');
        expect(stockState('0', null)).toBe('low');
        expect(stockState('3', 0)).toBe('ok');
        expect(stockState('3', null)).toBe('ok');
    });

    it('meldet nichts ohne Vorrat', () => {
        expect(stockState(null, 2)).toBe('untracked');
        expect(stockAction('untracked', false)).toBe('none');
    });

    it('meldet einmal und nicht doppelt', () => {
        expect(stockAction('low', false)).toBe('notify');
        expect(stockAction('low', true)).toBe('none');
    });

    it('setzt nach dem Auffuellen zurueck, damit das naechste Absinken wieder meldet', () => {
        expect(stockAction('ok', true)).toBe('reset');
        expect(stockAction('untracked', true)).toBe('reset');
        expect(stockAction('ok', false)).toBe('none');
    });

    it('formuliert die Meldung wie gewuenscht', () => {
        expect(stockAlertTexts('de', 'Ramipril', 5, null).body)
            .toBe('Ramipril geht zur Neige: noch 5 Stück. Bitte Rezept oder Nachschub besorgen.');
        expect(stockAlertTexts('de', 'Insulin', 2.5, 'ml').body).toContain('noch 2,5 ml');
        expect(stockAlertTexts('it', 'X', 1, null).title).toBe('X is running low');
    });

    it('zeigt Mengen ohne unnoetige Nachkommastellen', () => {
        expect(formatAmount(5, 'de')).toBe('5');
        expect(formatAmount(2.5, 'de')).toBe('2,5');
        expect(formatAmount(2.5, 'en')).toBe('2.5');
    });
});

describe('Einheiten in der Meldung', () => {
    it('macht aus Zaehl-Einheiten "Stück"', () => {
        expect(stockAlertTexts('de', 'Ramipril', 5, 'Tablette').body).toContain('noch 5 Stück.');
        expect(stockAlertTexts('de', 'Ramipril', 5, 'Kapseln').body).toContain('noch 5 Stück.');
        expect(stockAlertTexts('de', 'Insulin', 40, 'ml').body).toContain('noch 40 ml.');
    });
});
