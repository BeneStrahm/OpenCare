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
import { getKioskToken, getPairedDevice } from './kioskDevice';
import {
    backoffDelay,
    belongsToOwner,
    classifyUploadError,
    contiguousChunkCount,
    isAbandonedRecording,
    missingChunks,
    type KioskLastRecording,
} from './consultationLogic';
import {
    deleteRecording,
    LocalRecordingMissingError,
    reassignRecording,
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
    /** Aufnahmen mit dauerhaftem Fehler: werden nicht automatisch wiederholt */
    needsHelp: Record<string, string>;
    /** Anmeldung fehlt oder Tablet wurde entkoppelt (401) */
    authProblem: boolean;
    /** Gerade offline (letzter Versuch scheiterte am Netz) */
    offline: boolean;
    /** Zuletzt hochgeladene Aufnahme: client_id → consultation_id (fuer Weiterleitung) */
    lastCompleted: { client_id: string; consultation_id: string | null } | null;
}

type Listener = (state: UploaderState) => void;

const listeners = new Set<Listener>();
let state: UploaderState = { pending: 0, progress: null, errors: {}, needsHelp: {}, authProblem: false, offline: false, lastCompleted: null };
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

/** Wem gehoeren lokale Aufnahmen in diesem Fenster? */
export function currentOwner(): { userId: string | null; deviceId: string | null } {
    let userId: string | null = null;
    try {
        const raw = localStorage.getItem('user');
        const user = raw ? JSON.parse(raw) : null;
        userId = user && typeof user.id === 'string' ? user.id : null;
    } catch {
        userId = null;
    }
    const device = getPairedDevice();
    return { userId, deviceId: device?.id ?? null };
}

// Tablet: letzte Aufnahme merken, damit eine Folgeaufnahme zum selben Gespraech gehoert.
const KIOSK_LAST_KEY = 'opencare.consultations.kioskLast';

export function getKioskLastRecording(): KioskLastRecording | null {
    try {
        const raw = localStorage.getItem(KIOSK_LAST_KEY);
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v.client_id === 'string' && typeof v.at === 'number' ? v : null;
    } catch {
        return null;
    }
}

export function setKioskLastRecording(value: KioskLastRecording): void {
    try {
        localStorage.setItem(KIOSK_LAST_KEY, JSON.stringify(value));
    } catch {
        /* Speicher voll oder gesperrt: dann eben neues Gespraech */
    }
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
    if (recording.from_kiosk) {
        // Tablet-Aufnahmen gehen NUR mit dem Geraete-Token raus, nie als angemeldete Person.
        const kioskToken = getKioskToken();
        if (!kioskToken) throw new HttpError(401, 'DEVICE_NOT_PAIRED', null);
        headers['X-Kiosk-Token'] = kioskToken;
    } else {
        // Angehoerige senden immer als Person, auch auf einem gekoppelten Tablet.
        const token = localStorage.getItem('token');
        if (token) headers.Authorization = `Bearer ${token}`;
        if (recording.circle_id) headers['X-Circle-Id'] = recording.circle_id;
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
    // Nur zusammenhaengende Stuecke ab 0 ergeben eine abspielbare Datei.
    const count = contiguousChunkCount(await listChunkIndexes(recording.client_id));
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
    // Ohne lokal bestaetigte Einwilligung wird nichts gesendet. Aeltere
    // Datensaetze ohne das Feld entstanden nur mit bestaetigter Einwilligung.
    if (recording.consent_confirmed === false) throw new HttpError(0, 'LOCAL_CONSENT_MISSING', null);

    // Tablet-Folgeaufnahme: Gespraech der vorigen Aufnahme uebernehmen, sobald bekannt.
    let consultationIdForUpload = recording.consultation_id;
    if (!consultationIdForUpload && recording.follows_client_id) {
        const last = getKioskLastRecording();
        if (last && last.client_id === recording.follows_client_id && last.consultation_id) {
            consultationIdForUpload = last.consultation_id;
        }
    }

    let total = recording.total_chunks ?? 0;
    const init = await call(recording, 'POST', BASE, {
        client_id: recording.client_id,
        consultation_id: consultationIdForUpload,
        consent_confirmed: true,
        consent_at: recording.consent_at,
        mime_type: recording.mime_type,
        started_at: recording.started_at,
    });
    const received: number[] = Array.isArray(init?.data?.received) ? init.data.received : [];
    const consultationId: string | null = init?.data?.consultation_id ?? consultationIdForUpload;
    if (recording.from_kiosk && consultationId) {
        const last = getKioskLastRecording();
        if (last && last.client_id === recording.client_id) {
            setKioskLastRecording({ ...last, consultation_id: consultationId });
        }
        // Folgeaufnahmen, die auf diese warten, bekommen jetzt das Gespraech.
        for (const other of await listRecordings()) {
            if (other.follows_client_id === recording.client_id && !other.consultation_id) {
                await updateRecording(other.client_id, { consultation_id: consultationId, follows_client_id: null }).catch(() => undefined);
            }
        }
    }

    // Fehlt lokal ein Stueck (z. B. Speicher voll), mit den lueckenlosen
    // Stuecken abschliessen statt endlos zu scheitern.
    const local = await listChunkIndexes(recording.client_id);
    const contiguous = contiguousChunkCount(local);
    if (contiguous < total) {
        // Verfuegbar ist, was lokal ODER schon auf dem Server liegt.
        const available = contiguousChunkCount([...local, ...received]);
        if (available === 0) throw new HttpError(0, 'LOCAL_CHUNK_MISSING', null);
        total = Math.min(total, available);
        await updateRecording(recording.client_id, { total_chunks: total });
    }

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
            const needsHelp = { ...state.needsHelp };
            delete needsHelp[recording.client_id];
            setState({ errors, needsHelp, lastCompleted: { client_id: recording.client_id, consultation_id: consultationId } });
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
    const owner = currentOwner();
    const now = Date.now();
    const recordings = (await listRecordings()).filter((rec) => belongsToOwner(rec, owner));
    const queue: LocalRecording[] = [];
    const needsHelp: Record<string, string> = {};
    for (const rec of recordings) {
        if (rec.needs_help) {
            needsHelp[rec.client_id] = rec.needs_help;
            continue;
        }
        if (rec.state === 'recording') {
            // Nur beenden, wenn sie in keinem Fenster mehr laeuft (Lebenszeichen alt).
            if (!isAbandonedRecording(rec, now, activeRecordings.has(rec.client_id))) continue;
            const finalized = await finalizeAbandoned(rec);
            if (finalized) queue.push(finalized);
        } else if (rec.total_chunks && rec.total_chunks > 0) {
            queue.push(rec);
        }
    }
    // Nichts mehr zu tun: alte Hinweise (offline, Anmeldung) zuruecksetzen.
    setState({ pending: queue.length, needsHelp, ...(queue.length === 0 ? { offline: false, authProblem: false } : {}) });

    for (const rec of queue) {
        try {
            await uploadOne(rec);
            backoffStep = 0;
            setState({ offline: false, authProblem: false, pending: Math.max(0, state.pending - 1), progress: null });
        } catch (error) {
            setState({ progress: null });
            if (error instanceof LocalRecordingMissingError) continue;
            const kind = classifyUploadError({
                network: error instanceof NetworkError,
                status: error instanceof HttpError ? error.status : undefined,
                code: error instanceof HttpError ? error.code : null,
            });
            if (kind === 'network') {
                setState({ offline: true });
                return; // spaeter erneut versuchen, die Reihenfolge bleibt
            }
            if (kind === 'backoff') {
                // Server ueberlastet oder gestoert: nicht sofort wiederholen.
                backoffUntil = Date.now() + backoffDelay(backoffStep);
                backoffStep += 1;
                setState({ offline: false });
                return;
            }
            if (kind === 'auth') {
                // Anmeldung fehlt oder Tablet entkoppelt: Aufnahme bleibt, Hinweis zeigen.
                setState({ offline: false, authProblem: true });
                return;
            }
            const code = error instanceof HttpError ? (error.code || `HTTP_${error.status}`) : 'UNKNOWN';
            if (kind === 'permanent') {
                const helpCode = error instanceof HttpError && error.status === 404 ? 'CONSULTATION_GONE' : code;
                if (rec.from_kiosk && helpCode === 'CONSULTATION_GONE') {
                    // Tablet: Gespraech wurde geloescht. Ohne Rueckfrage als neues Gespraech speichern.
                    await reassignRecording(rec.client_id, crypto.randomUUID(), {
                        consultation_id: null, follows_client_id: null, needs_help: null, last_error: null,
                    }).catch(() => undefined);
                    rerun = true;
                    continue;
                }
                await updateRecording(rec.client_id, { needs_help: helpCode, last_error: code }).catch(() => undefined);
                setState({ offline: false, needsHelp: { ...state.needsHelp, [rec.client_id]: helpCode } });
                continue;
            }
            await updateRecording(rec.client_id, { last_error: code }).catch(() => undefined);
            setState({ offline: false, errors: { ...state.errors, [rec.client_id]: code } });
        }
    }
}

/** Nur ein Fenster laedt gleichzeitig hoch (Web Locks, wo vorhanden). */
async function withUploadLock(fn: () => Promise<void>): Promise<void> {
    const locks = (navigator as Navigator & { locks?: { request: (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void>) => Promise<void> } }).locks;
    if (!locks?.request) return fn();
    await locks.request('opencare-consultation-upload', { ifAvailable: true }, async (lock) => {
        if (lock) await fn();
    });
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
        await withUploadLock(async () => {
            do {
                rerun = false;
                await runOnce();
            } while (rerun);
        });
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
    const needsHelp = { ...state.needsHelp };
    delete needsHelp[clientId];
    setState({ errors, needsHelp });
    void kick();
}

/** Dauerhaften Fehler zuruecksetzen und erneut versuchen. */
export async function retryLocalRecording(clientId: string): Promise<void> {
    await updateRecording(clientId, { needs_help: null, last_error: null });
    backoffUntil = 0;
    void kick();
}

/** Gespraech wurde geloescht: Aufnahme als neues Gespraech speichern (neue client_id). */
export async function saveAsNewConsultation(clientId: string): Promise<void> {
    await reassignRecording(clientId, crypto.randomUUID(), {
        consultation_id: null,
        follows_client_id: null,
        needs_help: null,
        last_error: null,
    });
    void kick();
}

/** Anzahl lokal wartender Aufnahmen der aktuellen Person (fuer die Abmelde-Warnung). */
export async function pendingRecordingsForCurrentUser(): Promise<number> {
    if (IS_DEMO || !isLocalStoreAvailable()) return 0;
    const owner = currentOwner();
    return (await listRecordings()).filter((r) => !r.from_kiosk && belongsToOwner(r, owner)).length;
}

/** Beim Abmelden: lokale Aufnahmen dieser Person loeschen. */
export async function clearRecordingsForCurrentUser(): Promise<void> {
    if (IS_DEMO || !isLocalStoreAvailable()) return;
    const owner = currentOwner();
    for (const r of await listRecordings()) {
        if (!r.from_kiosk && belongsToOwner(r, owner)) await deleteRecording(r.client_id);
    }
    setState({ pending: 0, errors: {}, needsHelp: {} });
}

/** Anzahl lokal wartender Aufnahmen dieses Tablets (fuer die Warnung beim Entkoppeln). */
export async function pendingRecordingsForDevice(): Promise<number> {
    if (IS_DEMO || !isLocalStoreAvailable()) return 0;
    const owner = currentOwner();
    return (await listRecordings()).filter((r) => r.from_kiosk && belongsToOwner(r, owner)).length;
}

/** Beim Entkoppeln: lokale Aufnahmen dieses Tablets loeschen (nur nach Bestaetigung). */
export async function clearRecordingsForDevice(): Promise<void> {
    if (IS_DEMO || !isLocalStoreAvailable()) return;
    const owner = currentOwner();
    for (const r of await listRecordings()) {
        if (r.from_kiosk && belongsToOwner(r, owner)) await deleteRecording(r.client_id);
    }
    setState({ pending: 0, errors: {}, needsHelp: {} });
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
