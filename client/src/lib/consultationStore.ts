/**
 * Lokaler Speicher fuer Aufnahmen von Arztgespraechen (IndexedDB).
 *
 * Jedes Audiostueck wird sofort nach dem Aufnehmen gespeichert. Stuerzt die
 * App ab oder geht der Akku leer, bleibt alles bis zum letzten Stueck
 * erhalten. Geloescht wird erst, wenn der Server die Aufnahme vollstaendig
 * bestaetigt hat (siehe consultationUploader.ts).
 */

const DB_NAME = 'opencare-consultations';
const DB_VERSION = 1;
const RECORDINGS = 'recordings';
const CHUNKS = 'chunks';

export type LocalRecordingState = 'recording' | 'pending';

export interface LocalRecording {
    client_id: string;
    circle_id: string | null;
    consultation_id: string | null;
    mime_type: string;
    /** Naiver lokaler Zeitstempel */
    started_at: string;
    consent_at: string;
    state: LocalRecordingState;
    /** Gesetzt, sobald die Aufnahme beendet ist */
    total_chunks: number | null;
    duration_seconds: number | null;
    /** Aufgenommen am frueheren gekoppelten Tablet (Kiosk, bis Launch Block C); neue Aufnahmen: false */
    from_kiosk: boolean;
    last_error: string | null;
    updated_at: number;
    /** Einwilligung des Arztes wurde auf dem Geraet bestaetigt (Pflicht fuer den Upload) */
    consent_confirmed?: boolean;
    /** Wem die Aufnahme gehoert: angemeldete Person ... */
    owner_user_id?: string | null;
    /** ... oder gekoppeltes Patienten-Geraet */
    owner_device_id?: string | null;
    /** Lebenszeichen der laufenden Aufnahme (ms), auch ueber Fenster hinweg sichtbar */
    last_heartbeat_at?: number | null;
    /** Dauerhafter Fehler: wird nicht automatisch wiederholt, braucht eine Entscheidung */
    needs_help?: string | null;
    /** Tablet: gehoert zum selben Gespraech wie diese fruehere Aufnahme */
    follows_client_id?: string | null;
}

/** Fehler, wenn eine Aufnahme lokal nicht (mehr) existiert. */
export class LocalRecordingMissingError extends Error {
    constructor(public clientId: string) {
        super('LOCAL_RECORDING_MISSING');
    }
}

interface ChunkRow {
    client_id: string;
    index: number;
    blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function isLocalStoreAvailable(): boolean {
    return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(RECORDINGS)) {
                db.createObjectStore(RECORDINGS, { keyPath: 'client_id' });
            }
            if (!db.objectStoreNames.contains(CHUNKS)) {
                const store = db.createObjectStore(CHUNKS, { keyPath: ['client_id', 'index'] });
                store.createIndex('by_client', 'client_id', { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
            dbPromise = null;
            reject(request.error);
        };
    });
    return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function saveRecording(recording: LocalRecording): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(RECORDINGS, 'readwrite');
    tx.objectStore(RECORDINGS).put({ ...recording, updated_at: Date.now() });
    await done(tx);
}

export async function getRecording(clientId: string): Promise<LocalRecording | null> {
    const db = await openDb();
    const tx = db.transaction(RECORDINGS, 'readonly');
    const row = await result(tx.objectStore(RECORDINGS).get(clientId));
    return (row as LocalRecording | undefined) ?? null;
}

export async function listRecordings(): Promise<LocalRecording[]> {
    if (!isLocalStoreAvailable()) return [];
    const db = await openDb();
    const tx = db.transaction(RECORDINGS, 'readonly');
    const rows = await result(tx.objectStore(RECORDINGS).getAll());
    return (rows as LocalRecording[]).sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/**
 * Aenderung in EINER Transaktion lesen und schreiben, damit zwei Fenster sich
 * nicht gegenseitig ueberschreiben. Fehlt der Datensatz, gibt es einen Fehler
 * (nie still scheitern).
 */
export async function updateRecording(clientId: string, patch: Partial<LocalRecording>): Promise<LocalRecording> {
    const db = await openDb();
    const tx = db.transaction(RECORDINGS, 'readwrite');
    const store = tx.objectStore(RECORDINGS);
    const current = (await result(store.get(clientId))) as LocalRecording | undefined;
    if (!current) {
        tx.abort();
        throw new LocalRecordingMissingError(clientId);
    }
    const next: LocalRecording = { ...current, ...patch, client_id: clientId, updated_at: Date.now() };
    store.put(next);
    await done(tx);
    return next;
}

/**
 * Aufnahme unter neuer client_id ablegen (z. B. "als neues Gespraech speichern",
 * wenn das alte Gespraech geloescht wurde). Stuecke werden mitkopiert, danach
 * wird der alte Datensatz geloescht.
 */
export async function reassignRecording(oldId: string, newId: string, patch: Partial<LocalRecording>): Promise<void> {
    const current = await getRecording(oldId);
    if (!current) throw new LocalRecordingMissingError(oldId);
    const indexes = await listChunkIndexes(oldId);
    for (const index of indexes) {
        const blob = await getChunk(oldId, index);
        if (blob) await saveChunk(newId, index, blob);
    }
    await saveRecording({ ...current, ...patch, client_id: newId });
    await deleteRecording(oldId);
}

export async function saveChunk(clientId: string, index: number, blob: Blob): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(CHUNKS, 'readwrite');
    const row: ChunkRow = { client_id: clientId, index, blob };
    tx.objectStore(CHUNKS).put(row);
    await done(tx);
}

export async function getChunk(clientId: string, index: number): Promise<Blob | null> {
    const db = await openDb();
    const tx = db.transaction(CHUNKS, 'readonly');
    const row = await result(tx.objectStore(CHUNKS).get([clientId, index]));
    return (row as ChunkRow | undefined)?.blob ?? null;
}

/** Indizes der lokal gespeicherten Stuecke einer Aufnahme, aufsteigend. */
export async function listChunkIndexes(clientId: string): Promise<number[]> {
    const db = await openDb();
    const tx = db.transaction(CHUNKS, 'readonly');
    const keys = await result(tx.objectStore(CHUNKS).index('by_client').getAllKeys(IDBKeyRange.only(clientId)));
    return (keys as unknown as Array<[string, number]>).map((k) => k[1]).sort((a, b) => a - b);
}

/** Summe der Groesse aller lokalen Stuecke einer Aufnahme in Bytes. */
export async function localSize(clientId: string): Promise<number> {
    const db = await openDb();
    const tx = db.transaction(CHUNKS, 'readonly');
    const rows = await result(tx.objectStore(CHUNKS).index('by_client').getAll(IDBKeyRange.only(clientId)));
    return (rows as ChunkRow[]).reduce((sum, row) => sum + row.blob.size, 0);
}

/** Aufnahme und alle Stuecke lokal loeschen. */
export async function deleteRecording(clientId: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction([RECORDINGS, CHUNKS], 'readwrite');
    tx.objectStore(RECORDINGS).delete(clientId);
    const index = tx.objectStore(CHUNKS).index('by_client');
    const cursorRequest = index.openKeyCursor(IDBKeyRange.only(clientId));
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
            tx.objectStore(CHUNKS).delete(cursor.primaryKey);
            cursor.continue();
        }
    };
    await done(tx);
}
