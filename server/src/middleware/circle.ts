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
