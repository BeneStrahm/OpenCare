import { describe, it, expect } from 'vitest';
import {
    isFeatureEnabled, isKioskElementEnabled, enabledVitalTypes, isVitalTypeEnabled, cleanFlags, cleanVitalTypes,
    FEATURE_IDS, KIOSK_ELEMENTS,
} from '../../server/src/lib/features';
import { publicSettings, validateSettingsPatch } from '../../server/src/lib/circleSettings';

// Fork: Funktionen, Tablet-Elemente und Messwerte pro Kreis.

describe('Standard: alles an', () => {
    it('ohne Einstellungen sind alle Funktionen, Elemente und Messwerte an', () => {
        for (const id of FEATURE_IDS) expect(isFeatureEnabled({}, id)).toBe(true);
        for (const id of KIOSK_ELEMENTS) expect(isKioskElementEnabled(null, id)).toBe(true);
        expect(enabledVitalTypes(undefined)).toHaveLength(6);
    });

    it('nur ausdruecklich false schaltet aus', () => {
        const settings = { features: { calendar: false, tasks: true }, kiosk_elements: { status_bar: false } };
        expect(isFeatureEnabled(settings, 'calendar')).toBe(false);
        expect(isFeatureEnabled(settings, 'tasks')).toBe(true);
        expect(isKioskElementEnabled(settings, 'status_bar')).toBe(false);
        expect(isKioskElementEnabled(settings, 'voice')).toBe(true);
    });
});

describe('Messwerte', () => {
    it('nur gewaehlte Typen sind erlaubt', () => {
        const settings = { vital_types: ['weight', 'glucose'] };
        expect(isVitalTypeEnabled(settings, 'weight')).toBe(true);
        expect(isVitalTypeEnabled(settings, 'bp')).toBe(false);
    });

    it('leere oder unbekannte Listen werden abgelehnt, alle = null', () => {
        expect(cleanVitalTypes([])).toBeUndefined();
        expect(cleanVitalTypes(['puls'])).toBeUndefined();
        expect(cleanVitalTypes(['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'])).toBeNull();
        expect(cleanVitalTypes(['glucose', 'weight'])).toEqual(['weight', 'glucose']);
    });
});

describe('Pruefung der Schalter', () => {
    it('speichert nur false und lehnt Unbekanntes ab', () => {
        expect(cleanFlags({ calendar: false, tasks: true }, FEATURE_IDS)).toEqual({ calendar: false });
        expect(cleanFlags({ unbekannt: false }, FEATURE_IDS)).toBeNull();
        expect(cleanFlags({ calendar: 'nein' }, FEATURE_IDS)).toBeNull();
        expect(cleanFlags([], FEATURE_IDS)).toBeNull();
    });

    it('validateSettingsPatch nimmt die neuen Schluessel an', () => {
        const result = validateSettingsPatch({ features: { shopping: false }, vital_types: ['weight'] }, 'de');
        expect(result.error).toBeUndefined();
        expect(result.patch).toEqual({ features: { shopping: false }, vital_types: ['weight'] });
    });

    it('publicSettings gibt die Schalter heraus', () => {
        const pub = publicSettings({ features: { shopping: false }, kiosk_elements: { info: false }, vital_types: ['bp'] });
        expect(pub.features).toEqual({ shopping: false });
        expect(pub.kiosk_elements).toEqual({ info: false });
        expect(pub.vital_types).toEqual(['bp']);
    });
});
