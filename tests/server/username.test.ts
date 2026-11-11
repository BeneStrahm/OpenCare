import { describe, it, expect } from 'vitest';
import { buildUsername, normalizeUsername } from '../../server/src/lib/normalize';

/**
 * Anmeldung mit Benutzername (E18): VornameNachname ohne Leerzeichen.
 * Leerraum darf kein zweites Konto mit "demselben" Namen ergeben.
 */
describe('Benutzername', () => {
    it('entfernt jeden Leerraum', () => {
        expect(normalizeUsername('  Erika   Muster ')).toBe('ErikaMuster');
        expect(normalizeUsername('ErikaMuster')).toBe('ErikaMuster');
    });

    it('baut den Namen aus Vor- und Nachname', () => {
        expect(buildUsername(' Erika ', 'Muster')).toBe('ErikaMuster');
        expect(buildUsername('Anna Maria', 'von  Beispiel')).toBe('AnnaMariavonBeispiel');
    });

    it('behaelt Bindestriche, Umlaute und ß', () => {
        expect(buildUsername('Hans-Jürgen', 'Groß-Möller')).toBe('Hans-JürgenGroß-Möller');
        // Zerlegte Umlaute (z. B. aus macOS) werden zur ueblichen Form
        expect(buildUsername('Ju\u0308rgen', 'Muster')).toBe('J\u00fcrgenMuster');
    });

    it('behaelt die Schreibweise aus der Einladung', () => {
        expect(buildUsername('erika', 'MUSTER')).toBe('erikaMUSTER');
    });

    it('ergibt bei verschiedener Aufteilung denselben Namen', () => {
        // Doppelte Namen erkennt die Datenbank ueber LOWER(username)
        expect(buildUsername('Anna Maria', 'Muster')?.toLowerCase())
            .toBe(buildUsername('anna', 'maria muster')?.toLowerCase());
    });

    it('verlangt beide Teile', () => {
        expect(buildUsername('Erika', '  ')).toBeNull();
        expect(buildUsername('', 'Muster')).toBeNull();
        expect(buildUsername(undefined, 'Muster')).toBeNull();
        expect(buildUsername('E'.repeat(101), 'Muster')).toBeNull();
    });
});
