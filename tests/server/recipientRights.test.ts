import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Response } from 'express';

/**
 * Rechte der betreuten Person (Rolle recipient), Launch Block B und C.
 * Ohne Datenbank: die Abfrage der Mitgliedschaft in circleMiddleware wird ersetzt,
 * die Regeln (Liste der erlaubten Anfragen, Rueckgaengig) laufen direkt.
 */

const membership = vi.hoisted(() => ({ role: 'recipient' as string }));

/** Block K: Ersatz fuer die Tabelle vitals, nur in den Tests der Route gesetzt. */
const vitalsDb = vi.hoisted(() => ({
    handler: null as null | ((sql: string, params: unknown[]) => { rows: unknown[] }),
}));

vi.mock('../../server/src/db', () => ({
    query: async (sql: string, params: unknown[] = []) => {
        if (vitalsDb.handler && !sql.includes('FROM circle_members')) return vitalsDb.handler(sql, params);
        return { rows: [{ id: 'mitglied-1', role: membership.role }] };
    },
    getClient: async () => { throw new Error('keine Datenbank im Test'); },
}));

// Block K: Anmeldung ohne Token (Konto aus dem Kopf x-test-user), keine Push- oder Live-Meldungen.
vi.mock('../../server/src/middleware/auth', () => ({
    authMiddleware: (req: { headers: Record<string, unknown>; userId?: string }, _res: unknown, next: () => void) => {
        req.userId = req.headers['x-test-user'] as string;
        next();
    },
}));
vi.mock('../../server/src/lib/broadcaster', () => ({ broadcastToCircle: async () => {}, broadcast: () => {} }));
vi.mock('../../server/src/lib/notifications', () => ({ createNotification: async () => {} }));

import {
    circleMiddleware,
    recipientMayAccess,
    recipientMayChangeIntake,
    recipientUndoMsLeft,
    INTAKE_CONFIRMER_ROLES,
    parseRecipientEvent,
    recipientEventUndoMsLeft,
    parseRecipientShoppingName,
    recipientShoppingUndo,
    recipientMayCheckShopping,
    requireAdmin,
    SHOPPING_WRITER_ROLES,
    CIRCLE_ROLES,
    RECIPIENT_UNDO_MINUTES,
    RECIPIENT_UNDO_MS,
    RECIPIENT_INTAKE_UNDO_SECONDS,
    RECIPIENT_INTAKE_UNDO_MS,
    RECIPIENT_VITAL_TYPES,
    RECIPIENT_VITAL_LIMITS as SERVER_RECIPIENT_VITAL_LIMITS,
    GLUCOSE_MEAL_TIMES,
    GLUCOSE_MEAL_RELATIONS,
    RECIPIENT_VITAL_NOTE_MAX,
    recipientMayRecordVital,
    recipientVitalUndoMsLeft,
    parseGlucoseMeal,
    type CircleRequest,
    type CircleRole,
} from '../../server/src/middleware/circle';
import vitalsRouter from '../../server/src/routes/vitals';
import {
    RECIPIENT_VITAL_TYPES as CLIENT_RECIPIENT_VITAL_TYPES,
    RECIPIENT_VITAL_LIMITS,
    GLUCOSE_MEAL_TIMES as CLIENT_GLUCOSE_MEAL_TIMES,
    GLUCOSE_MEAL_RELATIONS as CLIENT_GLUCOSE_MEAL_RELATIONS,
    RECIPIENT_VITAL_NOTE_MAX as CLIENT_RECIPIENT_VITAL_NOTE_MAX,
    parseRecipientVital,
    checkRecipientVitalForm,
    groupGlucoseDays,
    type DiaryEntry,
    type RecipientVitalFormInput,
} from '../../client/src/lib/recipientView';

const run = async (role: CircleRole, method: string, url: string) => {
    membership.role = role;
    let status = 200;
    let passed = false;
    const res = {
        status(code: number) { status = code; return this; },
        json() { return this; },
    } as unknown as Response;
    const req = {
        method,
        originalUrl: url,
        url,
        params: {},
        headers: { 'x-circle-id': 'kreis-1' },
        userId: 'konto-1',
    } as unknown as CircleRequest;
    await circleMiddleware(req, res, () => { passed = true; });
    return { status, passed };
};

/** Gesperrt fuer recipient: alles ausserhalb ihres Alltags, und jedes Schreiben. */
const BLOCKED: Array<[string, string]> = [
    ['GET', '/api/journal'],
    ['POST', '/api/journal'],
    // E59: Arztgespraech nur vorbereiten, aufnehmen, lesen; nicht pruefen, freigeben.
    ['GET', '/api/consultations/vocabulary'],
    ['PUT', '/api/consultations/gespraech-1/summary'],
    ['POST', '/api/consultations/gespraech-1/summary/approve'],
    ['POST', '/api/consultations/gespraech-1/transcript/approve'],
    ['PUT', '/api/consultations/gespraech-1/transcript'],
    ['PUT', '/api/consultations/gespraech-1/questions/frage-1'],
    ['DELETE', '/api/consultations/gespraech-1'],
    ['DELETE', '/api/consultations/recordings/aufnahme-1/audio'],
    ['POST', '/api/consultations/recordings/aufnahme-1/retry'],
    ['GET', '/api/documents'],
    ['GET', '/api/vitals'],
    ['GET', '/api/tasks'],
    // Block K: Gesundheitswerte nur eintragen und Eigenes loeschen, nie aendern, keine Werte lesen.
    ['PUT', '/api/vitals/vital-1'],
    ['GET', '/api/vitals/vital-1'],
    ['GET', '/api/vitals/latest'],
    ['GET', '/api/vitals/thresholds'],
    ['PUT', '/api/vitals/thresholds'],
    ['PUT', '/api/vitals/reminders'],
    ['GET', '/api/vitals/mine'],
    ['POST', '/api/vitals/extra'],
    ['DELETE', '/api/vitals/vital-1/extra'],
    // Block L4: an der Einkaufsliste nur lesen, hinzufuegen, abhaken (kein Leeren, keine Unterpfade).
    ['DELETE', '/api/shopping/checked/clear'],
    ['PUT', '/api/shopping/eintrag-1/extra'],
    ['GET', '/api/expenses'],
    ['GET', '/api/messages'],
    ['GET', '/api/notes'],
    ['GET', '/api/story'],
    ['GET', '/api/handover'],
    ['GET', '/api/care-plan'],
    ['GET', '/api/digests'],
    ['GET', '/api/insights'],
    ['GET', '/api/emergency/sheet'],
    // Block D: Fotos verwalten nur Familie und Admin.
    ['POST', '/api/view-photos'],
    ['DELETE', '/api/view-photos/foto-1'],
    ['GET', '/api/view-photos/foto-1/extra'],
    ['GET', '/api/invites'],
    ['GET', '/api/caregiver-links'],
    ['GET', '/api/integrations'],
    ['GET', '/api/escalation/rules'],
    ['GET', '/api/presence/status'],
    ['GET', '/api/ai/settings'],
    ['GET', '/api/data/export'],
    ['POST', '/api/data/import'],
    ['GET', '/api/medications'],
    ['GET', '/api/medications/prescriptions'],
    ['POST', '/api/medications/med-1/intakes'],
    ['PUT', '/api/medications/med-1/stock'],
    // Block M: nur ueberspringen, keine Unterpfade, kein Lesen. "Spaeter erinnern" ist entfernt.
    ['POST', '/api/medications/intakes/skip/extra'],
    ['POST', '/api/medications/intakes/snooze'],
    ['GET', '/api/medications/intakes/snooze'],
    ['POST', '/api/medications/intakes/snoozex'],
    ['DELETE', '/api/medications/intakes/einnahme-1'],
    // Block L3: Termine nur anlegen und den eigenen loeschen, nie aendern, keine Serien-Ausnahmen.
    ['PUT', '/api/events/termin-1'],
    ['PUT', '/api/events/termin-1/occurrences/2026-11-12'],
    ['DELETE', '/api/events/termin-1/occurrences/2026-11-12'],
    ['GET', '/api/events/mine'],
    ['PUT', '/api/contacts/kontakt-1'],
    ['DELETE', '/api/visits/besuch-1'],
    ['PUT', '/api/heatwave'],
    ['POST', '/api/heatwave/toggle'],
    ['PUT', '/api/circles/kreis-1'],
    ['PUT', '/api/circles/kreis-1/recipient'],
    ['PUT', '/api/circles/kreis-1/members/mitglied-2'],
    ['DELETE', '/api/circles/kreis-1/members/mitglied-2'],
    ['POST', '/api/kiosk/status'],
    ['POST', '/api/kiosk/intakes/confirm'],
    ['POST', '/api/kiosk/visits/check-in'],
    ['GET', '/api/kiosk/devices'],
    // Launch Block C: Kiosk entfernt, die einfache Ansicht nutzt nur die normalen Routen.
    ['GET', '/api/kiosk/today'],
    ['GET', '/api/kiosk/emergency'],
    ['GET', '/api/kiosk/photo'],
    ['POST', '/api/kiosk/pin/verify'],
    // Sprechen ist nicht Teil der einfachen Ansicht.
    ['POST', '/api/voice-commands/parse'],
    ['POST', '/api/voice-commands/execute'],
    // Fragen Sie mich: keine freie Eingabe, keine Themen ausserhalb ihres Alltags.
    ['POST', '/api/companion/message'],
    ['POST', '/api/companion/answer/medications'],
    ['GET', '/api/companion/answer/tasks'],
    ['GET', '/api/companion/answer/vitals'],
    ['GET', '/api/companion/answer/stock'],
    ['GET', '/api/companion/answer/help'],
    ['GET', '/api/companion/answer'],
    ['POST', '/api/voice/transcribe'],
    ['POST', '/api/voice/journal'],
    ['HEAD', '/api/journal'],
];

/** Erlaubt fuer recipient: ihr Alltag wie in der Tablet-Ansicht, und Einnahmen bestaetigen. */
const ALLOWED: Array<[string, string]> = [
    ['GET', '/api/dashboard'],
    ['GET', '/api/dashboard/household'],
    ['GET', '/api/circles/kreis-1'],
    ['GET', '/api/circles/kreis-1/recipient'],
    ['GET', '/api/events?from=2026-11-01&to=2026-11-30'],
    ['GET', '/api/events/upcoming'],
    ['GET', '/api/medications/intakes'],
    ['GET', '/api/medications/intakes?from=2026-11-10'],
    ['PUT', '/api/medications/intakes/einnahme-1'],
    ['POST', '/api/medications/intakes/confirm'],
    // Block M: ueberspringen (Route prueft den Status)
    ['POST', '/api/medications/intakes/skip'],
    ['GET', '/api/contacts'],
    ['GET', '/api/contacts/'],
    ['GET', '/api/visits'],
    ['GET', '/api/heatwave'],
    ['GET', '/api/companion/answer/medications'],
    ['GET', '/api/companion/answer/visitors'],
    ['GET', '/api/companion/answer/appointments'],
    ['GET', '/api/companion/answer/week'],
    ['GET', '/api/companion/answer/date'],
    ['GET', '/api/companion/answer/contacts'],
    // Block D: Notfallblatt lesen, Fotos ansehen
    ['GET', '/api/emergency/payload'],
    ['GET', '/api/view-photos'],
    ['GET', '/api/view-photos/foto-1'],
    // Block L3: eigenen Termin anlegen und 10 Minuten rueckgaengig (Route prueft Felder, Urheber, Zeit)
    ['POST', '/api/events'],
    ['GET', '/api/events/mine/undoable'],
    ['GET', '/api/events/people'],
    ['GET', '/api/consultations'],
    ['POST', '/api/consultations'],
    ['GET', '/api/consultations/gespraech-1'],
    ['PUT', '/api/consultations/gespraech-1'],
    ['POST', '/api/consultations/gespraech-1/questions'],
    ['DELETE', '/api/consultations/gespraech-1/questions/frage-1'],
    ['POST', '/api/consultations/recordings'],
    ['GET', '/api/consultations/recordings/aufnahme-1'],
    ['PUT', '/api/consultations/recordings/aufnahme-1/chunks/3'],
    ['POST', '/api/consultations/recordings/aufnahme-1/complete'],
    ['GET', '/api/consultations/recordings/aufnahme-1/audio'],
    ['DELETE', '/api/events/termin-1'],
    // Block L4: Einkaufsliste lesen, hinzufuegen, abhaken, eigenes rueckgaengig
    ['GET', '/api/shopping'],
    ['POST', '/api/shopping'],
    ['PUT', '/api/shopping/eintrag-1'],
    ['DELETE', '/api/shopping/eintrag-1'],
    // Block E und K: Erinnerung zum Messen, Blutzucker und Gewicht eintragen, eigenes rueckgaengig
    ['GET', '/api/vitals/reminders/today'],
    ['POST', '/api/vitals'],
    ['GET', '/api/vitals/mine/undoable'],
    ['DELETE', '/api/vitals/vital-1'],
    // E47: Tagebuch der Gesundheitswerte (Route prueft Art und Tag)
    ['GET', '/api/vitals/diary'],
];

describe('recipient: gesperrte Bereiche (403 auf dem Server)', () => {
    it.each(BLOCKED)('%s %s -> 403', async (method, url) => {
        expect(await run('recipient', method, url)).toEqual({ status: 403, passed: false });
        expect(recipientMayAccess(method, url)).toBe(false);
    });

    it('laesst sich nicht mit Pfadtricks umgehen', () => {
        expect(recipientMayAccess('GET', '/api/medications/intakes/../../journal')).toBe(false);
        expect(recipientMayAccess('GET', '/api/contacts/kontakt-1/../../journal')).toBe(false);
        expect(recipientMayAccess('GET', '/api/journal?x=/api/contacts')).toBe(false);
        expect(recipientMayAccess('GET', '/api/dashboardx')).toBe(false);
        expect(recipientMayAccess('GET', '')).toBe(false);
        expect(recipientMayAccess('GET', '/api/companion/answer/medications/../../journal')).toBe(false);
        expect(recipientMayAccess('GET', '/api/companion/answer/medicationsx')).toBe(false);
        expect(recipientMayAccess('GET', '/api/companion/answer/date/extra')).toBe(false);
    });
});

describe('recipient: erlaubte Bereiche', () => {
    it.each(ALLOWED)('%s %s -> weiter', async (method, url) => {
        expect(await run('recipient', method, url)).toEqual({ status: 200, passed: true });
    });
});

describe('andere Rollen: die Sperrliste gilt nur fuer recipient', () => {
    it('admin, family, professional und neighbor kommen am Kreis-Pruefer vorbei', async () => {
        for (const role of CIRCLE_ROLES.filter((r) => r !== 'recipient')) {
            expect(await run(role, 'GET', '/api/journal'), role).toEqual({ status: 200, passed: true });
        }
    });
});

describe('Rueckgaengig der betreuten Person', () => {
    const own = (ageMs: number | string | null) => ({
        status: 'taken', confirmed_source: 'self', confirmed_by_user: 'konto-1', confirmed_age_ms: ageMs,
    });

    it('10 Minuten an einer Stelle', () => {
        expect(RECIPIENT_UNDO_MINUTES).toBe(10);
        expect(RECIPIENT_UNDO_MS).toBe(10 * 60 * 1000);
        // Block M: bei Einnahmen nur 30 Sekunden
        expect(RECIPIENT_INTAKE_UNDO_SECONDS).toBe(30);
        expect(RECIPIENT_INTAKE_UNDO_MS).toBe(30 * 1000);
    });

    it('erlaubt bei Einnahmen innerhalb von 30 Sekunden', () => {
        expect(recipientMayChangeIntake('pending', own(0), 'konto-1')).toBe(true);
        expect(recipientMayChangeIntake('pending', own(29_000), 'konto-1')).toBe(true);
        expect(recipientMayChangeIntake('pending', own(31_000), 'konto-1')).toBe(false);
        // Aus der Datenbank kommt EXTRACT(...) als Text.
        expect(recipientMayChangeIntake('pending', own('12000.5'), 'konto-1')).toBe(true);
        expect(recipientUndoMsLeft(own(10_000), 'konto-1')).toBe(RECIPIENT_INTAKE_UNDO_MS - 10_000);
    });

    it('lehnt bei Einnahmen nach 30 Sekunden ab', () => {
        expect(recipientMayChangeIntake('pending', own(RECIPIENT_INTAKE_UNDO_MS), 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', own(RECIPIENT_INTAKE_UNDO_MS + 1), 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', own(60 * 60 * 1000), 'konto-1')).toBe(false);
        expect(recipientUndoMsLeft(own(RECIPIENT_INTAKE_UNDO_MS + 1), 'konto-1')).toBe(0);
    });

    it('nur eigene Bestaetigungen mit Quelle self', () => {
        expect(recipientMayChangeIntake('pending', { ...own(1000), confirmed_by_user: 'konto-2' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', own(1000), undefined)).toBe(false);
        for (const source of ['caregiver', 'kiosk', 'phone', 'link', null]) {
            expect(recipientMayChangeIntake('pending', { ...own(1000), confirmed_source: source }, 'konto-1'), String(source)).toBe(false);
        }
    });

    it('nur genommene oder uebersprungene Einnahmen, mit gueltiger Zeit', () => {
        // Block M: das eigene Ueberspringen laesst sich 30 Sekunden zuruecknehmen.
        expect(recipientMayChangeIntake('pending', { ...own(1000), status: 'skipped' }, 'konto-1')).toBe(true);
        expect(recipientMayChangeIntake('pending', { ...own(RECIPIENT_INTAKE_UNDO_MS + 1), status: 'skipped' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', { ...own(1000), status: 'skipped', confirmed_source: 'caregiver' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', { ...own(1000), status: 'missed' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', { ...own(1000), status: 'pending' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', own(null), 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', own(-5000), 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', own('kaputt'), 'konto-1')).toBe(false);
    });

    it('bestaetigt und ueberspringt nur offene Einnahmen (Block M)', () => {
        expect(recipientMayChangeIntake('taken', { status: 'pending' }, 'konto-1')).toBe(true);
        expect(recipientMayChangeIntake('taken', { status: 'missed' }, 'konto-1')).toBe(true);
        expect(recipientMayChangeIntake('taken', { status: 'taken' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('taken', { status: 'skipped' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('skipped', { status: 'pending' }, 'konto-1')).toBe(true);
        expect(recipientMayChangeIntake('skipped', { status: 'missed' }, 'konto-1')).toBe(true);
        expect(recipientMayChangeIntake('skipped', { status: 'taken' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('skipped', { status: 'skipped' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('missed', { status: 'pending' }, 'konto-1')).toBe(false);
    });
});

describe('Block M: Einnahmen', () => {
    it('Einnahmen bestaetigen und ueberspringen alle ausser Freunde (neighbor)', () => {
        expect([...INTAKE_CONFIRMER_ROLES].sort()).toEqual(['admin', 'family', 'professional', 'recipient']);
        expect(INTAKE_CONFIRMER_ROLES).not.toContain('neighbor');
    });
});

describe('Kreisverwaltung nur fuer admin', () => {
    let status: number;
    let passed: boolean;
    const res = {
        status(code: number) { status = code; return this; },
        json() { return this; },
    } as unknown as Response;
    beforeEach(() => { status = 200; passed = false; });

    it('requireAdmin (Einladungen, Mitglieder, Kreis) laesst nur admin durch', () => {
        for (const role of CIRCLE_ROLES) {
            status = 200; passed = false;
            requireAdmin({ circleRole: role } as CircleRequest, res, () => { passed = true; });
            expect({ role, status, passed }).toEqual(
                role === 'admin' ? { role, status: 200, passed: true } : { role, status: 403, passed: false }
            );
        }
    });
});

describe('Block L3: Termin der betreuten Person', () => {
    const now = new Date(2026, 10, 11, 21, 0);

    it('nimmt Titel und Beginn, ab heute bis 2 Jahre voraus, ohne Art gilt Sonstige', () => {
        expect(parseRecipientEvent({ title: '  Friseur  ', start_time: '2026-11-12T10:30', notes: 'x', rrule: 'FREQ=DAILY' }, now))
            .toEqual({
                title: 'Friseur', start_time: '2026-11-12T10:30:00', category: 'other', location: null,
                companion_needed: false, member_ids: [], guests: [], travel_needed: false, driver: null, take_along: null,
            });
        expect(parseRecipientEvent({ title: 'Heute frueh', start_time: '2026-11-11T08:00' }, now)?.start_time).toBe('2026-11-11T08:00:00');
        expect(parseRecipientEvent({ title: 'Spaet', start_time: '2028-11-11T09:00' }, now)).not.toBeNull();
    });

    it('E60: Art, Ort, Begleitung, Fahrt und Mitnehmen', () => {
        const input = parseRecipientEvent({
            title: 'Dr. Muster', start_time: '2026-11-12T10:30', category: 'doctor', location: ' Praxis am Markt ',
            companion_needed: true, companion_name: ' Erika  Beispiel ', travel_needed: true, driver: 'Max Beispiel',
            take_along: 'Versichertenkarte',
        }, now);
        expect(input).toMatchObject({
            category: 'doctor', location: 'Praxis am Markt', companion_needed: true, member_ids: [],
            guests: ['Erika Beispiel'], travel_needed: true, driver: 'Max Beispiel', take_along: 'Versichertenkarte',
        });
        // Mitglied statt Gast; ohne Haken keine Namen
        expect(parseRecipientEvent({ title: 'A', start_time: '2026-11-12T10:30', companion_needed: true, companion_member_id: 'm-1', companion_name: 'X' }, now))
            .toMatchObject({ member_ids: ['m-1'], guests: [] });
        expect(parseRecipientEvent({ title: 'A', start_time: '2026-11-12T10:30', companion_name: 'X', driver: 'Y' }, now))
            .toMatchObject({ companion_needed: false, guests: [], travel_needed: false, driver: null });
        expect(parseRecipientEvent({ title: 'A', start_time: '2026-11-12T10:30', category: 'party' }, now)).toBeNull();
    });

    it('lehnt leere, zu lange und falsche Angaben ab', () => {
        expect(parseRecipientEvent({ title: '', start_time: '2026-11-12T10:30' }, now)).toBeNull();
        expect(parseRecipientEvent({ title: 'x'.repeat(121), start_time: '2026-11-12T10:30' }, now)).toBeNull();
        expect(parseRecipientEvent({ title: 'Gestern', start_time: '2026-11-10T10:30' }, now)).toBeNull();
        expect(parseRecipientEvent({ title: 'Zu weit', start_time: '2028-11-13T10:30' }, now)).toBeNull();
        expect(parseRecipientEvent({ title: 'Kein Tag', start_time: '2026-02-30T10:30' }, now)).toBeNull();
        expect(parseRecipientEvent({ title: 'Format', start_time: '12.11.2026 10:30' }, now)).toBeNull();
        expect(parseRecipientEvent({ title: 'Ohne Zeit' }, now)).toBeNull();
        expect(parseRecipientEvent(null, now)).toBeNull();
    });

    it('Rueckgaengig nur fuer den eigenen Termin ohne Serie, 10 Minuten', () => {
        const own = (age: number | string | null) => ({ created_by: 'konto-1', rrule: null, created_age_ms: age });
        expect(recipientEventUndoMsLeft(own(60_000), 'konto-1')).toBe(RECIPIENT_UNDO_MS - 60_000);
        expect(recipientEventUndoMsLeft(own('1000.5'), 'konto-1')).toBeGreaterThan(0);
        expect(recipientEventUndoMsLeft(own(RECIPIENT_UNDO_MS), 'konto-1')).toBe(0);
        expect(recipientEventUndoMsLeft(own(null), 'konto-1')).toBe(0);
        expect(recipientEventUndoMsLeft(own(-1), 'konto-1')).toBe(0);
        expect(recipientEventUndoMsLeft({ ...own(1000), created_by: 'konto-2' }, 'konto-1')).toBe(0);
        expect(recipientEventUndoMsLeft({ ...own(1000), rrule: 'FREQ=WEEKLY' }, 'konto-1')).toBe(0);
        expect(recipientEventUndoMsLeft(own(1000), undefined)).toBe(0);
    });
});

describe('Block L4: Einkaufsliste der betreuten Person', () => {
    const item = (patch: Record<string, unknown> = {}) => ({
        is_checked: false, added_by: 'konto-2', checked_by: null, created_age_ms: 60 * 60 * 1000, checked_age_ms: null, ...patch,
    });

    it('nimmt nur einen Namen', () => {
        expect(parseRecipientShoppingName({ name: '  Milch   und Brot ', category: 'pharmacy', notes: 'x' })).toBe('Milch und Brot');
        expect(parseRecipientShoppingName({ name: '   ' })).toBeNull();
        expect(parseRecipientShoppingName({ name: 'x'.repeat(101) })).toBeNull();
        expect(parseRecipientShoppingName({ name: 5 })).toBeNull();
        expect(parseRecipientShoppingName(undefined)).toBeNull();
    });

    it('hakt offene Eintraege ab, auch fremde', () => {
        expect(recipientMayCheckShopping(true, item(), 'konto-1')).toBe(true);
        expect(recipientMayCheckShopping(true, item({ is_checked: true }), 'konto-1')).toBe(false);
        expect(recipientMayCheckShopping('ja', item(), 'konto-1')).toBe(false);
        expect(recipientMayCheckShopping(undefined, item(), 'konto-1')).toBe(false);
    });

    it('nimmt nur das eigene Abhaken zurueck, 10 Minuten', () => {
        const checked = item({ is_checked: true, checked_by: 'konto-1', checked_age_ms: 30_000 });
        expect(recipientMayCheckShopping(false, checked, 'konto-1')).toBe(true);
        expect(recipientShoppingUndo(checked, 'konto-1').checked).toBe(RECIPIENT_UNDO_MS - 30_000);
        expect(recipientMayCheckShopping(false, { ...checked, checked_age_ms: RECIPIENT_UNDO_MS }, 'konto-1')).toBe(false);
        expect(recipientMayCheckShopping(false, { ...checked, checked_by: 'konto-2' }, 'konto-1')).toBe(false);
        expect(recipientMayCheckShopping(false, { ...checked, is_checked: false }, 'konto-1')).toBe(false);
    });

    it('loescht nur den eigenen neuen Eintrag, 10 Minuten', () => {
        expect(recipientShoppingUndo(item({ added_by: 'konto-1', created_age_ms: 1000 }), 'konto-1').added).toBe(RECIPIENT_UNDO_MS - 1000);
        expect(recipientShoppingUndo(item({ added_by: 'konto-1', created_age_ms: RECIPIENT_UNDO_MS + 1 }), 'konto-1').added).toBe(0);
        expect(recipientShoppingUndo(item({ created_age_ms: 1000 }), 'konto-1').added).toBe(0);
        expect(recipientShoppingUndo(item({ added_by: 'konto-1', created_age_ms: 1000 }), undefined)).toEqual({ added: 0, checked: 0 });
    });

    it('alle fuenf Rollen schreiben an der Liste, recipient nur eingeschraenkt', () => {
        expect([...SHOPPING_WRITER_ROLES].sort()).toEqual([...CIRCLE_ROLES].sort());
    });
});

// ── Block K (E20, aa87e84): Blutzucker und Gewicht selbst eintragen ──

const RECIPIENT_USER = 'konto-betreut';
const FAMILY_USER = 'konto-familie';

type FakeVital = {
    id: string; circle_id: string; type: string; value: number; value2: number | null;
    pulse: number | null; unit: string | null; measured_at: unknown; recorded_by_user: string;
    notes: string | null; age_ms: number;
};

/**
 * Ersatz fuer die Tabelle vitals. Die Abfrage der Route /mine/undoable gibt bewusst
 * alle Eintraege des Kreises zurueck: die Route muss selbst auf eigene und junge filtern.
 * Das Alter kommt wie aus PostgreSQL (numeric) als Text.
 */
const fakeVitals = () => {
    const store = new Map<string, FakeVital>();
    const inserts: Array<{ sql: string; params: unknown[] }> = [];
    const undoable: Array<{ sql: string; params: unknown[] }> = [];
    const diary: Array<{ sql: string; params: unknown[] }> = [];
    let updates = 0;
    let lastUpdate: { sql: string; params: unknown[] } | null = null;
    const withAge = (v: FakeVital) => ({ ...v, created_age_ms: String(v.age_ms) });
    const handler = (sql: string, params: unknown[]) => {
        if (sql.includes('FROM care_circles')) return { rows: [{ settings: {} }] };
        if (sql.includes('FROM vital_thresholds')) return { rows: [] };
        if (sql.includes('INSERT INTO vitals')) {
            inserts.push({ sql, params });
            const row: FakeVital = {
                id: `neu-${inserts.length}`, circle_id: params[0] as string, type: params[1] as string,
                value: params[2] as number, value2: params[3] as number | null, unit: params[4] as string | null,
                measured_at: params[5] ?? 'jetzt', recorded_by_user: params[6] as string,
                notes: params[7] as string | null, pulse: params[8] as number | null, age_ms: 0,
            };
            store.set(row.id, row);
            return { rows: [row] };
        }
        if (sql.includes('AS next_before')) {
            diary.push({ sql, params });
            return { rows: [{ next_before: '2026-09-30' }] };
        }
        if (sql.includes('measured_at >= COALESCE')) {
            diary.push({ sql, params });
            return { rows: [...store.values()].filter((v) => v.circle_id === params[0] && v.type === params[1]) };
        }
        if (sql.includes('created_at > LOCALTIMESTAMP')) {
            undoable.push({ sql, params });
            return { rows: [...store.values()].filter((v) => v.circle_id === params[0]).map(withAge) };
        }
        if (sql.startsWith('DELETE FROM vitals')) {
            store.delete(params[0] as string);
            return { rows: [] };
        }
        if (sql.includes('UPDATE vitals')) {
            updates += 1;
            lastUpdate = { sql, params };
            const v = store.get(params[params.length - 2] as string);
            return { rows: v ? [v] : [] };
        }
        if (sql.includes('FROM vitals WHERE id = $1')) {
            const v = store.get(params[0] as string);
            return { rows: v && v.circle_id === params[1] ? [withAge(v)] : [] };
        }
        throw new Error(`unerwartete Abfrage im Test: ${sql}`);
    };
    const seed = (id: string, type: string, user: string, ageMs: number, circle = 'kreis-1') => {
        store.set(id, {
            id, circle_id: circle, type, value: type === 'weight' ? 70 : 1.1, value2: null, pulse: null,
            unit: type === 'weight' ? 'kg' : 'g/L', measured_at: 'frueher', recorded_by_user: user, notes: null, age_ms: ageMs,
        });
    };
    return { store, inserts, undoable, diary, handler, seed, updates: () => updates, lastUpdate: () => lastUpdate };
};

/** Ganze Kette der Route: Anmeldung (ersetzt), circleMiddleware, Rollen, Handler. */
const callVitals = (
    role: CircleRole, userId: string, method: string, path: string, body: Record<string, unknown> = {},
    query: Record<string, string> = {}
) => new Promise<{ status: number; body: { success?: boolean; error?: string; data?: { undo_ms_left?: number } } | null }>((resolve, reject) => {
    membership.role = role;
    let status = 200;
    const res = {
        status(code: number) { status = code; return this; },
        json(data: { success?: boolean }) { resolve({ status, body: data }); return this; },
    };
    const req = {
        method,
        url: path,
        originalUrl: `/api/vitals${path === '/' ? '' : path}`,
        headers: { 'x-circle-id': 'kreis-1', 'x-test-user': userId },
        body,
        params: {},
        query,
    };
    (vitalsRouter as unknown as { handle: (q: unknown, r: unknown, out: (err?: unknown) => void) => void })
        .handle(req, res, (err) => (err ? reject(err) : resolve({ status: 404, body: null })));
});

const MIN = 60 * 1000;
const ALL_VITAL_TYPES = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'];

describe('Block K: Regeln fuer Gesundheitswerte (middleware/circle.ts)', () => {
    it('E47: Blutzucker, Gewicht und Blutdruck, gleich in Server und einfacher Ansicht', () => {
        expect([...RECIPIENT_VITAL_TYPES]).toEqual(['glucose', 'weight', 'bp']);
        expect([...CLIENT_RECIPIENT_VITAL_TYPES]).toEqual([...RECIPIENT_VITAL_TYPES]);
        expect([...CLIENT_GLUCOSE_MEAL_TIMES]).toEqual([...GLUCOSE_MEAL_TIMES]);
        expect([...CLIENT_GLUCOSE_MEAL_RELATIONS]).toEqual([...GLUCOSE_MEAL_RELATIONS]);
        expect(CLIENT_RECIPIENT_VITAL_NOTE_MAX).toBe(RECIPIENT_VITAL_NOTE_MAX);
        expect(RECIPIENT_VITAL_LIMITS).toEqual(SERVER_RECIPIENT_VITAL_LIMITS);
        for (const type of ['pain', 'mood', 'temperature', '', 'GLUCOSE', undefined, null, 1]) {
            expect(recipientMayRecordVital(type), String(type)).toBe(false);
        }
    });

    it('Rueckgaengig nur fuer eigene Eintraege, 10 Minuten', () => {
        const own = (ageMs: number | string | null, type = 'glucose') =>
            ({ type, recorded_by_user: RECIPIENT_USER, created_age_ms: ageMs });
        expect(recipientVitalUndoMsLeft(own(0), RECIPIENT_USER)).toBe(RECIPIENT_UNDO_MS);
        expect(recipientVitalUndoMsLeft(own(String(9 * MIN)), RECIPIENT_USER)).toBe(MIN);
        expect(recipientVitalUndoMsLeft(own(RECIPIENT_UNDO_MS), RECIPIENT_USER)).toBe(0);
        expect(recipientVitalUndoMsLeft(own(11 * MIN), RECIPIENT_USER)).toBe(0);
        expect(recipientVitalUndoMsLeft(own(null), RECIPIENT_USER)).toBe(0);
        expect(recipientVitalUndoMsLeft(own(-1), RECIPIENT_USER)).toBe(0);
        expect(recipientVitalUndoMsLeft(own('kaputt'), RECIPIENT_USER)).toBe(0);
        expect(recipientVitalUndoMsLeft(own(0, 'bp'), RECIPIENT_USER)).toBe(RECIPIENT_UNDO_MS);
        expect(recipientVitalUndoMsLeft(own(0, 'pain'), RECIPIENT_USER)).toBe(0);
        expect(recipientVitalUndoMsLeft(own(0), FAMILY_USER)).toBe(0);
        expect(recipientVitalUndoMsLeft(own(0), undefined)).toBe(0);
    });
});

describe('Block K: Grenzen gegen Tippfehler in der einfachen Ansicht (lib/recipientView.ts)', () => {
    const mgdlToGl = (shown: number) => shown / 100;
    const kg = (shown: number) => shown;

    it('Grenzen in der gespeicherten Einheit (E47 mit Blutdruck und Puls)', () => {
        expect(RECIPIENT_VITAL_LIMITS).toEqual({
            glucose: { min: 0.2, max: 6 },
            weight: { min: 20, max: 250 },
            bp: { min: 50, max: 260 },
            bp2: { min: 30, max: 160 },
            pulse: { min: 30, max: 220 },
        });
    });

    it('Blutzucker 20 bis 600 mg/dL, nur Ziffern; Schreibweise und Bereich getrennt', () => {
        for (const text of ['20', '600', '95', '1 1 0']) {
            expect(parseRecipientVital('glucose', text, mgdlToGl).ok, text).toBe(true);
        }
        for (const text of ['19', '601', '0']) {
            expect(parseRecipientVital('glucose', text, mgdlToGl), text).toEqual({ ok: false, error: 'range' });
        }
        for (const text of ['-5', 'abc', '1e3', '95,5', '12a']) {
            expect(parseRecipientVital('glucose', text, mgdlToGl), text).toEqual({ ok: false, error: 'format' });
        }
        expect(parseRecipientVital('glucose', '  ', mgdlToGl)).toEqual({ ok: false, error: 'empty' });
    });

    it('Gewicht 20 bis 250 kg, Komma oder Punkt, hoechstens eine Nachkommastelle', () => {
        expect(parseRecipientVital('weight', '72,5', kg)).toEqual({ ok: true, shown: 72.5, stored: 72.5 });
        for (const text of ['20', '250', '250.0']) {
            expect(parseRecipientVital('weight', text, kg).ok, text).toBe(true);
        }
        for (const text of ['19,9', '250,1', '0']) {
            expect(parseRecipientVital('weight', text, kg), text).toEqual({ ok: false, error: 'range' });
        }
        for (const text of ['72,55', '72,', ',5', '7x']) {
            expect(parseRecipientVital('weight', text, kg), text).toEqual({ ok: false, error: 'format' });
        }
    });
});

describe('E47: Eingabe pruefen (lib/recipientView.ts, checkRecipientVitalForm)', () => {
    const base: RecipientVitalFormInput = { type: 'glucose', text: '', text2: '', pulse: '', note: '', mealTime: null, mealRelation: null };
    const mgdlToGl = (shown: number) => shown / 100;
    const same = (shown: number) => shown;

    it('Blutzucker: Tageszeit und vor/nach dem Essen Pflicht', () => {
        expect(checkRecipientVitalForm({ ...base, text: '112' }, mgdlToGl)).toEqual({ ok: false, errors: { mealTime: 'choose', mealRelation: 'choose' } });
        const ok = checkRecipientVitalForm({ ...base, text: '112', mealTime: 'morning', mealRelation: 'before', note: '  Kuchen   gegessen ' }, mgdlToGl);
        expect(ok).toEqual({ ok: true, payload: { type: 'glucose', value: 1.12, value2: null, pulse: null, notes: 'Kuchen gegessen', meal_time: 'morning', meal_relation: 'before' } });
    });

    it('Blutzucker spaet: ohne vor/nach dem Essen', () => {
        const r = checkRecipientVitalForm({ ...base, text: '131', mealTime: 'late', mealRelation: 'after' }, mgdlToGl);
        expect(r.ok && r.payload).toMatchObject({ meal_time: 'late', meal_relation: null });
    });

    it('Blutdruck: beide Werte Pflicht, systolisch groesser, Puls freiwillig', () => {
        const bp = { ...base, type: 'bp' as const };
        expect(checkRecipientVitalForm({ ...bp, text: '132' }, same)).toEqual({ ok: false, errors: { value2: 'empty' } });
        expect(checkRecipientVitalForm({ ...bp, text: '78', text2: '132' }, same)).toEqual({ ok: false, errors: { value2: 'order' } });
        expect(checkRecipientVitalForm({ ...bp, text: '132', text2: '78', pulse: '250' }, same)).toEqual({ ok: false, errors: { pulse: 'range' } });
        expect(checkRecipientVitalForm({ ...bp, text: '270', text2: '78' }, same)).toEqual({ ok: false, errors: { value: 'range' } });
        const ok = checkRecipientVitalForm({ ...bp, text: '132', text2: '78', pulse: '68', mealTime: 'morning' }, same);
        expect(ok).toEqual({ ok: true, payload: { type: 'bp', value: 132, value2: 78, pulse: 68, notes: null, meal_time: null, meal_relation: null } });
        const noPulse = checkRecipientVitalForm({ ...bp, text: '132', text2: '78' }, same);
        expect(noPulse.ok && noPulse.payload.pulse).toBeNull();
    });

    it('Gewicht: ohne Tageszeit', () => {
        const ok = checkRecipientVitalForm({ ...base, type: 'weight', text: '72,5' }, same);
        expect(ok).toEqual({ ok: true, payload: { type: 'weight', value: 72.5, value2: null, pulse: null, notes: null, meal_time: null, meal_relation: null } });
    });

    it('Tagebuch Blutzucker: ein Tag pro Zeile, Werte ohne Tageszeit bei der Bemerkung', () => {
        const e = (id: string, day: string, meal_time: DiaryEntry['meal_time'], meal_relation: DiaryEntry['meal_relation'], notes: string | null = null): DiaryEntry =>
            ({ id, type: 'glucose', value: 1.1, value2: null, pulse: null, measured_at: `${day}T08:00:00`, notes, meal_time, meal_relation });
        // neueste zuerst, wie vom Server
        const rows = groupGlucoseDays([
            e('c', '2026-11-14', 'late', null),
            e('b', '2026-11-14', 'morning', 'after', 'Kuchen'),
            e('a', '2026-11-14', 'morning', 'after'),
            e('x', '2026-11-13', null, null),
        ], (entry) => entry.measured_at.slice(0, 10));
        expect(rows.map((r) => r.day)).toEqual(['2026-11-14', '2026-11-13']);
        expect(rows[0].slots['morning-after']?.map((v) => v.id)).toEqual(['a', 'b']);
        expect(rows[0].slots.late?.map((v) => v.id)).toEqual(['c']);
        expect(rows[0].notes.map((v) => [v.id, v.notes])).toEqual([['b', 'Kuchen']]);
        expect(rows[1].untimed.map((v) => v.id)).toEqual(['x']);
    });
});

describe('E47: Tageszeit beim Blutzucker (middleware/circle.ts, parseGlucoseMeal)', () => {
    it('beides freiwillig, gueltige Werte, spaet ohne vor/nach', () => {
        expect(parseGlucoseMeal(undefined, undefined)).toEqual({ ok: true, meal_time: null, meal_relation: null });
        expect(parseGlucoseMeal('noon', 'after')).toEqual({ ok: true, meal_time: 'noon', meal_relation: 'after' });
        expect(parseGlucoseMeal('late', null)).toEqual({ ok: true, meal_time: 'late', meal_relation: null });
        for (const [time, relation] of [['late', 'before'], [null, 'before'], ['nachts', null], ['morning', 'waehrend']]) {
            expect(parseGlucoseMeal(time, relation).ok, `${time} ${relation}`).toBe(false);
        }
    });
});

describe('Block K: Gesundheitswerte der betreuten Person (routes/vitals.ts)', () => {
    let db: ReturnType<typeof fakeVitals>;
    beforeEach(() => { db = fakeVitals(); vitalsDb.handler = db.handler; });
    afterEach(() => { vitalsDb.handler = null; });

    it('POST: Blutzucker, Gewicht und Blutdruck, andere Arten 403 ohne Eintrag', async () => {
        for (const type of ['pain', 'mood', 'temperature', 'unbekannt', undefined]) {
            const r = await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type, value: 5 });
            expect(r.status, String(type)).toBe(403);
        }
        expect(db.inserts).toHaveLength(0);
        expect((await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type: 'glucose', value: 1.1, meal_time: 'morning', meal_relation: 'before' })).status).toBe(200);
        expect((await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type: 'weight', value: 70 })).status).toBe(200);
        expect((await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type: 'bp', value: 132, value2: 78, pulse: 68 })).status).toBe(200);
        expect(db.inserts).toHaveLength(3);
    });

    it('POST: Zeit immer jetzt, Einheit fest, Bemerkung erlaubt, zweiter Wert und Puls nur beim Blutdruck', async () => {
        const extra = { value2: 80, pulse: 70, notes: '  Kuchen   gegessen ', unit: 'mg/dL' };
        for (const measured_at of ['2020-01-01T08:00:00', 'kaputt']) {
            const r = await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type: 'glucose', value: 1.1, measured_at, ...extra });
            expect(r.status, measured_at).toBe(200);
            expect(r.body?.data?.undo_ms_left).toBe(RECIPIENT_UNDO_MS);
        }
        await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type: 'weight', value: 70, measured_at: '2020-01-01', ...extra, unit: 'lb' });
        expect(db.inserts).toHaveLength(3);
        for (const { sql, params } of db.inserts) {
            expect(sql).toContain('COALESCE($6, CURRENT_TIMESTAMP)');
            expect(params[5]).toBeNull(); // measured_at
            expect(params[3]).toBeNull(); // value2
            expect(params[8]).toBeNull(); // pulse
            expect(params[7]).toBe('Kuchen gegessen'); // notes
            expect(params[6]).toBe(RECIPIENT_USER);
        }
        expect(db.inserts.map((i) => i.params[4])).toEqual(['g/L', 'g/L', 'kg']);

        await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type: 'bp', value: 132, value2: 78, pulse: 68, measured_at: '2020-01-01', unit: 'cmHg' });
        const { params } = db.inserts[db.inserts.length - 1];
        expect(params.slice(2, 6)).toEqual([132, 78, 'mmHg', null]);
        expect(params[8]).toBe(68);
    });

    it('POST: Tageszeit und vor/nach dem Essen beim Blutzucker gespeichert, sonst leer', async () => {
        await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type: 'glucose', value: 1.12, meal_time: 'evening', meal_relation: 'after' });
        await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type: 'glucose', value: 1.31, meal_time: 'late' });
        await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type: 'weight', value: 70, meal_time: 'morning', meal_relation: 'before' });
        expect(db.inserts.map((i) => [i.params[9], i.params[10]])).toEqual([['evening', 'after'], ['late', null], [null, null]]);
        for (const body of [
            { type: 'glucose', value: 1.1, meal_time: 'late', meal_relation: 'before' },
            { type: 'glucose', value: 1.1, meal_time: 'nachts' },
            { type: 'glucose', value: 1.1, meal_relation: 'after' },
        ]) {
            expect((await callVitals('recipient', RECIPIENT_USER, 'POST', '/', body)).status, JSON.stringify(body)).toBe(400);
        }
        expect(db.inserts).toHaveLength(3);
    });

    it('POST: Blutdruck nur mit diastolisch kleiner als systolisch, Puls in den Grenzen, Bemerkung hoechstens 300 Zeichen', async () => {
        for (const body of [
            { type: 'bp', value: 132 },
            { type: 'bp', value: 78, value2: 132 },
            { type: 'bp', value: 132, value2: 132 },
            { type: 'bp', value: 132, value2: 78, pulse: 29 },
            { type: 'bp', value: 132, value2: 78, pulse: 'abc' },
            { type: 'weight', value: 70, notes: 'x'.repeat(RECIPIENT_VITAL_NOTE_MAX + 1) },
            { type: 'weight', value: 70, notes: 5 },
        ]) {
            expect((await callVitals('recipient', RECIPIENT_USER, 'POST', '/', body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
        }
        expect(db.inserts).toHaveLength(0);
    });

    it('POST: leere, null, negative und unlesbare Werte abgelehnt', async () => {
        for (const value of [0, -1, '', null, undefined, 'abc']) {
            const r = await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type: 'weight', value });
            expect(r.status, String(value)).toBe(400);
        }
        expect(db.inserts).toHaveLength(0);
    });

    it('POST: Werte an den Grenzen werden angenommen', async () => {
        for (const [type, value] of [['glucose', 0.2], ['glucose', 6], ['weight', 20], ['weight', 250]] as const) {
            expect((await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type, value })).status, `${type} ${value}`).toBe(200);
        }
        for (const [value, value2, pulse] of [[50, 30, 30], [260, 160, 220]]) {
            expect((await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type: 'bp', value, value2, pulse })).status, `bp ${value}`).toBe(200);
        }
    });

    // Roadmap Punkt 8, behoben mit E47: der Server prueft die Grenzen gegen Tippfehler selbst.
    it('POST: Werte ausserhalb der Grenzen lehnt auch der Server ab', async () => {
        for (const [type, value] of [['glucose', 0.19], ['glucose', 6.01], ['weight', 19.9], ['weight', 250.1], ['bp', 49], ['bp', 261]] as const) {
            const body = type === 'bp' ? { type, value, value2: 40 } : { type, value };
            expect((await callVitals('recipient', RECIPIENT_USER, 'POST', '/', body)).status, `${type} ${value}`).toBe(400);
        }
        for (const [value2, pulse] of [[29, null], [161, null], [80, 221]]) {
            expect((await callVitals('recipient', RECIPIENT_USER, 'POST', '/', { type: 'bp', value: 200, value2, pulse })).status, `bp2 ${value2} ${pulse}`).toBe(400);
        }
        expect(db.inserts).toHaveLength(0);
    });

    it('GET /mine/undoable: nur eigene Eintraege der letzten 10 Minuten', async () => {
        db.seed('eigen-neu', 'glucose', RECIPIENT_USER, 1 * MIN);
        db.seed('eigen-gewicht', 'weight', RECIPIENT_USER, 9 * MIN);
        db.seed('eigen-genau-10', 'glucose', RECIPIENT_USER, RECIPIENT_UNDO_MS);
        db.seed('eigen-alt', 'weight', RECIPIENT_USER, 11 * MIN);
        db.seed('fremd-neu', 'glucose', FAMILY_USER, 1 * MIN);
        db.seed('eigen-blutdruck', 'bp', RECIPIENT_USER, 1 * MIN);
        db.seed('anderer-kreis', 'glucose', RECIPIENT_USER, 1 * MIN, 'kreis-2');

        const r = await callVitals('recipient', RECIPIENT_USER, 'GET', '/mine/undoable');
        expect(r.status).toBe(200);
        const data = r.body?.data as unknown as Array<{ id: string; undo_ms_left: number }>;
        expect(data.map((v) => v.id).sort()).toEqual(['eigen-blutdruck', 'eigen-gewicht', 'eigen-neu']);
        expect(data.find((v) => v.id === 'eigen-neu')?.undo_ms_left).toBe(RECIPIENT_UNDO_MS - MIN);
        // Die Datenbank-Abfrage selbst filtert schon auf Kreis, Konto und Zeit.
        const { sql, params } = db.undoable[0];
        expect(sql).toContain('recorded_by_user = $2');
        expect(params.slice(0, 3)).toEqual(['kreis-1', RECIPIENT_USER, String(RECIPIENT_UNDO_MS)]);
    });

    it('DELETE: eigener Eintrag innerhalb von 10 Minuten geht', async () => {
        db.seed('eigen', 'glucose', RECIPIENT_USER, 9 * MIN);
        const r = await callVitals('recipient', RECIPIENT_USER, 'DELETE', '/eigen');
        expect(r).toEqual({ status: 200, body: { success: true } });
        expect(db.store.has('eigen')).toBe(false);
    });

    it('DELETE: danach 403 UNDO_EXPIRED, fremder Eintrag 403, Eintrag bleibt', async () => {
        db.seed('eigen-alt', 'weight', RECIPIENT_USER, RECIPIENT_UNDO_MS + 1);
        db.seed('fremd', 'glucose', FAMILY_USER, 1 * MIN);
        const expired = await callVitals('recipient', RECIPIENT_USER, 'DELETE', '/eigen-alt');
        expect(expired.status).toBe(403);
        expect(expired.body?.error).toBe('UNDO_EXPIRED');
        expect((await callVitals('recipient', RECIPIENT_USER, 'DELETE', '/fremd')).status).toBe(403);
        expect(db.store.has('eigen-alt')).toBe(true);
        expect(db.store.has('fremd')).toBe(true);
        expect((await callVitals('recipient', RECIPIENT_USER, 'DELETE', '/gibt-es-nicht')).status).toBe(404);
    });

    it('GET /diary (E47): Werte einer Art, 28 Tage, neueste zuerst, mit next_before', async () => {
        db.seed('zucker', 'glucose', FAMILY_USER, 120 * MIN);
        db.seed('gewicht', 'weight', RECIPIENT_USER, 120 * MIN);
        db.seed('anderer-kreis', 'glucose', RECIPIENT_USER, 1 * MIN, 'kreis-2');
        const r = await callVitals('recipient', RECIPIENT_USER, 'GET', '/diary', {}, { type: 'glucose' });
        expect(r.status).toBe(200);
        const data = r.body?.data as unknown as { entries: Array<{ id: string }>; next_before: string | null };
        // auch von der Familie eingetragene Werte: es ist das Tagebuch der betreuten Person
        expect(data.entries.map((e) => e.id)).toEqual(['zucker']);
        expect(data.next_before).toBe('2026-09-30');
        const [list] = db.diary;
        expect(list.params).toEqual(['kreis-1', 'glucose', null]);
        expect(list.sql).toContain('ORDER BY measured_at DESC');
        expect(list.sql).toContain('- 28');
        const older = await callVitals('recipient', RECIPIENT_USER, 'GET', '/diary', {}, { type: 'weight', before: '2026-10-17' });
        expect(older.status).toBe(200);
        expect(db.diary[db.diary.length - 1].params).toEqual(['kreis-1', 'weight', '2026-10-17']);
    });

    it('GET /diary: andere Arten und falsche Tage 400', async () => {
        for (const query of [{}, { type: 'pain' }, { type: 'glucose', before: '2026-02-31' }, { type: 'glucose', before: 'gestern' }]) {
            expect((await callVitals('recipient', RECIPIENT_USER, 'GET', '/diary', {}, query)).status, JSON.stringify(query)).toBe(400);
        }
        expect(db.diary).toHaveLength(0);
    });

    it('PUT: immer gesperrt, auch fuer den eigenen neuen Eintrag', async () => {
        db.seed('eigen', 'glucose', RECIPIENT_USER, 0);
        expect(await run('recipient', 'PUT', '/api/vitals/eigen')).toEqual({ status: 403, passed: false });
        expect((await callVitals('recipient', RECIPIENT_USER, 'PUT', '/eigen', { value: 1.2 })).status).toBe(403);
        expect(db.updates()).toBe(0);
        expect(db.store.get('eigen')?.value).toBe(1.1);
    });
});

describe('Block K Gegenprobe: andere Rollen wie bisher (routes/vitals.ts)', () => {
    let db: ReturnType<typeof fakeVitals>;
    beforeEach(() => { db = fakeVitals(); vitalsDb.handler = db.handler; });
    afterEach(() => { vitalsDb.handler = null; });

    const OWN_USER = 'konto-eigen';
    const writers: CircleRole[] = ['admin', 'family', 'professional'];

    it('admin, family, professional tragen alle Arten ein, mit Zeit, zweitem Wert, Puls und Notiz', async () => {
        for (const role of writers) {
            for (const type of ALL_VITAL_TYPES) {
                const r = await callVitals(role, OWN_USER, 'POST', '/', { type, value: 7 });
                expect(r.status, `${role} ${type}`).toBe(200);
                expect(r.body?.data?.undo_ms_left, `${role} ${type}`).toBeUndefined();
            }
            const bp = await callVitals(role, OWN_USER, 'POST', '/', {
                type: 'bp', value: 130, value2: 80, pulse: 70, notes: 'Notiz', unit: 'mmHg', measured_at: '2026-11-01T08:00:00',
            });
            expect(bp.status, role).toBe(200);
            const { params } = db.inserts[db.inserts.length - 1];
            expect(params[3], role).toBe(80);
            expect(params[8], role).toBe(70);
            expect(params[7], role).toBe('Notiz');
            expect(params[4], role).toBe('mmHg');
            expect(params[5], role).toBeInstanceOf(Date);
        }
        // Keine Grenzen gegen Tippfehler fuer diese Rollen (7 g/L Blutzucker oben angenommen).
    });

    it('E48: admin und family aendern eigene Eintraege, professional nicht; alle loeschen eigene, auch alte', async () => {
        for (const role of writers) {
            db.seed(`alt-${role}`, 'glucose', OWN_USER, 120 * MIN);
            db.seed(`alt2-${role}`, 'weight', OWN_USER, 120 * MIN);
            const expected = role === 'professional' ? 403 : 200;
            expect((await callVitals(role, OWN_USER, 'PUT', `/alt-${role}`, { notes: 'geaendert' })).status, role).toBe(expected);
            expect((await callVitals(role, OWN_USER, 'DELETE', `/alt2-${role}`)).status, role).toBe(200);
            expect(db.store.has(`alt2-${role}`), role).toBe(false);
        }
    });

    it('E48: fremde Eintraege aendern admin und family, loeschen nur admin', async () => {
        for (const role of writers) {
            db.seed(`fremd-${role}`, 'glucose', RECIPIENT_USER, 1 * MIN);
            const put = await callVitals(role, OWN_USER, 'PUT', `/fremd-${role}`, { notes: 'geaendert' });
            const del = await callVitals(role, OWN_USER, 'DELETE', `/fremd-${role}`);
            expect(put.status, role).toBe(role === 'professional' ? 403 : 200);
            expect(del.status, role).toBe(role === 'admin' ? 200 : 403);
            expect(db.store.has(`fremd-${role}`), role).toBe(role !== 'admin');
        }
    });

    it('E48: Bearbeiten setzt Tageszeit beim Blutzucker, geprueft; andere Arten ohne', async () => {
        for (const role of ['admin', 'family'] as CircleRole[]) {
            db.seed(`bz-${role}`, 'glucose', RECIPIENT_USER, 120 * MIN);
            db.seed(`kg-${role}`, 'weight', RECIPIENT_USER, 120 * MIN);
            expect((await callVitals(role, OWN_USER, 'PUT', `/bz-${role}`, { meal_time: 'evening', meal_relation: 'after' })).status, role).toBe(200);
            const upd = db.lastUpdate();
            expect(upd?.sql, role).toContain('meal_time = $1');
            expect(upd?.sql, role).toContain('meal_relation = $2');
            expect(upd?.params.slice(0, 2), role).toEqual(['evening', 'after']);
            const before = db.updates();
            expect((await callVitals(role, OWN_USER, 'PUT', `/bz-${role}`, { meal_time: 'late', meal_relation: 'before' })).status, role).toBe(400);
            expect((await callVitals(role, OWN_USER, 'PUT', `/bz-${role}`, { meal_time: 'nachts' })).status, role).toBe(400);
            expect((await callVitals(role, OWN_USER, 'PUT', `/kg-${role}`, { meal_time: 'noon' })).status, role).toBe(400);
            expect(db.updates(), role).toBe(before);
            expect((await callVitals(role, OWN_USER, 'PUT', `/bz-${role}`, { type: 'weight', value: 70 })).status, role).toBe(200);
            expect(db.lastUpdate()?.sql, role).toContain('meal_time = NULL');
        }
    });

    it('E47: Tageszeit beim Blutzucker auch fuer diese Rollen, freiwillig und geprueft', async () => {
        for (const role of writers) {
            expect((await callVitals(role, OWN_USER, 'POST', '/', { type: 'glucose', value: 1.1, meal_time: 'noon', meal_relation: 'before' })).status, role).toBe(200);
            expect(db.inserts[db.inserts.length - 1].params.slice(9, 11), role).toEqual(['noon', 'before']);
            expect((await callVitals(role, OWN_USER, 'POST', '/', { type: 'glucose', value: 1.1, meal_time: 'late', meal_relation: 'after' })).status, role).toBe(400);
            expect((await callVitals(role, OWN_USER, 'POST', '/', { type: 'bp', value: 130, value2: 80, meal_time: 'noon' })).status, role).toBe(200);
            expect(db.inserts[db.inserts.length - 1].params.slice(9, 11), role).toEqual([null, null]);
        }
    });

    it('E47: Tagebuch lesen admin, family, professional', async () => {
        for (const role of writers) {
            expect((await callVitals(role, OWN_USER, 'GET', '/diary', {}, { type: 'bp' })).status, role).toBe(200);
        }
    });

    it('neighbor (Freunde) hat keinen Zugang zu Gesundheitswerten', async () => {
        db.seed('eintrag', 'glucose', OWN_USER, 1 * MIN);
        for (const [method, path] of [['POST', '/'], ['GET', '/mine/undoable'], ['GET', '/diary'], ['PUT', '/eintrag'], ['DELETE', '/eintrag']]) {
            const r = await callVitals('neighbor', OWN_USER, method, path, { type: 'glucose', value: 1.1, notes: 'x' }, { type: 'glucose' });
            expect(r.status, `${method} ${path}`).toBe(403);
        }
        expect(db.inserts).toHaveLength(0);
        expect(db.updates()).toBe(0);
        expect(db.store.has('eintrag')).toBe(true);
    });
});
