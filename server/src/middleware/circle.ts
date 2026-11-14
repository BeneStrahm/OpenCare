import { Response, NextFunction } from 'express';
import { query } from '../db';
import { featureEnabledForCircle } from '../lib/features';
import { AuthRequest } from './auth';

export type CircleRole = 'admin' | 'family' | 'professional' | 'neighbor' | 'recipient';

/** Alle gueltigen Rollen (Pruefung bei Einladung und Rollenwechsel). */
export const CIRCLE_ROLES: CircleRole[] = ['admin', 'family', 'professional', 'neighbor', 'recipient'];

/*
 * Rolle recipient ("Betreute Person"), Entscheidung E10, Launch Block B und C.
 * Alle Rechte der Rolle stehen hier, an einer Stelle:
 * - sieht in der App nur die einfache Ansicht (client/src/pages/RecipientView.tsx)
 *   und liest nur ihren Alltag: Termine, Medikamente heute, wichtige Kontakte,
 *   Besuche, Hitzewarnung, Name und Foto, Antworten auf die festen Fragen
 *   von "Fragen Sie mich". Erlaubt ist nur, was in RECIPIENT_ALLOWED_REQUESTS steht;
 *   alles andere lehnt circleMiddleware mit 403 ab (Tagebuch, Arztgespraech,
 *   Dokumente, Gesundheitswerte, Aufgaben, Mitglieder- und Kreisverwaltung, Export ...).
 * - schreibt fast nichts. Ausnahmen: bestaetigt Einnahmen als "Genommen"
 *   (INTAKE_CONFIRMER_ROLES), einzeln oder pro Tageszeit; kein "Bei Bedarf".
 *   Block M (E23): ueberspringt offene Einnahmen (einzeln oder pro Zeitraum,
 *   die Familie bekommt einen Hinweis). "Spaeter erinnern" ist entfernt (14. November).
 *   Eine eigene Bestaetigung oder ein eigenes Ueberspringen (Quelle self) darf sie
 *   RECIPIENT_INTAKE_UNDO_SECONDS lang selbst zuruecksetzen (recipientMayChangeIntake).
 *   Block K (E20, erweitert E47): traegt Blutzucker, Gewicht und Blutdruck selbst ein
 *   (RECIPIENT_VITAL_TYPES, POST /api/vitals), immer mit der Zeit "jetzt", mit Bemerkung,
 *   beim Blutzucker mit Tageszeit und vor/nach dem Essen, beim Blutdruck mit Puls
 *   (parseRecipientVitalEntry, Grenzen gegen Tippfehler RECIPIENT_VITAL_LIMITS).
 *   Einen eigenen Eintrag darf sie RECIPIENT_UNDO_MINUTES lang loeschen
 *   (recipientVitalUndoMsLeft), aendern nicht. Lesen nur diese drei Arten, nur ueber
 *   GET /api/vitals/diary (Tagebuch, je 28 Tage), keine anderen Messwerte.
 *   Block L3 (E21): legt selbst einen Termin an, nur Titel und Beginn, Kategorie
 *   "Sonstige", ohne Serie und ohne Teilnehmende (parseRecipientEvent). Den eigenen
 *   neuen Termin darf sie RECIPIENT_UNDO_MINUTES lang loeschen
 *   (recipientEventUndoMsLeft), andere Termine nie aendern oder loeschen.
 *   Block L4 (E21): Einkaufsliste lesen, etwas hinzufuegen (nur den Namen,
 *   parseRecipientShoppingName) und abhaken. Den eigenen neuen Eintrag darf sie
 *   RECIPIENT_UNDO_MINUTES lang loeschen, das eigene Abhaken so lange zuruecknehmen
 *   (recipientShoppingUndo). Sonst nichts an der Einkaufsliste.
 * - eigenes Konto (Profil, Sprache, Benachrichtigungen) unter /api/auth und
 *   /api/notifications haengt an keinem Kreis und bleibt unberuehrt.
 */

/** So lange darf die betreute Person ihre eigene Bestaetigung rueckgaengig machen. */
export const RECIPIENT_UNDO_MINUTES = 10;
export const RECIPIENT_UNDO_MS = RECIPIENT_UNDO_MINUTES * 60 * 1000;

/** Block M (E23): Rueckgaengig bei Einnahmen (genommen, uebersprungen) nur 30 Sekunden. */
export const RECIPIENT_INTAKE_UNDO_SECONDS = 30;
export const RECIPIENT_INTAKE_UNDO_MS = RECIPIENT_INTAKE_UNDO_SECONDS * 1000;

const SEGMENT = '[^/]+';

/**
 * Anfragen, die recipient in einem Kreis stellen darf (Methode + Pfad ohne Query).
 * Alles, was hier fehlt, ist gesperrt. Die Routen selbst filtern zusaetzlich,
 * was recipient sieht (Dashboard, Kontakte, Mitglieder) oder schreiben darf.
 */
export const RECIPIENT_ALLOWED_REQUESTS: Array<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: RegExp }> = [
    { method: 'GET', path: /^\/api\/dashboard(\/household)?$/ },
    { method: 'GET', path: new RegExp(`^/api/circles/${SEGMENT}(/recipient)?$`) },
    { method: 'GET', path: /^\/api\/events(\/upcoming)?$/ },
    { method: 'GET', path: /^\/api\/medications\/intakes$/ },
    { method: 'PUT', path: new RegExp(`^/api/medications/intakes/${SEGMENT}$`) },
    { method: 'POST', path: /^\/api\/medications\/intakes\/confirm$/ },
    // Block M: ueberspringen, mehrere auf einmal. Die Route prueft den Status (routes/medications.ts).
    { method: 'POST', path: /^\/api\/medications\/intakes\/skip$/ },
    { method: 'GET', path: /^\/api\/contacts$/ },
    { method: 'GET', path: /^\/api\/visits$/ },
    { method: 'GET', path: /^\/api\/heatwave$/ },
    // Block D: Notfallblatt zum Lesen (dieselben Angaben wie der QR-Code am Kuehlschrank)
    { method: 'GET', path: /^\/api\/emergency\/payload$/ },
    // Block D: Fotos der Familie im Wechsel (nur ansehen)
    { method: 'GET', path: new RegExp(`^/api/view-photos(/${SEGMENT})?$`) },
    // Block E: offene Messwert-Erinnerungen von heute (nur Art und Uhrzeit, keine Werte)
    { method: 'GET', path: /^\/api\/vitals\/reminders\/today$/ },
    // Block K, E47: Blutzucker, Gewicht und Blutdruck selbst eintragen, eigene Eintraege 10 Minuten
    // rueckgaengig machen. Die Route prueft Art, Werte, Urheber und Zeit (routes/vitals.ts).
    { method: 'POST', path: /^\/api\/vitals$/ },
    { method: 'GET', path: /^\/api\/vitals\/mine\/undoable$/ },
    // E47: Tagebuch der Gesundheitswerte lesen (Blutzucker, Gewicht, Blutdruck, je 28 Tage).
    { method: 'GET', path: /^\/api\/vitals\/diary$/ },
    { method: 'DELETE', path: new RegExp(`^/api/vitals/${SEGMENT}$`) },
    // Block L3: eigenen Termin anlegen und 10 Minuten rueckgaengig machen.
    // Die Route prueft Felder, Urheber und Zeit (routes/events.ts).
    { method: 'POST', path: /^\/api\/events$/ },
    { method: 'GET', path: /^\/api\/events\/mine\/undoable$/ },
    { method: 'DELETE', path: new RegExp(`^/api/events/${SEGMENT}$`) },
    // Block L4: Einkaufsliste lesen, hinzufuegen, abhaken, 10 Minuten rueckgaengig.
    // Die Route prueft Felder, Urheber und Zeit (routes/shopping.ts).
    { method: 'GET', path: /^\/api\/shopping$/ },
    { method: 'POST', path: /^\/api\/shopping$/ },
    { method: 'PUT', path: new RegExp(`^/api/shopping/${SEGMENT}$`) },
    { method: 'DELETE', path: new RegExp(`^/api/shopping/${SEGMENT}$`) },
    // "Fragen Sie mich": nur die festen Fragen, Antwort ohne KI aus den eigenen Daten
    // (FIXED_QUESTIONS in routes/companion.ts). Keine freie Eingabe.
    { method: 'GET', path: /^\/api\/companion\/answer\/(medications|visitors|appointments|week|date|contacts)$/ },
];

/** Darf recipient diese Anfrage stellen? url ist die volle Adresse (req.originalUrl). */
export function recipientMayAccess(method: string, url: string): boolean {
    const path = (url.split('?')[0] || '').replace(/\/+$/, '');
    return RECIPIENT_ALLOWED_REQUESTS.some((rule) => rule.method === method && rule.path.test(path));
}

/** Felder einer Einnahme, die fuer das Rueckgaengig der betreuten Person zaehlen. */
export interface IntakeConfirmationInfo {
    status: string;
    confirmed_source?: string | null;
    confirmed_by_user?: string | null;
    /** Alter der Bestaetigung in ms, auf dem Server berechnet (Datenbankzeit). */
    confirmed_age_ms?: number | string | null;
}

/**
 * Restzeit in ms, in der recipient diese Einnahme selbst zuruecksetzen darf:
 * nur die eigene Bestaetigung oder das eigene Ueberspringen (Quelle self,
 * eigenes Konto), hoechstens RECIPIENT_INTAKE_UNDO_MS danach. Sonst 0.
 */
export function recipientUndoMsLeft(intake: IntakeConfirmationInfo, userId: string | undefined): number {
    if (intake.status !== 'taken' && intake.status !== 'skipped') return 0;
    if (intake.confirmed_source !== 'self') return 0;
    if (!userId || intake.confirmed_by_user !== userId) return 0;
    if (intake.confirmed_age_ms === null || intake.confirmed_age_ms === undefined) return 0;
    const age = Number(intake.confirmed_age_ms);
    if (!Number.isFinite(age) || age < 0) return 0;
    return Math.max(0, RECIPIENT_INTAKE_UNDO_MS - age);
}

/** Darf recipient diese Einnahme auf den Status target setzen? */
export function recipientMayChangeIntake(
    target: string,
    intake: IntakeConfirmationInfo,
    userId: string | undefined
): boolean {
    if (target === 'taken' || target === 'skipped') return intake.status === 'pending' || intake.status === 'missed';
    if (target === 'pending') return recipientUndoMsLeft(intake, userId) > 0;
    return false;
}

/** Block K, E47: diese Messwerte traegt die betreute Person selbst ein und liest sie im Tagebuch. */
export const RECIPIENT_VITAL_TYPES = ['glucose', 'weight', 'bp'] as const;
export type RecipientVitalType = (typeof RECIPIENT_VITAL_TYPES)[number];

export const recipientMayRecordVital = (type: unknown): boolean =>
    typeof type === 'string' && (RECIPIENT_VITAL_TYPES as readonly string[]).includes(type);

/** E47: Tageszeit einer Blutzucker-Messung (wie im Papierheft) und vor/nach dem Essen. */
export const GLUCOSE_MEAL_TIMES = ['morning', 'noon', 'evening', 'late'] as const;
export const GLUCOSE_MEAL_RELATIONS = ['before', 'after'] as const;
export type GlucoseMealTime = (typeof GLUCOSE_MEAL_TIMES)[number];
export type GlucoseMealRelation = (typeof GLUCOSE_MEAL_RELATIONS)[number];

/** Laengste Bemerkung zu einem Gesundheitswert der betreuten Person. */
export const RECIPIENT_VITAL_NOTE_MAX = 300;

/**
 * Grenzen gegen Tippfehler in der gespeicherten Einheit (gleich in client/src/lib/recipientView.ts).
 * Eigene Annahme, keine medizinische Vorgabe: was ausserhalb liegt, ist fast sicher vertippt.
 * Blutzucker 20 bis 600 mg/dL (0,2 bis 6 g/L), Gewicht 20 bis 250 kg, Blutdruck systolisch
 * 50 bis 260 und diastolisch 30 bis 160 mmHg, Puls 30 bis 220 pro Minute.
 */
export const RECIPIENT_VITAL_LIMITS = {
    glucose: { min: 0.2, max: 6 },
    weight: { min: 20, max: 250 },
    bp: { min: 50, max: 260 },
    bp2: { min: 30, max: 160 },
    pulse: { min: 30, max: 220 },
} as const;

/** Gepruefter Eintrag der betreuten Person, so wie er in vitals gespeichert wird. */
export interface RecipientVitalEntry {
    type: RecipientVitalType;
    value: number;
    value2: number | null;
    pulse: number | null;
    unit: string;
    notes: string | null;
    meal_time: GlucoseMealTime | null;
    meal_relation: GlucoseMealRelation | null;
}

const inLimits = (n: number, limits: { min: number; max: number }) => n >= limits.min && n <= limits.max;
const toNumber = (raw: unknown): number | null => {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
};

/**
 * Tageszeit und vor/nach dem Essen pruefen (nur Blutzucker, alle Rollen).
 * Beides darf fehlen (aeltere Eintraege, Normalansicht). Bei "late" (spaet) gibt es kein vor/nach.
 */
export function parseGlucoseMeal(
    mealTime: unknown, mealRelation: unknown
): { ok: true; meal_time: GlucoseMealTime | null; meal_relation: GlucoseMealRelation | null } | { ok: false } {
    const time = mealTime === undefined || mealTime === null || mealTime === '' ? null : mealTime;
    const relation = mealRelation === undefined || mealRelation === null || mealRelation === '' ? null : mealRelation;
    if (time !== null && !(GLUCOSE_MEAL_TIMES as readonly unknown[]).includes(time)) return { ok: false };
    if (relation !== null && !(GLUCOSE_MEAL_RELATIONS as readonly unknown[]).includes(relation)) return { ok: false };
    if (relation !== null && (time === null || time === 'late')) return { ok: false };
    return { ok: true, meal_time: time as GlucoseMealTime | null, meal_relation: relation as GlucoseMealRelation | null };
}

/**
 * E47: Eintrag der betreuten Person pruefen. Zeit immer "jetzt" (nicht hier), Einheit fest.
 * Blutdruck: value systolisch, value2 diastolisch (Pflicht, kleiner als systolisch), Puls freiwillig.
 * Blutzucker: Tageszeit und vor/nach dem Essen freiwillig (die einfache Ansicht verlangt sie;
 * offline gepufferte Eintraege aelterer Fassungen kommen ohne). Bemerkung freiwillig.
 */
export function parseRecipientVitalEntry(body: unknown): { ok: true; entry: RecipientVitalEntry } | { ok: false; error: string } {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (!recipientMayRecordVital(b.type)) return { ok: false, error: 'Invalid vital type' };
    const type = b.type as RecipientVitalType;
    const value = toNumber(b.value);
    if (value === null || Number.isNaN(value)) return { ok: false, error: 'Invalid value' };
    const limit = type === 'glucose' ? RECIPIENT_VITAL_LIMITS.glucose : type === 'weight' ? RECIPIENT_VITAL_LIMITS.weight : RECIPIENT_VITAL_LIMITS.bp;
    if (!inLimits(value, limit)) return { ok: false, error: 'Invalid value' };

    let value2: number | null = null;
    let pulse: number | null = null;
    if (type === 'bp') {
        value2 = toNumber(b.value2);
        if (value2 === null || Number.isNaN(value2) || !inLimits(value2, RECIPIENT_VITAL_LIMITS.bp2) || value2 >= value) {
            return { ok: false, error: 'Invalid value2' };
        }
        pulse = toNumber(b.pulse);
        if (pulse !== null && (Number.isNaN(pulse) || !inLimits(pulse, RECIPIENT_VITAL_LIMITS.pulse))) {
            return { ok: false, error: 'Invalid pulse' };
        }
    }

    let meal_time: GlucoseMealTime | null = null;
    let meal_relation: GlucoseMealRelation | null = null;
    if (type === 'glucose') {
        const meal = parseGlucoseMeal(b.meal_time, b.meal_relation);
        if (!meal.ok) return { ok: false, error: 'Invalid meal' };
        meal_time = meal.meal_time;
        meal_relation = meal.meal_relation;
    }

    let notes: string | null = null;
    if (b.notes !== undefined && b.notes !== null) {
        if (typeof b.notes !== 'string') return { ok: false, error: 'Invalid notes' };
        const clean = b.notes.replace(/\s+/g, ' ').trim();
        if (clean.length > RECIPIENT_VITAL_NOTE_MAX) return { ok: false, error: 'Invalid notes' };
        notes = clean || null;
    }

    const unit = type === 'glucose' ? 'g/L' : type === 'weight' ? 'kg' : 'mmHg';
    return { ok: true, entry: { type, value, value2, pulse, unit, notes, meal_time, meal_relation } };
}

/** Felder eines Messwerts, die fuer das Rueckgaengig der betreuten Person zaehlen. */
export interface VitalEntryInfo {
    type: string;
    recorded_by_user?: string | null;
    /** Alter des Eintrags in ms, auf dem Server berechnet (Datenbankzeit). */
    created_age_ms?: number | string | null;
}

/**
 * Restzeit in ms, in der recipient diesen Messwert selbst loeschen darf: nur ein
 * eigener Eintrag (Blutzucker, Gewicht oder Blutdruck), hoechstens RECIPIENT_UNDO_MS alt. Sonst 0.
 */
export function recipientVitalUndoMsLeft(vital: VitalEntryInfo, userId: string | undefined): number {
    if (!recipientMayRecordVital(vital.type)) return 0;
    if (!userId || vital.recorded_by_user !== userId) return 0;
    if (vital.created_age_ms === null || vital.created_age_ms === undefined) return 0;
    const age = Number(vital.created_age_ms);
    if (!Number.isFinite(age) || age < 0) return 0;
    return Math.max(0, RECIPIENT_UNDO_MS - age);
}

// ── Block L3 (E21): Termin selbst anlegen ──

/** Laengster Titel eines Termins der betreuten Person. */
export const RECIPIENT_EVENT_TITLE_MAX = 120;

/** So weit voraus darf die betreute Person einen Termin anlegen. */
export const RECIPIENT_EVENT_MAX_YEARS = 2;

/**
 * Eingabe der betreuten Person fuer einen neuen Termin: nur Titel und Beginn
 * ("YYYY-MM-DDTHH:MM", Ortszeit), ab heute bis RECIPIENT_EVENT_MAX_YEARS Jahre voraus.
 * Alles andere im Body wird nicht beachtet. Ungueltig -> null.
 */
export function parseRecipientEvent(body: unknown, now: Date = new Date()): { title: string; start_time: string } | null {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const title = typeof input.title === 'string' ? input.title.trim().replace(/\s+/g, ' ') : '';
    if (!title || title.length > RECIPIENT_EVENT_TITLE_MAX) return null;
    const start = typeof input.start_time === 'string' ? input.start_time.trim() : '';
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(start);
    if (!match) return null;
    const [year, month, day, hour, minute] = match.slice(1).map(Number);
    const date = new Date(year, month - 1, day, hour, minute);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
        || date.getHours() !== hour || date.getMinutes() !== minute) return null;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const latest = new Date(today.getFullYear() + RECIPIENT_EVENT_MAX_YEARS, today.getMonth(), today.getDate(), 23, 59);
    if (date.getTime() < today.getTime() || date.getTime() > latest.getTime()) return null;
    return { title, start_time: `${start}:00` };
}

/** Felder eines Termins, die fuer das Rueckgaengig der betreuten Person zaehlen. */
export interface EventEntryInfo {
    created_by?: string | null;
    rrule?: string | null;
    /** Alter des Termins in ms, auf dem Server berechnet (Datenbankzeit). */
    created_age_ms?: number | string | null;
}

/**
 * Restzeit in ms, in der recipient diesen Termin selbst loeschen darf: nur ein
 * eigener Termin ohne Serie, hoechstens RECIPIENT_UNDO_MS alt. Sonst 0.
 */
export function recipientEventUndoMsLeft(event: EventEntryInfo, userId: string | undefined): number {
    if (!userId || event.created_by !== userId || event.rrule) return 0;
    if (event.created_age_ms === null || event.created_age_ms === undefined) return 0;
    const age = Number(event.created_age_ms);
    if (!Number.isFinite(age) || age < 0) return 0;
    return Math.max(0, RECIPIENT_UNDO_MS - age);
}

// ── Block L4 (E21): Einkaufsliste ──

/** Laengster Name eines Eintrags der betreuten Person. */
export const RECIPIENT_SHOPPING_NAME_MAX = 100;

/** Name eines neuen Eintrags der betreuten Person; leer oder zu lang -> null. */
export function parseRecipientShoppingName(body: unknown): string | null {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    return name && name.length <= RECIPIENT_SHOPPING_NAME_MAX ? name : null;
}

/** Felder eines Eintrags, die fuer das Rueckgaengig der betreuten Person zaehlen. */
export interface ShoppingEntryInfo {
    is_checked?: boolean | null;
    added_by?: string | null;
    checked_by?: string | null;
    /** Alter in ms, auf dem Server berechnet (Datenbankzeit). */
    created_age_ms?: number | string | null;
    checked_age_ms?: number | string | null;
}

const undoLeft = (ageMs: number | string | null | undefined): number => {
    if (ageMs === null || ageMs === undefined) return 0;
    const age = Number(ageMs);
    if (!Number.isFinite(age) || age < 0) return 0;
    return Math.max(0, RECIPIENT_UNDO_MS - age);
};

/**
 * Restzeiten in ms fuer die betreute Person: added = eigenen neuen Eintrag loeschen,
 * checked = eigenes Abhaken zuruecknehmen. Jeweils hoechstens RECIPIENT_UNDO_MS.
 */
export function recipientShoppingUndo(item: ShoppingEntryInfo, userId: string | undefined): { added: number; checked: number } {
    if (!userId) return { added: 0, checked: 0 };
    return {
        added: item.added_by === userId ? undoLeft(item.created_age_ms) : 0,
        checked: item.is_checked && item.checked_by === userId ? undoLeft(item.checked_age_ms) : 0,
    };
}

/** Darf recipient den Eintrag auf abgehakt (true) oder offen (false) setzen? */
export function recipientMayCheckShopping(target: unknown, item: ShoppingEntryInfo, userId: string | undefined): boolean {
    if (target === true) return !item.is_checked;
    if (target === false) return recipientShoppingUndo(item, userId).checked > 0;
    return false;
}

/** Roles allowed to read health data (vitals, medications, documents, digests). */
export const HEALTH_READER_ROLES: CircleRole[] = ['admin', 'family', 'professional', 'recipient'];

/** Roles allowed to read consultations (transcripts and AI drafts are health data). */
export const CONSULTATION_READER_ROLES: CircleRole[] = ['admin', 'family', 'professional'];

export interface CircleRequest extends AuthRequest {
    /** Active care circle, resolved from the X-Circle-Id header or :circleId param */
    circleId?: string;
    /** Membership row id of the logged-in user in the active circle */
    memberId?: string;
    /** Role of the logged-in user in the active circle */
    circleRole?: CircleRole;
}

/**
 * Resolve the active circle and check that the logged-in user is a member.
 * The circle is taken from the :circleId route param when present,
 * otherwise from the X-Circle-Id header (the client sends it on every call).
 * Must run after authMiddleware.
 */
export const circleMiddleware = async (req: CircleRequest, res: Response, next: NextFunction) => {
    try {
        const circleId = (req.params.circleId as string | undefined)
            || (req.headers['x-circle-id'] as string | undefined);

        if (!circleId) {
            return res.status(400).json({ success: false, error: 'Missing circle id' });
        }

        const result = await query(
            'SELECT id, role FROM circle_members WHERE circle_id = $1 AND user_id = $2',
            [circleId, req.userId]
        );

        const membership = result.rows[0] as { id: string; role: CircleRole } | undefined;
        if (!membership) {
            return res.status(403).json({ success: false, error: 'Not a member of this circle' });
        }

        // Betreute Person: nur die freigegebenen Bereiche (siehe RECIPIENT_ALLOWED_REQUESTS).
        if (membership.role === 'recipient' && !recipientMayAccess(req.method, req.originalUrl ?? req.url ?? '')) {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        req.circleId = circleId;
        req.memberId = membership.id;
        req.circleRole = membership.role;
        next();
    } catch {
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

/**
 * Restrict a route to the given roles. Must run after circleMiddleware.
 * Example: requireRole('admin') or requireRole('admin', 'family').
 */
export const requireRole = (...roles: CircleRole[]) => {
    return (req: CircleRequest, res: Response, next: NextFunction) => {
        if (!req.circleRole || !roles.includes(req.circleRole)) {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }
        next();
    };
};

/** Roles allowed to write journal entries (everyone except recipient, see above). */
export const JOURNAL_WRITER_ROLES: CircleRole[] = ['admin', 'family', 'professional', 'neighbor'];

/** Block L4: Einkaufsliste schreiben; recipient nur eingeschraenkt (routes/shopping.ts). */
export const SHOPPING_WRITER_ROLES: CircleRole[] = [...JOURNAL_WRITER_ROLES, 'recipient'];

/**
 * Roles allowed to confirm medication intakes. recipient may only mark them taken,
 * and undo her own confirmation for a short while (recipientMayChangeIntake).
 * neighbor ("Freunde") is left out: it reads no health data, so it confirms no intakes either.
 */
export const INTAKE_CONFIRMER_ROLES: CircleRole[] = ['admin', 'family', 'professional', 'recipient'];

/** Roles allowed to manage circle content (calendar, tasks, documents...). */
export const CONTENT_WRITER_ROLES: CircleRole[] = ['admin', 'family'];

/**
 * Journal entry types a neighbor never reads: they carry health data (readings,
 * doses taken, and incidents, whose text can describe a pain or a fall).
 * Applied wherever journal entries are listed, not only on /api/journal.
 */
export const NEIGHBOR_HIDDEN_JOURNAL_TYPES = ['vital', 'medication', 'incident'];

/** Convenience guards matching the permission matrix in docs/SPEC.md. */
export const requireAdmin = requireRole('admin');
export const requireContentWriter = requireRole(...CONTENT_WRITER_ROLES);
export const requireJournalWriter = requireRole(...JOURNAL_WRITER_ROLES);

export interface CaregiverLinkRequest extends AuthRequest {
    caregiverLink?: {
        id: string;
        circle_id: string;
        display_name: string;
        role_label?: string;
    };
}

/**
 * Authenticate an external caregiver through a magic link token (no account).
 * The token comes from the :linkToken route param. Grants a limited scope:
 * write journal entries, read today's overview.
 */
export const caregiverLinkMiddleware = async (req: CaregiverLinkRequest, res: Response, next: NextFunction) => {
    try {
        const token = req.params.linkToken as string | undefined;
        if (!token || token.length < 16) {
            return res.status(401).json({ success: false, error: 'Invalid link' });
        }

        const result = await query(
            `SELECT id, circle_id, display_name, role_label
             FROM caregiver_links
             WHERE token = $1
               AND revoked = FALSE
               AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
            [token]
        );

        const link = result.rows[0];
        if (!link) {
            return res.status(401).json({ success: false, error: 'Invalid or expired link' });
        }

        // Fork: Links gehoeren zum Pflegetagebuch. Ist es aus, ruht jeder Link.
        if (!(await featureEnabledForCircle(link.circle_id, 'journal'))) {
            return res.status(403).json({ success: false, error: 'FEATURE_DISABLED' });
        }

        await query('UPDATE caregiver_links SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [link.id]);

        req.caregiverLink = link;
        next();
    } catch {
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};
