import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';

/**
 * "Fragen Sie mich" fuer die betreute Person (Launch Block C): nur feste
 * Fragen, Antwort ohne KI aus den eigenen Daten. Die Freigabe in
 * middleware/circle.ts muss genau zu den Fragen der Route passen, und die
 * Route darf keine freie Eingabe annehmen.
 */

vi.mock('../../server/src/db', () => ({
    query: async () => { throw new Error('keine Datenbank im Test'); },
    getClient: async () => { throw new Error('keine Datenbank im Test'); },
}));

import router, { FIXED_QUESTIONS, isFixedQuestion } from '../../server/src/routes/companion';
import { recipientMayAccess } from '../../server/src/middleware/circle';
import { HEALTH_INTENTS } from '../../server/src/lib/companionAnswers';
import { RECIPIENT_QUESTIONS } from '../../client/src/lib/recipientView';

const answerHandler = () => {
    const layer = (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: Function }> } }> }).stack
        .find((l) => l.route?.path === '/answer/:question');
    if (!layer?.route) throw new Error('Route /answer/:question fehlt');
    return layer.route.stack[layer.route.stack.length - 1].handle;
};

const call = async (question: string) => {
    let status = 200;
    let body: unknown = null;
    const res = {
        status(code: number) { status = code; return this; },
        json(data: unknown) { body = data; return this; },
    } as unknown as Response;
    await answerHandler()({ params: { question }, headers: {}, circleId: 'kreis-1', circleRole: 'recipient' }, res);
    return { status, body };
};

describe('feste Fragen', () => {
    it('Server und einfache Ansicht kennen dieselben Fragen', () => {
        expect(Object.keys(FIXED_QUESTIONS).sort()).toEqual([...RECIPIENT_QUESTIONS].sort());
    });

    it('jede feste Frage ist fuer recipient freigegeben, sonst nichts unter /answer', () => {
        for (const q of Object.keys(FIXED_QUESTIONS)) {
            expect(recipientMayAccess('GET', `/api/companion/answer/${q}`), q).toBe(true);
            expect(recipientMayAccess('POST', `/api/companion/answer/${q}`), q).toBe(false);
        }
        for (const q of ['tasks', 'vitals', 'stock', 'help', 'weather', 'Wie geht es mir?']) {
            expect(recipientMayAccess('GET', `/api/companion/answer/${encodeURIComponent(q)}`), q).toBe(false);
        }
    });

    it('nur Themen aus ihrem Alltag: keine Aufgaben, Messwerte, Vorrat, kein Hilferuf', () => {
        const intents = Object.values(FIXED_QUESTIONS) as string[];
        for (const blocked of ['tasks_today', 'vitals_latest', 'medication_stock', 'help', 'weather']) {
            expect(intents).not.toContain(blocked);
        }
        // Gesundheitsthemen darin sind die, die sie ohnehin sieht (Medikamente heute, Termine).
        expect(intents.filter((i) => (HEALTH_INTENTS as readonly string[]).includes(i)).sort()).toEqual(['appointments', 'medications']);
    });

    it('lehnt jede andere Eingabe ab, bevor Daten gelesen werden', async () => {
        for (const q of ['unbekannt', 'Was soll ich tun?', 'tasks', '__proto__', 'constructor', '']) {
            expect(isFixedQuestion(q), q).toBe(false);
            expect((await call(q)).status, q).toBe(400);
        }
    });
});
