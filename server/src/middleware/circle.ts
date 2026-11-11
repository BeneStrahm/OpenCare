import { Response, NextFunction } from 'express';
import { query } from '../db';
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
 *   (INTAKE_CONFIRMER_ROLES), einzeln oder pro Tageszeit; nicht auslassen,
 *   kein "Bei Bedarf". Eine eigene Bestaetigung (Quelle self) darf sie
 *   RECIPIENT_UNDO_MINUTES lang selbst zuruecksetzen (recipientMayChangeIntake).
 *   Block K (E20): traegt Blutzucker und Gewicht selbst ein (RECIPIENT_VITAL_TYPES,
 *   POST /api/vitals). Nur diese zwei Werte, immer mit der Zeit "jetzt", ohne
 *   Notiz. Einen eigenen Eintrag darf sie RECIPIENT_UNDO_MINUTES lang loeschen
 *   (recipientVitalUndoMsLeft), aendern nicht. Andere Messwerte liest sie nicht.
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
    { method: 'GET', path: /^\/api\/contacts$/ },
    { method: 'GET', path: /^\/api\/visits$/ },
    { method: 'GET', path: /^\/api\/heatwave$/ },
    // Block D: Notfallblatt zum Lesen (dieselben Angaben wie der QR-Code am Kuehlschrank)
    { method: 'GET', path: /^\/api\/emergency\/payload$/ },
    // Block D: Fotos der Familie im Wechsel (nur ansehen)
    { method: 'GET', path: new RegExp(`^/api/view-photos(/${SEGMENT})?$`) },
    // Block E: offene Messwert-Erinnerungen von heute (nur Art und Uhrzeit, keine Werte)
    { method: 'GET', path: /^\/api\/vitals\/reminders\/today$/ },
    // Block K: Blutzucker und Gewicht selbst eintragen, eigene Eintraege 10 Minuten
    // rueckgaengig machen. Die Route prueft Art, Urheber und Zeit (routes/vitals.ts).
    { method: 'POST', path: /^\/api\/vitals$/ },
    { method: 'GET', path: /^\/api\/vitals\/mine\/undoable$/ },
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
 * nur die eigene Bestaetigung (Quelle self, eigenes Konto), hoechstens
 * RECIPIENT_UNDO_MS nach dem Bestaetigen. Sonst 0.
 */
export function recipientUndoMsLeft(intake: IntakeConfirmationInfo, userId: string | undefined): number {
    if (intake.status !== 'taken' || intake.confirmed_source !== 'self') return 0;
    if (!userId || intake.confirmed_by_user !== userId) return 0;
    if (intake.confirmed_age_ms === null || intake.confirmed_age_ms === undefined) return 0;
    const age = Number(intake.confirmed_age_ms);
    if (!Number.isFinite(age) || age < 0) return 0;
    return Math.max(0, RECIPIENT_UNDO_MS - age);
}

/** Darf recipient diese Einnahme auf den Status target setzen? */
export function recipientMayChangeIntake(
    target: string,
    intake: IntakeConfirmationInfo,
    userId: string | undefined
): boolean {
    if (target === 'taken') return intake.status === 'pending' || intake.status === 'missed';
    if (target === 'pending') return recipientUndoMsLeft(intake, userId) > 0;
    return false;
}

/** Block K: diese Messwerte traegt die betreute Person selbst ein. */
export const RECIPIENT_VITAL_TYPES = ['glucose', 'weight'] as const;

export const recipientMayRecordVital = (type: unknown): boolean =>
    typeof type === 'string' && (RECIPIENT_VITAL_TYPES as readonly string[]).includes(type);

/** Felder eines Messwerts, die fuer das Rueckgaengig der betreuten Person zaehlen. */
export interface VitalEntryInfo {
    type: string;
    recorded_by_user?: string | null;
    /** Alter des Eintrags in ms, auf dem Server berechnet (Datenbankzeit). */
    created_age_ms?: number | string | null;
}

/**
 * Restzeit in ms, in der recipient diesen Messwert selbst loeschen darf: nur ein
 * eigener Eintrag (Blutzucker oder Gewicht), hoechstens RECIPIENT_UNDO_MS alt. Sonst 0.
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

        await query('UPDATE caregiver_links SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [link.id]);

        req.caregiverLink = link;
        next();
    } catch {
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};
