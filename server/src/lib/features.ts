// Fork: Funktionen und Messwerte pro Kreis ein- und ausschalten.
//
// Gespeichert in care_circles.settings (siehe circleSettings.ts):
//   features:       { [FeatureId]: false }   nur ausgeschaltete stehen drin
//   vital_types:    VitalType[] | null       null = alle Messwerte
// Standard: alles an. Ausschalten loescht keine Daten.

import { Request, Response, NextFunction } from 'express';
import { query } from '../db';

/**
 * Abschaltbare Funktionen und die API-Pfade, die der Server dann sperrt.
 * Fest an (nicht in der Liste): Uebersicht, Informationen, Kreis,
 * Einstellungen, Notfall.
 */
export const FEATURES = {
    calendar: ['/api/events', '/api/calendar'],
    messages: ['/api/messages'],
    // Pflegetagebuch. Sperrt auch die Links fuer Betreuungspersonen
    // (caregiverLinkMiddleware) und ueber FEATURE_REQUIRES die Sprachnotizen.
    journal: ['/api/journal', '/api/caregiver-links'],
    care_plan: ['/api/care-plan'],
    medications: ['/api/medications'],
    health: ['/api/vitals'],
    consultations: ['/api/consultations'],
    visitors: ['/api/visits'],
    tasks: ['/api/tasks'],
    shopping: ['/api/shopping'],
    expenses: ['/api/expenses'],
    contacts: ['/api/contacts'],
    documents: ['/api/documents'],
    voice_commands: ['/api/voice-commands'],
    // Sprachnotizen im Tagebuch: /api/voice nutzt auch die Sprachsteuerung,
    // darum sperrt der Server /api/voice erst, wenn BEIDE aus sind (siehe app.ts).
    voice_journal: [],
    digests: ['/api/digests'],
    heatwave: ['/api/heatwave'],
} as const;

export type FeatureId = keyof typeof FEATURES;
export const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[];

/** Die Messwerte, die OpenCare kennt (routes/vitals.ts). */
export const VITAL_TYPES = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'] as const;
export type VitalType = (typeof VITAL_TYPES)[number];

type Settings = Record<string, unknown> | null | undefined;

const flags = (settings: Settings, key: string): Record<string, unknown> => {
    const value = settings?.[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
};

/**
 * Vorerst stillgelegte Funktionen (Launch Block D): immer aus, nicht in den
 * Einstellungen waehlbar, Daten und Code bleiben. Gegenstueck in client/src/lib/features.ts.
 * visitors: Besuche wurden nur am Kiosk angemeldet, der entfallen ist.
 */
export const RETIRED_FEATURES: readonly FeatureId[] = ['visitors'];

/**
 * Funktionen, die nur mit einer anderen Funktion laufen. Der eigene Schalter
 * bleibt gespeichert, wirkt aber erst, wenn die andere Funktion wieder an ist.
 * Gegenstueck in client/src/lib/features.ts.
 */
export const FEATURE_REQUIRES: Partial<Record<FeatureId, FeatureId>> = {
    voice_journal: 'journal',
};

/** An, solange nicht stillgelegt, nicht ausdruecklich false gespeichert und die noetige Funktion an ist. */
export function isFeatureEnabled(settings: Settings, id: FeatureId): boolean {
    if (RETIRED_FEATURES.includes(id)) return false;
    if (flags(settings, 'features')[id] === false) return false;
    const required = FEATURE_REQUIRES[id];
    return required === undefined || isFeatureEnabled(settings, required);
}

/** Ausgewaehlte Messwerte; ohne Auswahl alle. */
export function enabledVitalTypes(settings: Settings): VitalType[] {
    const value = settings?.vital_types;
    if (!Array.isArray(value)) return [...VITAL_TYPES];
    return VITAL_TYPES.filter((t) => value.includes(t));
}

export function isVitalTypeEnabled(settings: Settings, type: string): boolean {
    return (enabledVitalTypes(settings) as string[]).includes(type);
}

// ─── Pruefung von Einstellungs-Aenderungen ──────────────────────────────────

/** { id: boolean } fuer bekannte ids, gespeichert werden nur die false-Werte. */
export function cleanFlags(value: unknown, known: readonly string[]): Record<string, false> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const out: Record<string, false> = {};
    for (const [key, flag] of Object.entries(value as Record<string, unknown>)) {
        if (!known.includes(key) || typeof flag !== 'boolean') return null;
        if (flag === false) out[key] = false;
    }
    return out;
}

/** Liste bekannter Messwerte (mindestens einer), oder null fuer "alle". */
export function cleanVitalTypes(value: unknown): VitalType[] | null | undefined {
    if (value === null) return null;
    if (!Array.isArray(value) || value.length === 0) return undefined;
    if (!value.every((v) => typeof v === 'string' && (VITAL_TYPES as readonly string[]).includes(v))) return undefined;
    const list = VITAL_TYPES.filter((t) => value.includes(t));
    return list.length === VITAL_TYPES.length ? null : list;
}

// ─── Server-Sperre ──────────────────────────────────────────────────────────

const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; settings: Settings }>();

/** Nach dem Speichern aufrufen, damit Aenderungen sofort greifen. */
export function forgetCircleSettings(circleId: string): void {
    cache.delete(circleId);
}

export async function loadCircleSettings(circleId: string): Promise<Settings> {
    const hit = cache.get(circleId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.settings;
    const result = await query('SELECT settings FROM care_circles WHERE id = $1', [circleId]);
    const settings = (result.rows[0]?.settings ?? {}) as Settings;
    cache.set(circleId, { at: Date.now(), settings });
    return settings;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kreis der Anfrage: X-Circle-Id. */
function circleOf(req: Request): string | null {
    const header = req.headers['x-circle-id'];
    return typeof header === 'string' && UUID_RE.test(header) ? header : null;
}

/**
 * Sperrt eine Route, wenn KEINE der genannten Funktionen eingeschaltet ist.
 * Ohne erkennbaren Kreis geht die Anfrage weiter: Die Route selbst verlangt
 * dann ohnehin einen Kreis und lehnt ab.
 */
export const requireFeature = (...ids: FeatureId[]) => async (req: Request, res: Response, next: NextFunction) => {
    try {
        const circleId = circleOf(req);
        if (!circleId) return next();
        const settings = await loadCircleSettings(circleId);
        if (ids.some((id) => isFeatureEnabled(settings, id))) return next();
        return res.status(403).json({ success: false, error: 'FEATURE_DISABLED' });
    } catch (error) {
        return next(error);
    }
};

/** Fuer Planer (Erinnerungen): Funktion fuer diesen Kreis an? */
export async function featureEnabledForCircle(circleId: string, id: FeatureId): Promise<boolean> {
    return isFeatureEnabled(await loadCircleSettings(circleId), id);
}
