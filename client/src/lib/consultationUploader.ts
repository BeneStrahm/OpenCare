/**
 * Warteschlange fuer Aufnahmen von Arztgespraechen.
 *
 * Aufnahmen liegen lokal in IndexedDB (consultationStore.ts) und werden in
 * Stuecken hochgeladen, sobald der Server erreichbar ist:
 *   1. POST /api/consultations/recordings      (idempotent ueber client_id)
 *   2. PUT  .../recordings/:clientId/chunks/:i  fuer jedes fehlende Stueck
 *   3. POST .../recordings/:clientId/complete   (409 → fehlende nachsenden)
 * Erst nach erfolgreichem complete werden die lokalen Daten geloescht.
 *
 * Ausloeser: App-Start, Event 'online', alle 60 s solange die App offen ist,
 * und direkt nach dem Ende einer Aufnahme (kick()).
 *
 * Eigenes fetch statt lib/api.ts: api.ts kennt keine Binaerdaten, und die
 * Kreis-ID kommt hier aus der Aufnahme selbst, nicht aus dem aktiven Kreis.
 */
import i18n from '../i18n';
import { getKioskToken } from './kioskDevice';
import { backoffDelay, missingChunks } from './consultationLogic';
import {
    deleteRecording,
    getChunk,
    isLocalStoreAvailable,
    listChunkIndexes,
    listRecordings,
    updateRecording,
    type LocalRecording,
} from './consultationStore';

const IS_DEMO = Boolean(import.meta.env.VITE_DEMO);

// Gleiche API-URL wie lib/api.ts und lib/offlineQueue.ts (bewusst dupliziert,
// um keinen Import-Zyklus mit api.ts zu erzeugen).
const rawApiUrl = import.meta.env.VITE_API_URL as string | undefined;
const API_URL = rawApiUrl !== undefined
    ? rawApiUrl
    : (import.meta.env.PROD ? '' : 'http://localhost:3001');

const BASE = '/api/consultations/recordings';
const INTERVAL_MS = 60_000;
const MAX_COMPLETE_ROUNDS = 3;


export interface UploadProgress {
    client_id: string;
    sent: number;
    total: number;
}

export interface UploaderState {
    /** Lokal wartende Aufnahmen (ohne die gerade laufende Aufnahme) */
    pending: number;
    /** Aufnahme, die gerade hochgeladen wird */
    progress: UploadProgress | null;
    /** Letzter Fehler je Aufnahme (Netz oder Server), fuer die Anzeige */
    errors: Record<string, string>;
    /** Gerade offline (letzter Versuch scheiterte am Netz) */
    offline: boolean;
    /** Zuletzt hochgeladene Aufnahme: client_id → consultation_id (fuer Weiterleitung) */
    lastCompleted: { client_id: string; consultation_id: string | null } | null;
}

type Listener = (state: UploaderState) => void;

const listeners = new Set<Listener>();
let state: UploaderState = { pending: 0, progress: null, errors: {}, offline: false, lastCompleted: null };
let running = false;
let rerun = false;
let started = false;
let backoffUntil = 0;
let backoffStep = 0;


/** client_ids, die in DIESEM Fenster gerade aufgenommen werden. */
const activeRecordings = new Set<string>();

function setState(patch: Partial<UploaderState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
}

export function getUploaderState(): UploaderState {
    return state;
}

export function subscribeUploader(listener: Listener): () => void {
    listeners.add(listener);
    listener(state);
    return () => {
        listeners.delete(listener);
    };
}

export function markRecordingActive(clientId: string, active: boolean): void {
    if (active) activeRecordings.add(clientId);
    else activeRecordings.delete(clientId);
}

class NetworkError extends Error {}

class HttpError extends Error {
    constructor(public status: number, public code: string | null, public body: any) {
        super(code || `HTTP ${status}`);
    }
}

function headersFor(recording: LocalRecording, json: boolean): Record<string, string> {
    const headers: Record<string, string> = { 'Accept-Language': i18n.language || 'de' };
    if (json) headers['Content-Type'] = 'application/json';
    const kioskToken = getKioskToken();
    if (recording.from_kiosk && kioskToken) {
        headers['X-Kiosk-Token'] = kioskToken;
    } else {
        const token = localStorage.getItem('token');
        if (token) headers.Authorization = `Bearer ${token}`;
        if (recording.circle_id) headers['X-Circle-Id'] = recording.circle_id;
        if (kioskToken && !token) headers['X-Kiosk-Token'] = kioskToken;
    }
    return headers;
}

async function call(recording: LocalRecording, method: string, path: string, body?: unknown | Blob): Promise<any> {
    const isBlob = typeof Blob !== 'undefined' && body instanceof Blob;
    const headers = headersFor(recording, !isBlob && body !== undefined);
    if (isBlob) headers['Content-Type'] = 'application/octet-stream';
    let response: Response;
    try {
        response = await fetch(`${API_URL}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : isBlob ? (body as Blob) : JSON.stringify(body),
        });
    } catch {
        throw new NetworkError('network');
    }
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json().catch(() => null) : null;
    if (!response.ok) {
        throw new HttpError(response.status, data?.error ?? null, data);
    }
    return data;
}

/** Fehlende Stuecke senden. Gibt die Zahl gesendeter Stuecke zurueck. */
async function sendChunks(recording: LocalRecording, indexes: number[], total: number, alreadySent: number): Promise<number> {
    let sent = alreadySent;
    for (const index of indexes) {
        const blob = await getChunk(recording.client_id, index);
        if (!blob) {
            throw new HttpError(0, 'LOCAL_CHUNK_MISSING', null);
        }
        await call(recording, 'PUT', `${BASE}/${encodeURIComponent(recording.client_id)}/chunks/${index}`, blob);
        sent += 1;
        setState({ progress: { client_id: recording.client_id, sent, total } });
    }
    return sent;
}

/**
 * Eine Aufnahme, deren Fenster abgestuerzt oder geschlossen wurde, waehrend
 * sie noch lief: Sie wird mit den bis dahin gespeicherten Stuecken beendet.
 */
async function finalizeAbandoned(recording: LocalRecording): Promise<LocalRecording | null> {
    const indexes = await listChunkIndexes(recording.client_id);
    // Nur zusammenhaengende Stuecke ab 0 ergeben eine abspielbare Datei.
    let count = 0;
    while (indexes[count] === count) count += 1;
    if (count === 0) {
        await deleteRecording(recording.client_id);
        return null;
    }
    const started = Date.parse(recording.started_at);
    const duration = Number.isNaN(started) ? null : Math.max(0, Math.round((recording.updated_at - started) / 1000));
    const patch: Partial<LocalRecording> = { state: 'pending', total_chunks: count, duration_seconds: duration };
    await updateRecording(recording.client_id, patch);
    return { ...recording, ...patch };
}

async function uploadOne(recording: LocalRecording): Promise<void> {
    const total = recording.total_chunks ?? 0;
    const init = await call(recording, 'POST', BASE, {
        client_id: recording.client_id,
        consultation_id: recording.consultation_id,
        consent_confirmed: true,
        mime_type: recording.mime_type,
        started_at: recording.started_at,
    });
    const received: number[] = Array.isArray(init?.data?.received) ? init.data.received : [];
    const consultationId: string | null = init?.data?.consultation_id ?? recording.consultation_id;

    let toSend = missingChunks(total, received);
    let sent = total - toSend.length;
    setState({ progress: { client_id: recording.client_id, sent, total } });

    for (let round = 0; round < MAX_COMPLETE_ROUNDS; round++) {
        sent = await sendChunks(recording, toSend, total, sent);
        try {
            await call(recording, 'POST', `${BASE}/${encodeURIComponent(recording.client_id)}/complete`, {
                total_chunks: total,
                duration_seconds: recording.duration_seconds ?? 0,
            });
            await deleteRecording(recording.client_id);
            const errors = { ...state.errors };
            delete errors[recording.client_id];
            setState({ errors, lastCompleted: { client_id: recording.client_id, consultation_id: consultationId } });
            return;
        } catch (error) {
            if (error instanceof HttpError && error.status === 409 && Array.isArray(error.body?.missing)) {
                toSend = (error.body.missing as unknown[]).filter((n): n is number => Number.isInteger(n));
                sent = total - toSend.length;
                continue;
            }
            throw error;
        }
    }
    throw new HttpError(409, 'MISSING_CHUNKS', null);
}

async function runOnce(): Promise<void> {
    const recordings = await listRecordings();
    const queue: LocalRecording[] = [];
    for (const rec of recordings) {
        if (rec.state === 'recording') {
            if (activeRecordings.has(rec.client_id)) continue;
            const finalized = await finalizeAbandoned(rec);
            if (finalized) queue.push(finalized);
        } else if (rec.total_chunks && rec.total_chunks > 0) {
            queue.push(rec);
        }
    }
    setState({ pending: queue.length });

    for (const rec of queue) {
        try {
            await uploadOne(rec);
            backoffStep = 0;
            setState({ offline: false, pending: Math.max(0, state.pending - 1), progress: null });
        } catch (error) {
            setState({ progress: null });
            if (error instanceof NetworkError) {
                setState({ offline: true });
                return; // spaeter erneut versuchen, die Reihenfolge bleibt
            }
            if (error instanceof HttpError && (error.status === 429 || error.status >= 500)) {
                // Server ueberlastet oder gestoert: nicht sofort wiederholen.
                backoffUntil = Date.now() + backoffDelay(backoffStep);
                backoffStep += 1;
                setState({ offline: false });
                return;
            }
            const code = error instanceof HttpError ? (error.code || `HTTP ${error.status}`) : 'UNKNOWN';
            await updateRecording(rec.client_id, { last_error: code }).catch(() => undefined);
            setState({ offline: false, errors: { ...state.errors, [rec.client_id]: code } });
            // 401/403: Anmeldung fehlt, die Aufnahme bleibt erhalten.
        }
    }
}

/** Warteschlange jetzt abarbeiten (mehrfache Aufrufe werden zusammengefasst). */
export async function kick(): Promise<void> {
    if (IS_DEMO || !isLocalStoreAvailable()) return;
    if (Date.now() < backoffUntil) return;
    if (running) {
        rerun = true;
        return;
    }
    running = true;
    try {
        do {
            rerun = false;
            await runOnce();
        } while (rerun);
    } catch (error) {
        console.warn('[consultationUploader] run failed:', error);
    } finally {
        running = false;
    }
}

/** Lokale Aufnahme verwerfen (nur auf ausdruecklichen Wunsch). */
export async function discardLocalRecording(clientId: string): Promise<void> {
    await deleteRecording(clientId);
    const errors = { ...state.errors };
    delete errors[clientId];
    setState({ errors });
    void kick();
}

/** Einmal beim App-Start aufrufen. */
export function startConsultationUploader(): void {
    if (started || IS_DEMO || typeof window === 'undefined' || !isLocalStoreAvailable()) return;
    started = true;
    window.addEventListener('online', () => void kick());
    window.setInterval(() => void kick(), INTERVAL_MS);
    // Kurz warten, bis Anmeldung und Kreis geladen sind.
    window.setTimeout(() => void kick(), 3_000);
}
