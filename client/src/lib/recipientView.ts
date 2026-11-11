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

/**
 * Block L2 (E21): Karten der Medikamente in der einfachen Ansicht. Eine Karte pro
 * Tageszeit (Einnahme ohne feste Uhrzeit) und eine pro fester Uhrzeit.
 * Sortiert nach der Uhrzeit; Tageszeiten stehen an ihrer Standardzeit (08, 12, 18, 22 Uhr).
 */
export type IntakeGroup =
    | { key: string; kind: 'moment'; moment: Moment; sort: number }
    | { key: string; kind: 'fixed'; time: string; sort: number };

const MOMENT_MINUTES: Record<Moment, number> = { morning: 8 * 60, noon: 12 * 60, evening: 18 * 60, night: 22 * 60 };

const pad2 = (n: number) => String(n).padStart(2, '0');

export function intakeGroupOf(due: Date | null, timeFixed: boolean | undefined): IntakeGroup {
    if (!due || timeFixed === false) {
        const moment = momentOf(due ? due.getHours() : 12);
        return { key: `moment:${moment}`, kind: 'moment', moment, sort: MOMENT_MINUTES[moment] };
    }
    const time = `${pad2(due.getHours())}:${pad2(due.getMinutes())}`;
    return { key: `fixed:${time}`, kind: 'fixed', time, sort: due.getHours() * 60 + due.getMinutes() };
}

interface GroupableIntake {
    due_at: string;
    time_fixed?: boolean;
    prn?: boolean;
    medication_name?: string;
}

/** Einnahmen in Karten aufteilen. Bedarfsmedikamente (prn) zeigt die einfache Ansicht nie. */
export function groupIntakes<T extends GroupableIntake>(
    intakes: readonly T[],
    toDate: (value: string) => Date | null
): Array<{ group: IntakeGroup; items: T[] }> {
    const groups = new Map<string, { group: IntakeGroup; items: T[] }>();
    for (const intake of intakes) {
        if (intake.prn) continue;
        const group = intakeGroupOf(toDate(intake.due_at), intake.time_fixed);
        const entry = groups.get(group.key) ?? { group, items: [] };
        entry.items.push(intake);
        groups.set(group.key, entry);
    }
    const list = [...groups.values()];
    for (const entry of list) {
        entry.items.sort((a, b) => a.due_at.localeCompare(b.due_at) || (a.medication_name ?? '').localeCompare(b.medication_name ?? ''));
    }
    // Bei gleicher Zeit steht die Tageszeit vor der festen Uhrzeit.
    return list.sort((a, b) => a.group.sort - b.group.sort || (a.group.kind === 'moment' ? -1 : 1));
}

// ── Block M (E23): Medikamenten-Kachel auf der Startseite ──

/** So lange vor der Einnahmezeit erscheint die Kachel. */
export const HOME_MEDS_LEAD_MS = 30 * 60 * 1000;
/** So lange nach der Einnahmezeit wechselt der Status auf "Noch nicht genommen" (rot). */
export const HOME_MEDS_OVERDUE_MS = 30 * 60 * 1000;
/**
 * Nachholfrist: so lange nach der (verschobenen) Zeit steht eine offene Einnahme in der
 * Kachel, danach verschwindet sie (Sicherheit: keine Morgentablette am Abend). Gleich wie
 * MISSED_AFTER_MS in server/src/lib/intakes.ts: dann gilt sie als verpasst, die Familie klaert es.
 */
export const HOME_MEDS_HIDE_AFTER_MS = 4 * 60 * 60 * 1000;
/** Gleich wie RECIPIENT_SNOOZE_MINUTES und RECIPIENT_SNOOZE_MAX in server/src/middleware/circle.ts. */
export const SNOOZE_MINUTES = 30;
export const SNOOZE_MAX = 2;

export interface HomeIntake {
    due_at: string;
    status: 'pending' | 'taken' | 'skipped' | 'missed';
    prn?: boolean;
    time_fixed?: boolean;
    snoozed_until?: string | null;
    snooze_count?: number | string | null;
}

const isOpenIntake = (i: HomeIntake) => i.status === 'pending' || i.status === 'missed';

/** Faellig ab: nach "Spaeter erinnern" die verschobene Zeit, sonst die geplante. */
export function effectiveDue(intake: HomeIntake, toDate: (value: string) => Date | null): Date | null {
    return (intake.snoozed_until ? toDate(intake.snoozed_until) : null) ?? toDate(intake.due_at);
}

/**
 * Steht diese offene Einnahme jetzt in der Kachel? Ab 30 Minuten vor der Zeit bis
 * 4 Stunden danach (HOME_MEDS_HIDE_AFTER_MS). Nach "Spaeter erinnern" erst wieder ab der
 * verschobenen Zeit, die Frist laeuft dann ab dort. Bedarfsmedikamente nie.
 */
export function showOnHome(intake: HomeIntake, now: Date, toDate: (value: string) => Date | null): boolean {
    // Die Uhr entscheidet, nicht der Status "missed" vom Server (gleiche Frist; so stimmt auch die Testuhr).
    if (intake.prn || !isOpenIntake(intake)) return false;
    const effective = effectiveDue(intake, toDate);
    if (effective && now.getTime() >= effective.getTime() + HOME_MEDS_HIDE_AFTER_MS) return false;
    if (intake.snoozed_until) {
        const until = toDate(intake.snoozed_until);
        if (until) return now.getTime() >= until.getTime();
    }
    const due = toDate(intake.due_at);
    return Boolean(due) && now.getTime() >= (due as Date).getTime() - HOME_MEDS_LEAD_MS;
}

/** Offen und mehr als 30 Minuten ueber der (verschobenen) Zeit: hellroter Rahmen. */
export function isOverdue(intake: HomeIntake, now: Date, toDate: (value: string) => Date | null): boolean {
    if (!isOpenIntake(intake)) return false;
    const due = effectiveDue(intake, toDate);
    return Boolean(due) && now.getTime() > (due as Date).getTime() + HOME_MEDS_OVERDUE_MS;
}

/** "Spaeter erinnern" anbieten? Gleiche Regel wie recipientMaySnoozeIntake auf dem Server. */
export function maySnooze(intake: HomeIntake): boolean {
    if (intake.status !== 'pending' || intake.time_fixed !== false) return false;
    const count = Number(intake.snooze_count ?? 0);
    return Number.isFinite(count) && count >= 0 && count < SNOOZE_MAX;
}

/** Neue Erinnerungszeit nach "Spaeter erinnern": 30 Minuten ab jetzt oder ab der spaeteren Zeit. */
export function snoozeTarget(intake: HomeIntake, now: Date, toDate: (value: string) => Date | null): Date {
    const due = effectiveDue(intake, toDate);
    const base = due && due.getTime() > now.getTime() ? due.getTime() : now.getTime();
    return new Date(base + SNOOZE_MINUTES * 60 * 1000);
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

// ── Block L3 (E21): Termin selbst anlegen ──

/** Gleiche Grenzen wie parseRecipientEvent in server/src/middleware/circle.ts. */
export const RECIPIENT_EVENT_TITLE_MAX = 120;
export const RECIPIENT_EVENT_MAX_YEARS = 2;

export type RecipientEventInput =
    | { ok: true; title: string; start_time: string }
    | { ok: false; error: 'title' | 'date' | 'time' };

/**
 * Eingabe pruefen: Titel, Tag ("YYYY-MM-DD") und Uhrzeit ("HH:MM"), ab heute bis
 * RECIPIENT_EVENT_MAX_YEARS Jahre voraus. start_time geht so an POST /api/events.
 */
export function parseRecipientEventForm(title: string, day: string, time: string, now: Date = new Date()): RecipientEventInput {
    const cleanTitle = title.trim().replace(/\s+/g, ' ');
    if (!cleanTitle || cleanTitle.length > RECIPIENT_EVENT_TITLE_MAX) return { ok: false, error: 'title' };
    const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
    if (!dayMatch) return { ok: false, error: 'date' };
    const [year, month, date] = dayMatch.slice(1).map(Number);
    const startOfDay = new Date(year, month - 1, date);
    if (startOfDay.getFullYear() !== year || startOfDay.getMonth() !== month - 1 || startOfDay.getDate() !== date) {
        return { ok: false, error: 'date' };
    }
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const latest = new Date(today.getFullYear() + RECIPIENT_EVENT_MAX_YEARS, today.getMonth(), today.getDate());
    if (startOfDay.getTime() < today.getTime() || startOfDay.getTime() > latest.getTime()) return { ok: false, error: 'date' };
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(time.trim());
    if (!timeMatch || Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59) return { ok: false, error: 'time' };
    return { ok: true, title: cleanTitle, start_time: `${day.trim()}T${time.trim()}` };
}
