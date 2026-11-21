import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * E63: Infomaniak fuer das Arztgespraech (Mitschrift und Zusammenfassung).
 * Ohne Netz und ohne Datenbank: safeFetch, db und Entschluesselung werden ersetzt.
 */

const state = vi.hoisted(() => ({
    sql: [] as string[],
    requests: [] as Array<{ url: string; body: string }>,
    infomaniak: { encrypted_credentials: 'verschluesselt', config: { product_id: '4711', summary_model: 'testmodell' } } as
        | { encrypted_credentials: string | null; config: Record<string, unknown> }
        | null,
    reply: '' as string,
    replyStatus: 200,
}));

vi.mock('../../server/src/db', () => ({
    query: async (sql: string) => {
        state.sql.push(sql);
        if (sql.includes("type = 'infomaniak'")) return { rows: state.infomaniak ? [state.infomaniak] : [] };
        if (sql.includes('FROM ai_settings')) return { rows: [] };
        if (sql.includes('FROM consultations WHERE id = $1 AND circle_id = $2')) {
            return { rows: [{ doctor_name: 'Dr. Erfunden', specialty: 'Kardiologie', reason: 'Kontrolle Blutdruck', date: '2026-12-01', created_date: '2026-11-30', summary_status: 'none', summary_source: null }] };
        }
        if (sql.includes('SELECT transcript FROM consultation_recordings')) return { rows: [{ transcript: 'Ramipril bitte auf 2,5 mg einmal morgens.' }] };
        if (sql.includes('FROM consultation_questions')) return { rows: [{ id: 'frage-1', text: 'Gibt es einen neuen Medikamentenplan?' }] };
        if (sql.includes('SELECT u.language')) return { rows: [{ language: 'de' }] };
        if (sql.includes('FROM consultation_vocabulary')) return { rows: [{ id: 'w1', term: 'Torasemid', created_at: '' }] };
        if (sql.includes('FROM medications WHERE circle_id')) return { rows: [{ name: 'Ramipril' }] };
        // Namen von Aerzten und Verordnenden: duerfen bei Infomaniak nie abgefragt werden.
        if (sql.includes('SELECT doctor_name AS v')) return { rows: [{ v: 'Dr. Verordner' }] };
        if (sql.startsWith('UPDATE consultations SET summary')) return { rows: [{ id: 'g1' }] };
        return { rows: [] };
    },
    getClient: async () => { throw new Error('keine Datenbank im Test'); },
}));
vi.mock('../../server/src/utils/crypto', () => ({
    decryptCredentials: () => ({ apiKey: 'test-token' }),
    encryptCredentials: () => 'x',
}));
vi.mock('../../server/src/utils/safeFetch', () => ({
    safeFetch: async (url: string, init: RequestInit) => {
        state.requests.push({ url, body: typeof init.body === 'string' ? init.body : '' });
        if (state.replyStatus !== 200) return new Response('{}', { status: state.replyStatus });
        return new Response(JSON.stringify({ choices: [{ message: { content: state.reply } }] }), { status: 200 });
    },
}));
vi.mock('../../server/src/lib/broadcaster', () => ({ broadcastToCircle: async () => {}, broadcast: () => {} }));
vi.mock('../../server/src/lib/notifications', () => ({ createNotification: async () => {} }));

import {
    parseInfomaniakRow,
    infomaniakTranscribe,
    infomaniakComplete,
    testInfomaniak,
    errorForStatus,
    InfomaniakError,
    INFOMANIAK_MAX_AUDIO_BYTES,
    type Deps,
    type InfomaniakSettings,
} from '../../server/src/modules/consultations/infomaniak';
import { summarizeConsultation } from '../../server/src/modules/consultations/processing';

const SETTINGS: InfomaniakSettings = { token: 'test-token', productId: '4711', whisperModel: 'whisper', summaryModel: 'testmodell' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Antworten der Reihe nach, merkt sich jede Anfrage. */
function fakeDeps(responses: Array<Response | Error>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let clock = 0;
    const deps: Deps = {
        fetch: async (url, init) => {
            calls.push({ url, init });
            const next = responses.shift();
            if (!next) throw new Error('keine Antwort mehr');
            if (next instanceof Error) throw next;
            return next;
        },
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
    };
    return { deps, calls };
}

const audio = { data: Buffer.from('opus'), mimeType: 'audio/webm;codecs=opus', fileName: 'consultation.webm' };

describe('Infomaniak: Einstellung lesen', () => {
    it('braucht Token und eine Produkt-ID aus Ziffern', () => {
        const row = (config: Record<string, unknown>) => ({ encrypted_credentials: 'x', config });
        const dec = () => ({ apiKey: 'tok' });
        expect(parseInfomaniakRow(row({ product_id: '4711' }), dec)).toEqual({ token: 'tok', productId: '4711', whisperModel: 'whisper', summaryModel: '' });
        expect(parseInfomaniakRow(row({ product_id: '47/../11' }), dec)).toBeNull();
        expect(parseInfomaniakRow(row({}), dec)).toBeNull();
        expect(parseInfomaniakRow({ encrypted_credentials: null, config: { product_id: '1' } }, dec)).toBeNull();
        expect(parseInfomaniakRow(row({ product_id: '1' }), () => { throw new Error('kaputt'); })).toBeNull();
        expect(parseInfomaniakRow(undefined)).toBeNull();
    });
});

describe('Infomaniak: Mitschrift', () => {
    it('schickt das Audio, fragt das Ergebnis ab, bis es fertig ist', async () => {
        const { deps, calls } = fakeDeps([
            json({ batch_id: 'a2cc35ef-5616-4ba1-976e-cf6e48b50edf' }),
            json({ status: 'pending', data: null }),
            json({ status: 'success', data: 'Ramipril 2,5 mg.\n' }),
        ]);
        const text = await infomaniakTranscribe(SETTINGS, audio, { language: 'de', prompt: 'Fachbegriffe: Ramipril.', timeoutMs: 60_000 }, deps);
        expect(text).toBe('Ramipril 2,5 mg.');
        expect(calls[0].url).toBe('https://api.infomaniak.com/1/ai/4711/openai/audio/transcriptions');
        const form = calls[0].init.body as FormData;
        expect(form.get('model')).toBe('whisper');
        expect(form.get('language')).toBe('de');
        expect(form.get('response_format')).toBe('text');
        expect(form.get('prompt')).toBe('Fachbegriffe: Ramipril.');
        expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
        expect(calls[1].url).toBe('https://api.infomaniak.com/1/ai/4711/results/a2cc35ef-5616-4ba1-976e-cf6e48b50edf');
        expect(calls).toHaveLength(3);
    });

    it('nimmt auch die Antwort mit { result, data } an', async () => {
        const { deps } = fakeDeps([
            json({ result: 'success', data: { batch_id: 'b1' } }),
            json({ result: 'success', data: { status: 'success', data: 'Hallo' } }),
        ]);
        expect(await infomaniakTranscribe(SETTINGS, audio, { language: 'de', prompt: '', timeoutMs: 60_000 }, deps)).toBe('Hallo');
    });

    it('lehnt Aufnahmen ueber 25 MB ab, ohne etwas zu senden', async () => {
        const { deps, calls } = fakeDeps([]);
        const big = { ...audio, data: Buffer.alloc(INFOMANIAK_MAX_AUDIO_BYTES + 1) };
        await expect(infomaniakTranscribe(SETTINGS, big, { language: 'de', prompt: '', timeoutMs: 1 }, deps))
            .rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE', retryable: false });
        expect(calls).toHaveLength(0);
    });

    it('unbekannter Status, leerer Text, keine batch_id und Zeitueberschreitung sind Fehler', async () => {
        const run = (responses: Response[], timeoutMs = 60_000) =>
            infomaniakTranscribe(SETTINGS, audio, { language: 'de', prompt: '', timeoutMs }, fakeDeps(responses).deps);
        await expect(run([json({ batch_id: 'b1' }), json({ status: 'error' })])).rejects.toMatchObject({ code: 'INFOMANIAK_FAILED', retryable: true });
        await expect(run([json({ batch_id: 'b1' }), json({ status: 'success', data: '  ' })])).rejects.toMatchObject({ code: 'EMPTY_TRANSCRIPT' });
        await expect(run([json({})])).rejects.toMatchObject({ code: 'INFOMANIAK_INVALID_RESPONSE' });
        await expect(run([json({ batch_id: '../x' })])).rejects.toMatchObject({ code: 'INFOMANIAK_INVALID_RESPONSE' });
        await expect(run([json({ batch_id: 'b1' }), json({ status: 'pending' }), json({ status: 'pending' })], 6_000))
            .rejects.toMatchObject({ code: 'INFOMANIAK_UNAVAILABLE', retryable: true });
    });

    it('Netzfehler darf wiederholt werden', async () => {
        const { deps } = fakeDeps([new Error('ECONNRESET')]);
        await expect(infomaniakTranscribe(SETTINGS, audio, { language: 'de', prompt: '', timeoutMs: 1 }, deps))
            .rejects.toMatchObject({ code: 'INFOMANIAK_UNAVAILABLE', retryable: true });
    });

    it('ordnet HTTP-Fehler zu (Token, Zahlung, Produkt, Datei, Ueberlast)', () => {
        const pick = (s: number) => { const e = errorForStatus(s); return [e.code, e.retryable]; };
        expect(pick(401)).toEqual(['INFOMANIAK_UNAUTHORIZED', false]);
        expect(pick(403)).toEqual(['INFOMANIAK_UNAUTHORIZED', false]);
        expect(pick(402)).toEqual(['INFOMANIAK_PAYMENT', false]);
        expect(pick(404)).toEqual(['INFOMANIAK_NOT_FOUND', false]);
        expect(pick(422)).toEqual(['AUDIO_REJECTED', false]);
        expect(pick(429)).toEqual(['INFOMANIAK_UNAVAILABLE', true]);
        expect(pick(503)).toEqual(['INFOMANIAK_UNAVAILABLE', true]);
        expect(pick(400)).toEqual(['INFOMANIAK_BAD_REQUEST', false]);
    });
});

describe('Infomaniak: Zusammenfassung', () => {
    it('ruft die Chat-Route mit temperature 0 auf und liest JSON auch nach <think>', async () => {
        const { deps, calls } = fakeDeps([json({ choices: [{ message: { content: '<think>{ nicht das }</think>{"overview":"Gut."}' } }] })]);
        const out = await infomaniakComplete(SETTINGS, { system: 'S', user: 'U', jsonSchema: {} }, 1000, deps);
        expect(out).toEqual({ overview: 'Gut.' });
        expect(calls[0].url).toBe('https://api.infomaniak.com/2/ai/4711/openai/v1/chat/completions');
        const body = JSON.parse(String(calls[0].init.body));
        expect(body.temperature).toBe(0);
        expect(body.model).toBe('testmodell');
    });

    it('B4: schickt das Antwortschema mit, als response_format und im Auftrag', async () => {
        const schema = { type: 'object', properties: { next_steps: { type: 'array' } } };
        const { deps, calls } = fakeDeps([json({ choices: [{ message: { content: '{"next_steps":[]}' } }] })]);
        await infomaniakComplete(SETTINGS, { system: 'S', user: 'U', jsonSchema: schema }, 1000, deps);
        const body = JSON.parse(String(calls[0].init.body));
        expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'antwort', schema } });
        expect(body.messages[0].content).toContain(JSON.stringify(schema));
    });

    it('B4: lehnt Infomaniak response_format ab (400), einmal ohne wiederholen', async () => {
        const { deps, calls } = fakeDeps([json({}, 400), json({ choices: [{ message: { content: '{"overview":"Gut."}' } }] })]);
        expect(await infomaniakComplete(SETTINGS, { system: 'S', user: 'U', jsonSchema: {} }, 1000, deps)).toEqual({ overview: 'Gut.' });
        expect(calls).toHaveLength(2);
        expect(JSON.parse(String(calls[1].init.body)).response_format).toBeUndefined();
        expect(JSON.parse(String(calls[1].init.body)).messages[0].content).toContain('JSON-Schema');
    });

    it('ohne Modell wird nichts gesendet', async () => {
        const { deps, calls } = fakeDeps([]);
        await expect(infomaniakComplete({ ...SETTINGS, summaryModel: '' }, { system: 'S', user: 'U', jsonSchema: {} }, 1000, deps))
            .rejects.toBeInstanceOf(InfomaniakError);
        expect(calls).toHaveLength(0);
    });

    beforeEach(() => {
        state.sql = [];
        state.requests = [];
        state.infomaniak = { encrypted_credentials: 'verschluesselt', config: { product_id: '4711', summary_model: 'testmodell' } };
        state.replyStatus = 200;
        state.reply = JSON.stringify({ overview: 'Ramipril wird reduziert.', findings: [], medication_changes: [], recommendations: [], next_steps: [], question_answers: [], unclear: [], appointments: [], family_notes: [] });
    });

    it('sendet Mitschrift, Fragen, Fachwoerter und Fachrichtung, aber keinen Arztnamen, kein Datum, keinen Anlass', async () => {
        expect(await summarizeConsultation('g1', 'kreis-1')).toBeNull();
        expect(state.requests).toHaveLength(1);
        const sent = state.requests[0].body;
        expect(state.requests[0].url).toContain('api.infomaniak.com/2/ai/4711/');
        for (const must of ['Ramipril bitte auf 2,5 mg', 'Gibt es einen neuen Medikamentenplan?', 'Torasemid', 'Kardiologie']) {
            expect(sent, must).toContain(must);
        }
        for (const never of ['Dr. Erfunden', 'Dr. Verordner', '2026-12-01', '2026-11-30', 'Kontrolle Blutdruck']) {
            expect(sent, never).not.toContain(never);
        }
        // B4: Schema geht mit (next_steps, appointments, question_answers).
        expect(JSON.parse(sent).response_format?.type).toBe('json_schema');
        for (const field of ['next_steps', 'appointments', 'question_answers']) expect(sent).toContain(field);
        // Die KI des Kreises (Assistent, Sprachbefehle) wird dabei nicht gelesen.
        expect(state.sql.some((s) => s.includes('FROM ai_settings'))).toBe(false);
    });

    it('nicht behebbarer Fehler gibt einen Hinweis-Code zurueck, die Mitschrift bleibt', async () => {
        state.replyStatus = 402;
        expect(await summarizeConsultation('g1', 'kreis-1')).toBe('INFOMANIAK_PAYMENT');
    });

    it('ohne Modell und ohne lokale KI: nur Mitschrift (SUMMARY_MODEL_MISSING), nichts gesendet', async () => {
        state.infomaniak = { encrypted_credentials: 'x', config: { product_id: '4711' } };
        expect(await summarizeConsultation('g1', 'kreis-1')).toBe('SUMMARY_MODEL_MISSING');
        expect(state.requests).toHaveLength(0);
    });

    it('ohne Infomaniak bleibt es beim lokalen Weg (ohne KI: AI_NOT_CONFIGURED)', async () => {
        state.infomaniak = null;
        expect(await summarizeConsultation('g1', 'kreis-1')).toBe('AI_NOT_CONFIGURED');
        expect(state.requests).toHaveLength(0);
    });
});

describe('Infomaniak: Verbindungstest', () => {
    it('prueft Token und Produkt-ID', async () => {
        expect(await testInfomaniak('t', '4711', fakeDeps([json({ data: [{ product_id: 4711 }] })]).deps)).toBe('ok');
        expect(await testInfomaniak('t', '471', fakeDeps([json({ data: [{ product_id: 4711 }] })]).deps)).toBe('product');
        expect(await testInfomaniak('t', 'abc', fakeDeps([]).deps)).toBe('product');
        expect(await testInfomaniak('t', '4711', fakeDeps([json({}, 401)]).deps)).toBe('unauthorized');
        expect(await testInfomaniak('t', '4711', fakeDeps([new Error('weg')]).deps)).toBe('unreachable');
    });
});

describe('Infomaniak: Abgrenzung (nur Arztgespraech)', () => {
    it('nur das Arztgespraech-Modul und die Einstellungsseite kennen Infomaniak', () => {
        const root = join(__dirname, '../../server/src');
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (statSync(p).isDirectory()) walk(p);
                else if (p.endsWith('.ts')) files.push(p);
            }
        };
        walk(root);
        const users = files
            .filter((f) => /infomaniak/i.test(readFileSync(f, 'utf8')))
            .map((f) => f.slice(root.length + 1).replace(/\\/g, '/'))
            .sort();
        expect(users).toEqual([
            'lib/i18n.ts',
            'modules/consultations/infomaniak.ts',
            'modules/consultations/processing.ts',
            'routes/integrations.ts',
        ]);
    });

    it('Infomaniak steht nicht in der Liste der lokalen Dienste', () => {
        const local = readFileSync(join(__dirname, '../../server/src/modules/consultations/localOnly.ts'), 'utf8');
        expect(local).not.toMatch(/infomaniak/i);
    });
});
