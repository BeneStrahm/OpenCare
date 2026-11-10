import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';

/**
 * Rechte der betreuten Person (Rolle recipient), Launch Block B und C.
 * Ohne Datenbank: die Abfrage der Mitgliedschaft in circleMiddleware wird ersetzt,
 * die Regeln (Liste der erlaubten Anfragen, Rueckgaengig) laufen direkt.
 */

const membership = vi.hoisted(() => ({ role: 'recipient' as string }));

vi.mock('../../server/src/db', () => ({
    query: async () => ({ rows: [{ id: 'mitglied-1', role: membership.role }] }),
    getClient: async () => { throw new Error('keine Datenbank im Test'); },
}));

import {
    circleMiddleware,
    recipientMayAccess,
    recipientMayChangeIntake,
    recipientUndoMsLeft,
    requireAdmin,
    CIRCLE_ROLES,
    RECIPIENT_UNDO_MINUTES,
    RECIPIENT_UNDO_MS,
    type CircleRequest,
    type CircleRole,
} from '../../server/src/middleware/circle';

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
    ['GET', '/api/consultations'],
    ['POST', '/api/consultations/recordings'],
    ['GET', '/api/documents'],
    ['GET', '/api/vitals'],
    ['GET', '/api/tasks'],
    ['GET', '/api/shopping'],
    ['GET', '/api/expenses'],
    ['GET', '/api/messages'],
    ['GET', '/api/notes'],
    ['GET', '/api/story'],
    ['GET', '/api/handover'],
    ['GET', '/api/care-plan'],
    ['GET', '/api/digests'],
    ['GET', '/api/insights'],
    ['GET', '/api/emergency/sheet'],
    ['GET', '/api/emergency/payload'],
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
    ['POST', '/api/events'],
    ['PUT', '/api/events/termin-1'],
    ['DELETE', '/api/events/termin-1'],
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
    });

    it('erlaubt innerhalb von 10 Minuten', () => {
        expect(recipientMayChangeIntake('pending', own(0), 'konto-1')).toBe(true);
        expect(recipientMayChangeIntake('pending', own(9 * 60 * 1000), 'konto-1')).toBe(true);
        // Aus der Datenbank kommt EXTRACT(...) als Text.
        expect(recipientMayChangeIntake('pending', own('120000.5'), 'konto-1')).toBe(true);
        expect(recipientUndoMsLeft(own(60_000), 'konto-1')).toBe(RECIPIENT_UNDO_MS - 60_000);
    });

    it('lehnt nach 10 Minuten ab', () => {
        expect(recipientMayChangeIntake('pending', own(RECIPIENT_UNDO_MS), 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', own(RECIPIENT_UNDO_MS + 1), 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', own(60 * 60 * 1000), 'konto-1')).toBe(false);
        expect(recipientUndoMsLeft(own(RECIPIENT_UNDO_MS + 1), 'konto-1')).toBe(0);
    });

    it('nur eigene Bestaetigungen mit Quelle self', () => {
        expect(recipientMayChangeIntake('pending', { ...own(1000), confirmed_by_user: 'konto-2' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', own(1000), undefined)).toBe(false);
        for (const source of ['caregiver', 'kiosk', 'phone', 'link', null]) {
            expect(recipientMayChangeIntake('pending', { ...own(1000), confirmed_source: source }, 'konto-1'), String(source)).toBe(false);
        }
    });

    it('nur genommene Einnahmen, mit gueltiger Zeit', () => {
        expect(recipientMayChangeIntake('pending', { ...own(1000), status: 'skipped' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', { ...own(1000), status: 'pending' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', own(null), 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', own(-5000), 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('pending', own('kaputt'), 'konto-1')).toBe(false);
    });

    it('bestaetigt nur offene Einnahmen, laesst nichts aus', () => {
        expect(recipientMayChangeIntake('taken', { status: 'pending' }, 'konto-1')).toBe(true);
        expect(recipientMayChangeIntake('taken', { status: 'missed' }, 'konto-1')).toBe(true);
        expect(recipientMayChangeIntake('taken', { status: 'taken' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('taken', { status: 'skipped' }, 'konto-1')).toBe(false);
        expect(recipientMayChangeIntake('skipped', { status: 'pending' }, 'konto-1')).toBe(false);
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
