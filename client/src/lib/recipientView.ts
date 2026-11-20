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

/**
 * Einnahmen in Karten aufteilen. Bedarfsmedikamente (prn) zeigt die einfache Ansicht nie.
 * E58: "Heute" am PC und Handy nutzt dieselbe Aufteilung und zeigt eingetragene
 * Bedarfs-Einnahmen wie bisher unter ihrer Tageszeit (prnByMoment).
 */
export function groupIntakes<T extends GroupableIntake>(
    intakes: readonly T[],
    toDate: (value: string) => Date | null,
    options: { prnByMoment?: boolean } = {}
): Array<{ group: IntakeGroup; items: T[] }> {
    const groups = new Map<string, { group: IntakeGroup; items: T[] }>();
    for (const intake of intakes) {
        if (intake.prn && !options.prnByMoment) continue;
        const group = intakeGroupOf(toDate(intake.due_at), intake.prn ? false : intake.time_fixed);
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
export interface HomeIntake {
    due_at: string;
    status: 'pending' | 'taken' | 'skipped' | 'missed';
    prn?: boolean;
    time_fixed?: boolean;
    snoozed_until?: string | null;
    snooze_count?: number | string | null;
}

const isOpenIntake = (i: HomeIntake) => i.status === 'pending' || i.status === 'missed';

/** Faellig ab: die geplante Zeit, bei alten Eintraegen mit "Spaeter erinnern" (entfernt) die verschobene. */
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

/**
 * Grundgroesse der einfachen Ansicht (Roadmap Punkt 16): alle rem-Groessen x 0,8, gesetzt als
 * Prozent auf <html>, solange die Ansicht offen ist. Am Tablet (853 px bei hoechstem Bildschirmzoom)
 * sieht sie damit bei Chrome-Zoom 100 % aus wie vorher bei 80 %. Prozent statt px, damit die
 * Textvergroesserung des Browsers erhalten bleibt. Umbrueche in RecipientView.tsx ebenfalls x 0,8
 * (512, 614, 819 px statt sm, md, lg).
 */
export const VIEW_SCALE = 0.8;

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

// ── Block K (E20), E47: Blutzucker, Gewicht und Blutdruck selbst eintragen ──

/** Diese Messwerte traegt die betreute Person selbst ein (wie RECIPIENT_VITAL_TYPES im Server). */
export const RECIPIENT_VITAL_TYPES = ['glucose', 'weight', 'bp'] as const;
export type RecipientVitalType = (typeof RECIPIENT_VITAL_TYPES)[number];

/** E47: Tageszeit einer Blutzucker-Messung und vor/nach dem Essen (wie GLUCOSE_MEAL_* im Server). */
export const GLUCOSE_MEAL_TIMES = ['morning', 'noon', 'evening', 'late'] as const;
export const GLUCOSE_MEAL_RELATIONS = ['before', 'after'] as const;
export type GlucoseMealTime = (typeof GLUCOSE_MEAL_TIMES)[number];
export type GlucoseMealRelation = (typeof GLUCOSE_MEAL_RELATIONS)[number];

/** Laengste Bemerkung (wie RECIPIENT_VITAL_NOTE_MAX im Server). */
export const RECIPIENT_VITAL_NOTE_MAX = 300;

/**
 * Grenzen gegen Tippfehler, in der gespeicherten Einheit (wie RECIPIENT_VITAL_LIMITS im Server).
 * Eigene Annahme, keine medizinische Vorgabe: was ausserhalb liegt, ist fast sicher vertippt.
 * Blutzucker 20 bis 600 mg/dL, Gewicht 20 bis 250 kg, Blutdruck systolisch 50 bis 260 und
 * diastolisch 30 bis 160 mmHg, Puls 30 bis 220 pro Minute.
 */
export const RECIPIENT_VITAL_LIMITS = {
    glucose: { min: 0.2, max: 6 },
    weight: { min: 20, max: 250 },
    bp: { min: 50, max: 260 },
    bp2: { min: 30, max: 160 },
    pulse: { min: 30, max: 220 },
} as const;
export type RecipientVitalLimit = keyof typeof RECIPIENT_VITAL_LIMITS;

/** Fehler einer Zahl: leer, falsche Schreibweise, ausserhalb der Grenzen. */
export type RecipientNumberError = 'empty' | 'format' | 'range';

export type RecipientVitalInput =
    | { ok: true; shown: number; stored: number }
    | { ok: false; error: RecipientNumberError };

/** Nachkommastellen bei der Eingabe: Gewicht eine, sonst keine. */
export const vitalInputDecimals = (limit: RecipientVitalLimit): number => (limit === 'weight' ? 1 : 0);

/**
 * Eine Zahl pruefen: Komma oder Punkt als Dezimalzeichen, Leerzeichen egal, nur Ziffern,
 * beim Gewicht hoechstens eine Stelle nach dem Komma. toStorage rechnet die angezeigte
 * Einheit in die gespeicherte um (lib/units.ts); die Grenzen gelten fuer den gespeicherten Wert.
 */
export function parseRecipientVital(
    limit: RecipientVitalLimit,
    text: string,
    toStorage: (shown: number) => number
): RecipientVitalInput {
    const clean = text.replace(/\s+/g, '').replace(',', '.');
    if (!clean) return { ok: false, error: 'empty' };
    const decimals = vitalInputDecimals(limit);
    const pattern = decimals > 0 ? new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`) : /^\d+$/;
    if (!pattern.test(clean)) return { ok: false, error: 'format' };
    const shown = Number(clean);
    const stored = toStorage(shown);
    const { min, max } = RECIPIENT_VITAL_LIMITS[limit];
    if (!Number.isFinite(stored) || stored < min || stored > max) return { ok: false, error: 'range' };
    return { ok: true, shown, stored };
}

/** Eingaben der Seite "... eintragen" (E47). */
export interface RecipientVitalFormInput {
    type: RecipientVitalType;
    /** Blutzucker, Gewicht oder Blutdruck systolisch */
    text: string;
    /** Blutdruck diastolisch */
    text2: string;
    /** Blutdruck: Puls, freiwillig */
    pulse: string;
    note: string;
    mealTime: GlucoseMealTime | null;
    mealRelation: GlucoseMealRelation | null;
}

export type RecipientVitalField = 'value' | 'value2' | 'pulse' | 'mealTime' | 'mealRelation';
export type RecipientVitalFieldError = RecipientNumberError | 'order' | 'choose';
export type RecipientVitalErrors = Partial<Record<RecipientVitalField, RecipientVitalFieldError>>;

/** So geht der Eintrag an POST /api/vitals (Werte in der gespeicherten Einheit). */
export interface RecipientVitalPayload {
    type: RecipientVitalType;
    value: number;
    value2: number | null;
    pulse: number | null;
    notes: string | null;
    meal_time: GlucoseMealTime | null;
    meal_relation: GlucoseMealRelation | null;
}

/**
 * Ganze Eingabe pruefen. Blutzucker: Tageszeit Pflicht, vor/nach dem Essen Pflicht ausser bei
 * "Spaet" (dann faellt die Frage weg). Blutdruck: beide Werte Pflicht, systolisch groesser als
 * diastolisch, Puls freiwillig. Bemerkung freiwillig, Leerzeichen zusammengezogen.
 */
export function checkRecipientVitalForm(
    input: RecipientVitalFormInput,
    toStorage: (shown: number) => number
): { ok: true; payload: RecipientVitalPayload } | { ok: false; errors: RecipientVitalErrors } {
    const errors: RecipientVitalErrors = {};
    const first = parseRecipientVital(input.type, input.text, toStorage);
    if (!first.ok) errors.value = first.error;

    let value2: number | null = null;
    let pulse: number | null = null;
    if (input.type === 'bp') {
        const second = parseRecipientVital('bp2', input.text2, (n) => n);
        if (!second.ok) errors.value2 = second.error;
        else value2 = second.stored;
        if (first.ok && second.ok && second.stored >= first.stored) errors.value2 = 'order';
        if (input.pulse.trim()) {
            const p = parseRecipientVital('pulse', input.pulse, (n) => n);
            if (!p.ok) errors.pulse = p.error;
            else pulse = p.stored;
        }
    }

    let mealTime: GlucoseMealTime | null = null;
    let mealRelation: GlucoseMealRelation | null = null;
    if (input.type === 'glucose') {
        if (!input.mealTime) errors.mealTime = 'choose';
        else mealTime = input.mealTime;
        if (input.mealTime !== 'late') {
            if (!input.mealRelation) errors.mealRelation = 'choose';
            else mealRelation = input.mealRelation;
        }
    }

    if (!first.ok || Object.keys(errors).length > 0) return { ok: false, errors };
    const note = input.note.replace(/\s+/g, ' ').trim().slice(0, RECIPIENT_VITAL_NOTE_MAX);
    return {
        ok: true,
        payload: {
            type: input.type,
            value: first.stored,
            value2,
            pulse,
            notes: note || null,
            meal_time: mealTime,
            meal_relation: mealRelation,
        },
    };
}

/** E47: ein Wert im Tagebuch (GET /api/vitals/diary). */
export interface DiaryEntry {
    id: string;
    type: RecipientVitalType;
    value: number;
    value2: number | null;
    pulse: number | null;
    measured_at: string;
    notes: string | null;
    meal_time: GlucoseMealTime | null;
    meal_relation: GlucoseMealRelation | null;
}

/** Spalte einer Blutzucker-Zeile: Tageszeit plus vor/nach, "late" ohne vor/nach. */
export type GlucoseSlot = 'morning-before' | 'morning-after' | 'noon-before' | 'noon-after' | 'evening-before' | 'evening-after' | 'late';
export const GLUCOSE_SLOTS: GlucoseSlot[] = ['morning-before', 'morning-after', 'noon-before', 'noon-after', 'evening-before', 'evening-after', 'late'];

export const glucoseSlotOf = (entry: Pick<DiaryEntry, 'meal_time' | 'meal_relation'>): GlucoseSlot | null => {
    if (entry.meal_time === 'late') return 'late';
    if (!entry.meal_time || !entry.meal_relation) return null;
    return `${entry.meal_time}-${entry.meal_relation}` as GlucoseSlot;
};

/** Eine Zeile der Blutzucker-Tabelle (wie das Papierheft): ein Tag, Werte je Spalte. */
export interface GlucoseDayRow {
    day: string;
    slots: Partial<Record<GlucoseSlot, DiaryEntry[]>>;
    /** Werte ohne Tageszeit (z. B. am PC eingetragen), stehen bei der Bemerkung */
    untimed: DiaryEntry[];
    /** Werte mit Bemerkung, aelteste zuerst; die Tabelle zeigt die Uhrzeit davor (E48) */
    notes: DiaryEntry[];
}

/**
 * Blutzucker-Werte (neueste zuerst) nach Tag gruppieren. dayOf liefert den Tag eines
 * Werts als "YYYY-MM-DD". In einer Spalte stehen mehrere Werte eines Tages untereinander,
 * aelteste zuerst; die Tage bleiben neueste zuerst.
 */
export function groupGlucoseDays(entries: DiaryEntry[], dayOf: (entry: DiaryEntry) => string): GlucoseDayRow[] {
    const rows: GlucoseDayRow[] = [];
    const byDay = new Map<string, GlucoseDayRow>();
    for (const entry of entries) {
        const day = dayOf(entry);
        let row = byDay.get(day);
        if (!row) {
            row = { day, slots: {}, untimed: [], notes: [] };
            byDay.set(day, row);
            rows.push(row);
        }
        const slot = glucoseSlotOf(entry);
        if (slot) {
            const list = row.slots[slot] ?? [];
            list.unshift(entry);
            row.slots[slot] = list;
        } else {
            row.untimed.unshift(entry);
        }
        if (entry.notes) row.notes.unshift(entry);
    }
    return rows;
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
