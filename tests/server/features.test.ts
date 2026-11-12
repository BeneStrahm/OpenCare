import { describe, it, expect } from 'vitest';
import {
    isFeatureEnabled, enabledVitalTypes, isVitalTypeEnabled, cleanFlags, cleanVitalTypes,
    FEATURE_IDS, RETIRED_FEATURES,
} from '../../server/src/lib/features';
import { publicSettings, validateSettingsPatch } from '../../server/src/lib/circleSettings';

// Fork: Funktionen und Messwerte pro Kreis.

describe('Standard: alles an', () => {
    it('ohne Einstellungen sind alle Funktionen und Messwerte an, ausser stillgelegten', () => {
        for (const id of FEATURE_IDS) expect(isFeatureEnabled({}, id)).toBe(!RETIRED_FEATURES.includes(id));
        expect(enabledVitalTypes(undefined)).toHaveLength(6);
    });

    it('nur ausdruecklich false schaltet aus', () => {
        const settings = { features: { calendar: false, tasks: true } };
        expect(isFeatureEnabled(settings, 'calendar')).toBe(false);
        expect(isFeatureEnabled(settings, 'tasks')).toBe(true);
    });

    it('stillgelegte Funktionen bleiben aus, auch wenn sie gespeichert an sind', () => {
        expect(RETIRED_FEATURES).toContain('visitors');
        expect(isFeatureEnabled({ features: { visitors: true } }, 'visitors')).toBe(false);
    });

    it('Pflegetagebuch ist abschaltbar, Sprachnotizen ruhen dann mit', () => {
        const off = { features: { journal: false } };
        expect(FEATURE_IDS).toContain('journal');
        expect(isFeatureEnabled(off, 'journal')).toBe(false);
        expect(isFeatureEnabled(off, 'voice_journal')).toBe(false);
        expect(isFeatureEnabled(off, 'voice_commands')).toBe(true);
        expect(isFeatureEnabled({ features: { journal: true } }, 'voice_journal')).toBe(true);
        expect(cleanFlags({ journal: false }, FEATURE_IDS)).toEqual({ journal: false });
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
        // Die fruehere Tablet-Einstellung (Kiosk, entfernt in Launch Block C) geht nicht mehr hinaus.
        expect(pub).not.toHaveProperty('kiosk_elements');
        expect(validateSettingsPatch({ kiosk_elements: { info: false } }, 'de').error).toBeTruthy();
        expect(pub.vital_types).toEqual(['bp']);
    });
});
