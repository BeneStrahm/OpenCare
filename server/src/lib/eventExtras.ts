// Fork: Zusatzangaben an Terminen (Teilnehmende ohne Konto, Hin- und Rückfahrt).
// Reine Helfer ohne Datenbank, damit Route und Import dieselben Regeln nutzen.

/** Fahrzeit in Schritten von 15 Minuten, höchstens 4 Stunden. */
export const TRAVEL_STEP_MINUTES = 15;
export const TRAVEL_MAX_MINUTES = 240;

const MAX_GUESTS = 30;
const MAX_NAME_LENGTH = 100;

const isEmpty = (value: unknown): boolean =>
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** Name einer Person (Teilnehmende, Fahrer): getrimmt, gekürzt, leer -> null. */
export const cleanPersonName = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/\s+/g, ' ');
    return trimmed ? trimmed.slice(0, MAX_NAME_LENGTH) : null;
};

/** Liste freier Namen: nur Texte, ohne Doppelte (Groß/klein egal), begrenzt. */
export const cleanGuests = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of value) {
        const name = cleanPersonName(item);
        if (!name) continue;
        const key = name.toLocaleLowerCase('de');
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(name);
        if (result.length >= MAX_GUESTS) break;
    }
    return result;
};

/** Fahrzeit in Minuten (15 bis 240, Vielfaches von 15). Leer oder ungültig -> null. */
export const cleanTravelMinutes = (value: unknown): number | null => {
    if (isEmpty(value)) return null;
    const minutes = Number(value);
    if (!Number.isInteger(minutes)) return null;
    if (minutes < TRAVEL_STEP_MINUTES || minutes > TRAVEL_MAX_MINUTES) return null;
    return minutes % TRAVEL_STEP_MINUTES === 0 ? minutes : null;
};

/** true, wenn ein Wert gesetzt, aber keine gültige Fahrzeit ist. */
export const isInvalidTravelMinutes = (value: unknown): boolean =>
    !isEmpty(value) && cleanTravelMinutes(value) === null;
