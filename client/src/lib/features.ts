// Fork: Funktionen und Messwerte pro Kreis (Gegenstueck zu
// server/src/lib/features.ts). Gespeichert in den Kreis-Einstellungen:
//   features:       { id: false }  nur ausgeschaltete stehen drin
//   vital_types:    Liste oder null (= alle)
// Standard: alles an. Ausschalten loescht keine Daten.

import { useCircle } from '../contexts/CircleContext';

/** Abschaltbare Funktionen, in der Reihenfolge der Einstellungen. */
export const FEATURE_IDS = [
    'calendar', 'messages', 'journal', 'care_plan', 'medications', 'health', 'consultations', 'visitors',
    'tasks', 'shopping', 'expenses', 'contacts', 'documents',
    'voice_commands', 'voice_journal', 'digests', 'heatwave',
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

/** Seiten, die zu einer Funktion gehoeren. */
const ROUTE_FEATURES: Array<[string, FeatureId]> = [
    ['/calendar', 'calendar'],
    ['/messages', 'messages'],
    ['/journal', 'journal'],
    ['/care-plan', 'care_plan'],
    ['/medications', 'medications'],
    ['/health', 'health'],
    ['/consultations', 'consultations'],
    ['/consultation', 'consultations'],
    ['/visitors', 'visitors'],
    ['/tasks', 'tasks'],
    ['/shopping', 'shopping'],
    ['/expenses', 'expenses'],
    ['/contacts', 'contacts'],
    ['/documents', 'documents'],
];

export const VITAL_TYPES = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'] as const;
export type VitalType = (typeof VITAL_TYPES)[number];

type Settings = Record<string, unknown> | null | undefined;

const flags = (settings: Settings, key: string): Record<string, unknown> => {
    const value = settings?.[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
};

/**
 * Vorerst stillgelegt (Launch Block D): immer aus, in den Einstellungen nicht
 * waehlbar, Daten bleiben. Gegenstueck in server/src/lib/features.ts.
 */
export const RETIRED_FEATURES: readonly FeatureId[] = ['visitors'];

/**
 * Funktionen, die nur mit einer anderen Funktion laufen (Sprachnotizen nur mit
 * Pflegetagebuch). Gegenstueck in server/src/lib/features.ts.
 */
export const FEATURE_REQUIRES: Partial<Record<FeatureId, FeatureId>> = {
    voice_journal: 'journal',
};

/** Gespeicherter Schalter ohne Abhaengigkeiten (Einstellungsseite). */
export const isFeatureSwitchOn = (settings: Settings, id: FeatureId): boolean =>
    !RETIRED_FEATURES.includes(id) && flags(settings, 'features')[id] !== false;

export const isFeatureEnabled = (settings: Settings, id: FeatureId): boolean => {
    if (!isFeatureSwitchOn(settings, id)) return false;
    const required = FEATURE_REQUIRES[id];
    return required === undefined || isFeatureEnabled(settings, required);
};

/**
 * Kacheln der einfachen Ansicht, die ein Admin ausblenden kann (Seite Betreute
 * Person). Gespeichert als view_tiles: { id: false }. Die Kachel Einstellungen
 * bleibt immer. Nur Anzeige, die Rechte bleiben gleich.
 * Gegenstueck in server/src/lib/circleSettings.ts.
 */
export const VIEW_TILE_IDS = [
    'emergency', 'meds', 'health', 'visitors', 'appointments', 'contacts', 'ask', 'doctor', 'info', 'shopping',
] as const;
export type ViewTileId = (typeof VIEW_TILE_IDS)[number];

export const isViewTileOn = (settings: Settings, id: ViewTileId): boolean =>
    flags(settings, 'view_tiles')[id] !== false;

/** Gehoert die Kachel zu einer Funktion des Kreises? Dann fehlt sie, wenn die Funktion aus ist. */
export const VIEW_TILE_FEATURES: Partial<Record<ViewTileId, FeatureId>> = {
    meds: 'medications', health: 'health', visitors: 'calendar', appointments: 'calendar',
    contacts: 'contacts', doctor: 'consultations', shopping: 'shopping',
};

export const enabledVitalTypes = (settings: Settings): VitalType[] => {
    const value = settings?.vital_types;
    if (!Array.isArray(value)) return [...VITAL_TYPES];
    return VITAL_TYPES.filter((t) => value.includes(t));
};

/** Funktion zu einer Seite, oder null fuer Seiten, die immer da sind. */
export const featureOfPath = (pathname: string): FeatureId | null => {
    for (const [path, id] of ROUTE_FEATURES) {
        if (pathname === path || pathname.startsWith(`${path}/`)) return id;
    }
    return null;
};

/** Seite erreichbar? Seiten ohne Funktion sind immer erreichbar. */
export const isPathEnabled = (settings: Settings, pathname: string): boolean => {
    const id = featureOfPath(pathname);
    return id === null || isFeatureEnabled(settings, id);
};

/** Einstellungen des aktiven Kreises. */
export function useFeatures() {
    const { activeCircle } = useCircle();
    const settings = activeCircle?.settings as Settings;
    return {
        isOn: (id: FeatureId) => isFeatureEnabled(settings, id),
        isPathOn: (pathname: string) => isPathEnabled(settings, pathname),
        vitalTypes: enabledVitalTypes(settings),
    };
}
