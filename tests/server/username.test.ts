import { describe, it, expect } from 'vitest';
import { buildUsername, normalizeUsername } from '../../server/src/lib/normalize';

/**
 * Anmeldung mit Benutzername (E18): Vorname und Nachname. Doppelte Leerzeichen
 * und Leerraum am Rand duerfen kein zweites Konto mit "demselben" Namen ergeben.
 */
describe('Benutzername', () => {
    it('fasst Leerraum zusammen', () => {
        expect(normalizeUsername('  Erika   Muster ')).toBe('Erika Muster');
    });

    it('baut den Namen aus Vor- und Nachname', () => {
        expect(buildUsername(' Erika ', 'Muster')).toBe('Erika Muster');
        expect(buildUsername('Anna Maria', 'von  Beispiel')).toBe('Anna Maria von Beispiel');
    });

    it('verlangt beide Teile', () => {
        expect(buildUsername('Erika', '  ')).toBeNull();
        expect(buildUsername('', 'Muster')).toBeNull();
        expect(buildUsername(undefined, 'Muster')).toBeNull();
        expect(buildUsername('E'.repeat(101), 'Muster')).toBeNull();
    });
});
