import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Arztgespraech (E59 bis E61): Rechte aller fuenf Rollen, Sperre nach beiden Freigaben,
 * Freigabe zuruecknehmen, Audio-Endpunkt, Standardfrage, Verknuepfung mit dem Termin.
 * Ohne Datenbank: die Abfragen werden von einem kleinen Ersatz beantwortet.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const EVENT = '44444444-4444-4444-8444-444444444444';
const QID = '55555555-5555-4555-8555-555555555555';

const db = vi.hoisted(() => ({
    role: 'admin' as string,
    c: null as Record<string, unknown> | null,
    recording: null as Record<string, unknown> | null,
    chunks: [] as Buffer[],
    event: null as { id: string; category: string } | null,
    eventTaken: false,
    eventOwn: true,
    log: [] as Array<{ sql: string; params: unknown[] }>,
}));

const handle = async (sql: string, params: unknown[] = []) => {
    db.log.push({ sql, params });
    if (sql.includes('SELECT id, role FROM circle_members')) return { rows: [{ id: 'mitglied-1', role: db.role }] };
    if (sql.includes('FROM consultations c') && sql.includes('WHERE c.id = $1')) {
        return { rows: db.c && params[0] === db.c.id ? [{ ...db.c }] : [] };
    }
    if (sql.includes('INSERT INTO consultation_questions')) {
        return { rows: [{ id: QID, text: params[2], answer: null, position: 0, created_at: '' }] };
    }
    if (sql.includes('DELETE FROM consultation_questions')) return { rows: [{ id: params[0] }] };
    if (sql.includes('UPDATE consultation_questions')) return { rows: [{ id: QID }] };
    if (sql.includes("UPDATE consultations SET summary_status = 'draft'") && db.c) {
        db.c.summary_status = 'draft';
        return { rows: [] };
    }
    if (sql.includes("UPDATE consultations SET transcript_status = 'draft'") && db.c) {
        db.c.transcript_status = 'draft';
        return { rows: [] };
    }
    if (sql.includes('SELECT id, mime_type, status, audio_deleted_at FROM consultation_recordings')) {
        return { rows: db.recording ? [db.recording] : [] };
    }
    if (sql.includes('SELECT chunk_index FROM consultation_recording_chunks')) {
        return { rows: db.chunks.map((_, i) => ({ chunk_index: i })) };
    }
    if (sql.includes('SELECT data FROM consultation_recording_chunks WHERE recording_id = $1 AND chunk_index = $2')) {
        return { rows: [{ data: db.chunks[params[1] as number] }] };
    }
    if (sql.includes('SELECT e.id, e.category FROM events')) return { rows: db.event && params[0] === db.event.id ? [db.event] : [] };
    if (sql.includes('SELECT id FROM consultations WHERE event_id')) return { rows: db.eventTaken ? [{ id: ID }] : [] };
    if (sql.includes("created_by = $2 AND category = 'doctor'")) return { rows: db.eventOwn ? [{}] : [] };
    if (sql.includes('INSERT INTO consultations')) {
        db.c = { id: NEW_ID, circle_id: 'kreis-1', event_id: params[6], transcript_status: 'none', summary_status: 'none' };
        return { rows: [{ id: NEW_ID }] };
    }
    return { rows: [] };
};

vi.mock('../../server/src/db', () => ({
    query: (sql: string, params?: unknown[]) => handle(sql, params),
    getClient: async () => ({ query: (sql: string, params?: unknown[]) => handle(sql, params), release: () => {} }),
}));
vi.mock('../../server/src/middleware/auth', () => ({
    authMiddleware: (req: { userId?: string }, _res: unknown, next: () => void) => { req.userId = 'konto-1'; next(); },
}));
vi.mock('../../server/src/lib/broadcaster', () => ({ broadcastToCircle: async () => {}, broadcast: () => {} }));
vi.mock('../../server/src/lib/notifications', () => ({ createNotification: async () => {} }));

import { consultationsRouter, recordingsRouter, isLocked } from '../../server/src/modules/consultations/routes';
import { CIRCLE_ROLES } from '../../server/src/middleware/circle';

type Result = { status: number; body: Record<string, unknown> | null; headers: Record<string, string>; raw: Buffer };

/** Schickt eine Anfrage durch den Router wie unter /api/consultations bzw. /api/consultations/recordings. */
function call(role: string, method: string, path: string, body: unknown = {}, lang = 'de'): Promise<Result> {
    db.role = role;
    const recordings = path.startsWith('/recordings');
    const router = recordings ? recordingsRouter : consultationsRouter;
    const local = recordings ? path.slice('/recordings'.length) || '/' : path;
    return new Promise((resolve, reject) => {
        const out: Result = { status: 200, body: null, headers: {}, raw: Buffer.alloc(0) };
        const res = {
            headersSent: false,
            destroyed: false,
            status(code: number) { out.status = code; return this; },
            json(data: Record<string, unknown>) { out.body = data; resolve(out); return this; },
            setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = v; },
            write(chunk: Buffer) { out.raw = Buffer.concat([out.raw, chunk]); this.headersSent = true; return true; },
            end() { resolve(out); },
            once() {},
            destroy() { resolve(out); },
        };
        const req = {
            method,
            url: local,
            originalUrl: `/api/consultations${path}`,
            headers: { 'x-circle-id': 'kreis-1', 'accept-language': lang },
            body,
            params: {},
            query: {},
        };
        (router as unknown as { handle: (q: unknown, r: unknown, next: (e?: unknown) => void) => void })
            .handle(req, res, (err) => (err ? reject(err) : resolve({ ...out, status: 404 })));
    });
}

const consultation = (extra: Record<string, unknown> = {}) => ({
    id: ID, circle_id: 'kreis-1', doctor_name: 'Dr. Test', specialty: null, scheduled_at: '2026-12-01T10:00:00',
    location: null, reason: null, event_id: null, summary_status: 'draft', transcript_status: 'draft', ...extra,
});

beforeEach(() => {
    db.c = consultation();
    db.recording = { id: REC, mime_type: 'audio/webm;codecs=opus', status: 'done', audio_deleted_at: null };
    db.chunks = [Buffer.from('teil-1'), Buffer.from('teil-2')];
    db.event = { id: EVENT, category: 'doctor' };
    db.eventTaken = false;
    db.eventOwn = true;
    db.log = [];
});

const ROLES = ['admin', 'family', 'professional', 'neighbor', 'recipient'];

describe('Arztgespraech: Rechte aller fuenf Rollen', () => {
    it('die Liste der Rollen ist vollstaendig', () => {
        expect([...CIRCLE_ROLES].sort()).toEqual([...ROLES].sort());
    });

    const MATRIX: Array<[string, string, string, unknown, string[]]> = [
        ['Gespraech lesen', 'GET', `/${ID}`, {}, ['admin', 'family', 'professional', 'recipient']],
        ['Frage hinzufuegen', 'POST', `/${ID}/questions`, { text: 'Wie lange noch?' }, ['admin', 'family', 'recipient']],
        ['Frage loeschen', 'DELETE', `/${ID}/questions/${QID}`, {}, ['admin', 'family', 'recipient']],
        ['Frage aendern', 'PUT', `/${ID}/questions/${QID}`, { text: 'Neu' }, ['admin', 'family']],
        ['Angaben aendern', 'PUT', `/${ID}`, { doctor_name: 'Dr. Neu' }, ['admin', 'family', 'recipient']],
        ['Mitschrift freigeben zuruecknehmen', 'POST', `/${ID}/transcript/unapprove`, {}, ['admin', 'family']],
        ['Zusammenfassung zuruecknehmen', 'POST', `/${ID}/summary/unapprove`, {}, ['admin', 'family']],
        ['Gespraech loeschen', 'DELETE', `/${ID}`, {}, ['admin', 'family']],
        ['Audio abspielen', 'GET', `/recordings/${REC}/audio`, {}, ['admin', 'family', 'professional', 'recipient']],
        ['Audio loeschen', 'DELETE', `/recordings/${REC}/audio`, {}, ['admin', 'family']],
    ];

    for (const [name, method, path, body, allowed] of MATRIX) {
        it(name, async () => {
            for (const role of ROLES) {
                db.c = consultation({ transcript_status: 'approved', summary_status: 'approved' });
                // Fuer "zuruecknehmen" muss eine Freigabe da sein; fuer alles andere keine Sperre.
                if (!path.endsWith('unapprove')) db.c = consultation();
                const r = await call(role, method, path, body);
                if (allowed.includes(role)) expect(r.status, `${role} ${method} ${path}`).not.toBe(403);
                else expect(r.status, `${role} ${method} ${path}`).toBe(403);
            }
        });
    }
});

describe('Arztgespraech: Sperre nach beiden Freigaben', () => {
    it('isLocked nur, wenn Mitschrift und Zusammenfassung freigegeben sind', () => {
        expect(isLocked({ transcript_status: 'approved', summary_status: 'approved' })).toBe(true);
        expect(isLocked({ transcript_status: 'approved', summary_status: 'draft' })).toBe(false);
        expect(isLocked({ transcript_status: 'draft', summary_status: 'approved' })).toBe(false);
        expect(isLocked({})).toBe(false);
    });

    it('gesperrt fuer alle Rollen: Fragen, Angaben, neue Aufnahmen', async () => {
        const locked = () => { db.c = consultation({ transcript_status: 'approved', summary_status: 'approved' }); };
        const recording = { consent_confirmed: true, client_id: '66666666-6666-4666-8666-666666666666', mime_type: 'audio/webm', consultation_id: ID };
        for (const role of ['admin', 'family', 'recipient']) {
            locked();
            expect((await call(role, 'POST', `/${ID}/questions`, { text: 'Noch eine' })).body?.error).toBe('CONSULTATION_LOCKED');
            expect((await call(role, 'DELETE', `/${ID}/questions/${QID}`)).body?.error).toBe('CONSULTATION_LOCKED');
            expect((await call(role, 'PUT', `/${ID}`, { doctor_name: 'Dr. Neu' })).body?.error).toBe('CONSULTATION_LOCKED');
            expect((await call(role, 'POST', '/recordings', recording)).body?.error).toBe('CONSULTATION_LOCKED');
        }
        locked();
        expect((await call('family', 'PUT', `/${ID}/questions/${QID}`, { text: 'x' })).status).toBe(409);
        const detail = await call('recipient', 'GET', `/${ID}`);
        expect((detail.body?.data as { consultation: { locked: boolean } }).consultation.locked).toBe(true);
    });

    it('ohne Sperre darf recipient Fragen hinzufuegen', async () => {
        db.c = consultation({ transcript_status: 'approved', summary_status: 'draft' });
        expect((await call('recipient', 'POST', `/${ID}/questions`, { text: 'Darf ich Rad fahren?' })).status).toBe(200);
    });
});

describe('Arztgespraech: Freigabe zuruecknehmen', () => {
    it('Mitschrift zuruecknehmen hebt die Sperre auf', async () => {
        db.c = consultation({ transcript_status: 'approved', summary_status: 'approved' });
        const r = await call('family', 'POST', `/${ID}/transcript/unapprove`);
        expect(r.status).toBe(200);
        expect((r.body?.data as { locked: boolean; transcript_status: string })).toMatchObject({ locked: false, transcript_status: 'draft' });
        expect((await call('recipient', 'POST', `/${ID}/questions`, { text: 'Wieder offen' })).status).toBe(200);
    });

    it('Zusammenfassung zuruecknehmen hebt die Sperre auf', async () => {
        db.c = consultation({ transcript_status: 'approved', summary_status: 'approved' });
        const r = await call('admin', 'POST', `/${ID}/summary/unapprove`);
        expect(r.status).toBe(200);
        expect((r.body?.data as { locked: boolean })).toMatchObject({ locked: false });
    });

    it('ohne Freigabe: NOT_APPROVED', async () => {
        db.c = consultation();
        expect((await call('family', 'POST', `/${ID}/transcript/unapprove`)).body?.error).toBe('NOT_APPROVED');
        expect((await call('family', 'POST', `/${ID}/summary/unapprove`)).body?.error).toBe('NOT_APPROVED');
    });
});

describe('Arztgespraech: Audio-Endpunkt', () => {
    it('liefert alle Teile in Reihenfolge, nie zwischengespeichert', async () => {
        const r = await call('recipient', 'GET', `/recordings/${REC}/audio`);
        expect(r.status).toBe(200);
        expect(r.raw.toString()).toBe('teil-1teil-2');
        expect(r.headers['content-type']).toBe('audio/webm');
        expect(r.headers['cache-control']).toBe('private, no-store');
    });

    it('geloescht 410, noch beim Hochladen 409, fremd oder ungueltig 404', async () => {
        db.recording = { ...db.recording!, audio_deleted_at: '2026-11-21T10:00:00Z' };
        expect((await call('family', 'GET', `/recordings/${REC}/audio`)).status).toBe(410);
        db.recording = { ...db.recording!, audio_deleted_at: null, status: 'uploading' };
        expect((await call('family', 'GET', `/recordings/${REC}/audio`)).status).toBe(409);
        db.recording = { ...db.recording!, status: 'done' };
        db.chunks = [];
        expect((await call('family', 'GET', `/recordings/${REC}/audio`)).status).toBe(410);
        db.recording = null;
        expect((await call('family', 'GET', `/recordings/${REC}/audio`)).status).toBe(404);
        expect((await call('family', 'GET', '/recordings/kein-uuid/audio')).status).toBe(404);
    });
});

describe('Arztgespraech: Standardfrage und Termin', () => {
    const questionInsert = () => db.log.find((l) => l.sql.includes('INSERT INTO consultation_questions'));

    it('jedes neue Gespraech bekommt die Standardfrage in der Sprache der Person', async () => {
        const r = await call('family', 'POST', '/', { scheduled_at: '2026-12-01T10:00', doctor_name: 'Dr. Test' });
        expect(r.status).toBe(200);
        expect(questionInsert()?.params[2]).toBe('Gibt es einen neuen Medikamentenplan?');
        expect(questionInsert()?.params[0]).toBe(NEW_ID);
        db.log = [];
        await call('recipient', 'POST', '/', { scheduled_at: '2026-12-01T10:00' }, 'en');
        expect(questionInsert()?.params[2]).toBe('Is there a new medication plan?');
    });

    it('verknuepft das Gespraech mit dem vorher angelegten Arzttermin', async () => {
        const r = await call('recipient', 'POST', '/', { scheduled_at: '2026-12-01T10:00', doctor_name: 'Dr. Test', event_id: EVENT });
        expect(r.status).toBe(200);
        const insert = db.log.find((l) => l.sql.includes('INSERT INTO consultations'));
        expect(insert?.params[6]).toBe(EVENT);
        const title = db.log.find((l) => l.sql.includes('UPDATE events SET title'));
        expect(String(title?.params[0])).toContain('Dr. Test');
        // Kein zweiter Termin ueber die Gespraechs-Route.
        expect(db.log.some((l) => l.sql.includes('INSERT INTO events'))).toBe(false);
    });

    it('Termin hat schon ein Gespraech (21.4): Angaben dort eintragen, kein zweites; fremder Termin 404, ungueltig 400', async () => {
        db.eventTaken = true;
        db.c = { id: ID, circle_id: 'kreis-1', event_id: EVENT, transcript_status: 'none', summary_status: 'none' };
        const r = await call('family', 'POST', '/', { scheduled_at: '2026-12-01T10:00', doctor_name: 'Dr. Test', event_id: EVENT });
        expect(r.status).toBe(200);
        expect(db.log.some((l) => l.sql.includes('INSERT INTO consultations'))).toBe(false);
        expect(db.log.some((l) => l.sql.includes('INSERT INTO consultation_questions'))).toBe(false);
        const update = db.log.find((l) => l.sql.includes('UPDATE consultations SET doctor_name'));
        expect(update?.params[0]).toBe('Dr. Test');
        expect(update?.params[4]).toBe(ID);
        db.eventTaken = false;
        db.event = null;
        expect((await call('family', 'POST', '/', { scheduled_at: '2026-12-01T10:00', event_id: EVENT })).status).toBe(404);
        expect((await call('family', 'POST', '/', { scheduled_at: '2026-12-01T10:00', event_id: 'kaputt' })).body?.error).toBe('INVALID_EVENT');
    });

    it('recipient verknuepft nur eigene, gerade angelegte Arzttermine', async () => {
        db.eventOwn = false;
        expect((await call('recipient', 'POST', '/', { scheduled_at: '2026-12-01T10:00', event_id: EVENT })).status).toBe(403);
        expect((await call('family', 'POST', '/', { scheduled_at: '2026-12-01T10:00', event_id: EVENT })).status).toBe(200);
    });

    it('recipient legt ueber diese Route keinen Termin an (create_event)', async () => {
        await call('recipient', 'POST', '/', { scheduled_at: '2026-12-01T10:00', create_event: true });
        expect(db.log.some((l) => l.sql.includes('INSERT INTO events'))).toBe(false);
    });
});
