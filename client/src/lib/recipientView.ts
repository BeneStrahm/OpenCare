/**
 * Einfache Ansicht der betreuten Person (Rolle recipient), Launch Block C.
 * Reine Regeln ohne React, damit sie ohne Browser testbar sind
 * (tests/client/recipientView.test.ts).
 */

interface CircleWithRole {
    id: string;
    role: string;
}

/**
 * Kreis, in dem das Konto betreute Person ist. Ist es das in einem Kreis,
 * zeigt die App nur die einfache Ansicht, auch wenn das Konto in anderen
 * Kreisen eine andere Rolle hat. Bei mehreren gilt der erste der Liste
 * (GET /api/circles, sortiert wie die Kreisauswahl).
 */
export function recipientCircleOf<T extends CircleWithRole>(circles: readonly T[]): T | null {
    return circles.find((c) => c.role === 'recipient') ?? null;
}

/**
 * Aktiver Kreis nach dem Laden der Liste: fuer die betreute Person immer ihr
 * Kreis; sonst der gemerkte Kreis, solange es ihn noch gibt, sonst der erste.
 */
export function chooseActiveCircleId(circles: readonly CircleWithRole[], current: string | null): string | null {
    const recipientCircle = recipientCircleOf(circles);
    if (recipientCircle) return recipientCircle.id;
    if (current && circles.some((c) => c.id === current)) return current;
    return circles[0]?.id ?? null;
}

/** Die einfache Ansicht hat nur eine Adresse. */
export const RECIPIENT_VIEW_PATH = '/';

/** Jede andere Adresse fuehrt zurueck auf die einfache Ansicht (null = bleiben). */
export function recipientRedirect(pathname: string): string | null {
    return pathname === RECIPIENT_VIEW_PATH ? null : RECIPIENT_VIEW_PATH;
}

/** Feste Fragen von "Fragen Sie mich" (GET /api/companion/answer/:frage, routes/companion.ts). */
export const RECIPIENT_QUESTIONS = ['medications', 'visitors', 'appointments', 'week', 'date', 'contacts'] as const;
export type RecipientQuestion = (typeof RECIPIENT_QUESTIONS)[number];

export type Moment = 'morning' | 'noon' | 'evening' | 'night';
export const MOMENTS: Moment[] = ['morning', 'noon', 'evening', 'night'];

/** Tageszeit einer Einnahme, gleiche Regel wie Medikamente > Heute (pages/Medications.tsx). */
export function momentOf(hour: number): Moment {
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 17) return 'noon';
    if (hour >= 17 && hour < 22) return 'evening';
    return 'night';
}

interface EventFlags {
    member_ids?: unknown[] | null;
    guests?: unknown[] | null;
    companion_needed?: boolean | null;
    travel_to_minutes?: number | null;
    travel_back_minutes?: number | null;
    travel_needed?: boolean | null;
}

const hasItems = (value: unknown[] | null | undefined): boolean => Array.isArray(value) && value.length > 0;

/** Begleitung aktiv: gleiche Regel wie isCompanionActive in server/src/lib/eventExtras.ts. */
export const isCompanionActive = (event: EventFlags): boolean =>
    event.companion_needed ?? (hasItems(event.member_ids) || hasItems(event.guests));

/** Fahrt aktiv: gleiche Regel wie isTravelActive in server/src/lib/eventExtras.ts. */
export const isTravelActive = (event: EventFlags): boolean =>
    event.travel_needed ?? (event.travel_to_minutes != null || event.travel_back_minutes != null);

/** Lokales Datum "YYYY-MM-DD" (fuer ?from=&to= der Termin-API). */
export function localDay(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Textgroessen der einfachen Ansicht (Faktor auf die rem-Groessen). */
export const FONT_SCALES = [1, 1.15, 1.3] as const;
const FONT_SCALE_KEY = 'opencare.recipientView.fontScale';

export function loadFontScale(): number {
    try {
        const value = Number(localStorage.getItem(FONT_SCALE_KEY));
        return (FONT_SCALES as readonly number[]).includes(value) ? value : 1;
    } catch {
        return 1;
    }
}

export function saveFontScale(scale: number): void {
    try {
        localStorage.setItem(FONT_SCALE_KEY, String(scale));
    } catch { /* Speicher gesperrt: gilt dann nur bis zum Neuladen */ }
}

// ── Block K (E20): Blutzucker und Gewicht selbst eintragen ──

/** Diese Messwerte traegt die betreute Person selbst ein (wie RECIPIENT_VITAL_TYPES im Server). */
export const RECIPIENT_VITAL_TYPES = ['glucose', 'weight'] as const;
export type RecipientVitalType = (typeof RECIPIENT_VITAL_TYPES)[number];

/**
 * Grenzen gegen Tippfehler, in der gespeicherten Einheit (Blutzucker g/L, Gewicht kg).
 * Eigene Annahme, keine medizinische Vorgabe: was ausserhalb liegt, ist fast sicher vertippt.
 * Blutzucker 20 bis 600 mg/dL, Gewicht 20 bis 250 kg.
 */
export const RECIPIENT_VITAL_LIMITS: Record<RecipientVitalType, { min: number; max: number }> = {
    glucose: { min: 0.2, max: 6 },
    weight: { min: 20, max: 250 },
};

export type RecipientVitalInput =
    | { ok: true; shown: number; stored: number }
    | { ok: false; error: 'empty' | 'invalid' };

/**
 * Eingabe pruefen: Komma oder Punkt als Dezimalzeichen, Leerzeichen egal.
 * toStorage rechnet die angezeigte Einheit in die gespeicherte um (lib/units.ts).
 */
export function parseRecipientVital(
    type: RecipientVitalType,
    text: string,
    toStorage: (shown: number) => number
): RecipientVitalInput {
    const clean = text.replace(/\s+/g, '').replace(',', '.');
    if (!clean) return { ok: false, error: 'empty' };
    if (!/^\d+(\.\d+)?$/.test(clean)) return { ok: false, error: 'invalid' };
    const shown = Number(clean);
    const stored = toStorage(shown);
    const { min, max } = RECIPIENT_VITAL_LIMITS[type];
    if (!Number.isFinite(stored) || stored < min || stored > max) return { ok: false, error: 'invalid' };
    return { ok: true, shown, stored };
}
