/**
 * Aufnahme eines Arztgespraechs.
 *
 * - MediaRecorder liefert alle 30 Sekunden ein Stueck; jedes Stueck wird
 *   sofort in IndexedDB gespeichert (consultationStore.ts).
 * - Waehrend der Aufnahme bleibt der Bildschirm an (Screen Wake Lock), damit
 *   Android die Aufnahme nicht beim Ausschalten des Bildschirms unterbricht.
 *   Nach einem Wechsel zurueck in die App wird die Sperre neu angefordert.
 * - Nach dem Stoppen uebernimmt die Warteschlange (consultationUploader.ts).
 *
 * Eine Aufnahme startet nur mit bestaetigter Einwilligung des Arztes.
 */
import { HEARTBEAT_MS, pickMimeType, toNaiveLocal } from './consultationLogic';
import { deleteRecording, saveChunk, saveRecording, updateRecording, isLocalStoreAvailable } from './consultationStore';
import { currentOwner, kick, markRecordingActive } from './consultationUploader';

// 30 s je Stueck: deutlich unter 2 MB und wenige Anfragen (Server-Limit).
export const CHUNK_MS = 30_000;

export interface StartOptions {
    circleId: string | null;
    consultationId: string | null;
    /** Muss true sein: Der Arzt hat der Aufnahme zugestimmt. */
    consentConfirmed: boolean;
    /** Zeitpunkt der Bestaetigung (Standard: jetzt) */
    consentAt?: Date;
}

export type RecorderError = 'CONSENT_REQUIRED' | 'UNSUPPORTED' | 'MIC_DENIED' | 'STORAGE_UNAVAILABLE' | 'START_FAILED';

export class ConsultationRecorderError extends Error {
    constructor(public code: RecorderError) {
        super(code);
    }
}

export function isRecordingSupported(): boolean {
    return typeof window !== 'undefined'
        && typeof MediaRecorder !== 'undefined'
        && !!navigator.mediaDevices?.getUserMedia
        && isLocalStoreAvailable();
}

export function isWakeLockSupported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

type WakeLockSentinelLike = { release: () => Promise<void>; released?: boolean };

export interface ActiveRecording {
    clientId: string;
    startedAt: Date;
    /** true, solange der Bildschirm wachgehalten wird */
    wakeLockActive: () => boolean;
    /** Aufnahme beenden; alle Stuecke sind danach gespeichert. */
    stop: () => Promise<{ clientId: string; durationSeconds: number; chunks: number; storageFailed: boolean }>;
    /**
     * Fehler beim Speichern eines Stuecks (z. B. Speicher voll). Die Aufnahme
     * wird dann automatisch beendet; alles bis dahin Gespeicherte bleibt erhalten.
     */
    onStorageError: (handler: (error: unknown) => void) => void;
}

export async function startConsultationRecording(options: StartOptions): Promise<ActiveRecording> {
    if (!options.consentConfirmed) throw new ConsultationRecorderError('CONSENT_REQUIRED');
    if (!isLocalStoreAvailable()) throw new ConsultationRecorderError('STORAGE_UNAVAILABLE');
    if (!isRecordingSupported()) throw new ConsultationRecorderError('UNSUPPORTED');

    let stream: MediaStream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
        throw new ConsultationRecorderError('MIC_DENIED');
    }

    const mimeType = pickMimeType((type) => MediaRecorder.isTypeSupported(type));
    let recorder: MediaRecorder;
    try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
        stream.getTracks().forEach((t) => t.stop());
        throw new ConsultationRecorderError('START_FAILED');
    }

    const clientId = crypto.randomUUID();
    const startedAt = new Date();
    const consentAt = toNaiveLocal(options.consentAt ?? startedAt);
    const owner = currentOwner();
    const baseMime = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0];

    await saveRecording({
        client_id: clientId,
        circle_id: options.circleId,
        consultation_id: options.consultationId,
        mime_type: recorder.mimeType || mimeType || baseMime,
        started_at: toNaiveLocal(startedAt),
        consent_at: consentAt,
        state: 'recording',
        total_chunks: null,
        duration_seconds: null,
        from_kiosk: false,
        last_error: null,
        updated_at: Date.now(),
        consent_confirmed: true,
        owner_user_id: owner.userId,
        owner_device_id: null,
        last_heartbeat_at: Date.now(),
        needs_help: null,
        follows_client_id: null,
    });
    markRecordingActive(clientId, true);

    // Stuecke strikt nacheinander speichern. Der Index zaehlt NUR gespeicherte
    // Stuecke: Scheitert ein Stueck (Speicher voll), wird die Aufnahme beendet,
    // damit keine Luecke entsteht und alles Bisherige hochgeladen werden kann.
    let saved = 0;
    let storageFailed = false;
    let writeChain: Promise<void> = Promise.resolve();
    let storageErrorHandler: ((error: unknown) => void) | null = null;
    let stopFn: (() => Promise<unknown>) | null = null;
    recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        const blob = event.data;
        writeChain = writeChain.then(async () => {
            if (storageFailed) return;
            try {
                await saveChunk(clientId, saved, blob);
                saved += 1;
                await updateRecording(clientId, { last_heartbeat_at: Date.now() });
            } catch (error) {
                storageFailed = true;
                console.error('[consultationRecorder] chunk save failed:', error);
                storageErrorHandler?.(error);
                // Sauber beenden statt ins Leere aufzunehmen.
                void stopFn?.();
            }
        });
    };

    // Lebenszeichen: zeigt anderen Fenstern, dass diese Aufnahme noch laeuft.
    const heartbeat = window.setInterval(() => {
        void updateRecording(clientId, { last_heartbeat_at: Date.now() }).catch((error) => {
            console.error('[consultationRecorder] heartbeat failed:', error);
        });
    }, HEARTBEAT_MS);

    // Bildschirm wachhalten
    let wakeLock: WakeLockSentinelLike | null = null;
    let stopped = false;
    const requestWakeLock = async () => {
        if (!isWakeLockSupported() || stopped) return;
        try {
            wakeLock = await (navigator as any).wakeLock.request('screen');
        } catch {
            wakeLock = null;
        }
    };
    const onVisibility = () => {
        if (document.visibilityState === 'visible' && !stopped) void requestWakeLock();
    };
    document.addEventListener('visibilitychange', onVisibility);
    await requestWakeLock();

    try {
        recorder.start(CHUNK_MS);
    } catch {
        stopped = true;
        window.clearInterval(heartbeat);
        document.removeEventListener('visibilitychange', onVisibility);
        stream.getTracks().forEach((t) => t.stop());
        markRecordingActive(clientId, false);
        await deleteRecording(clientId).catch(() => undefined);
        throw new ConsultationRecorderError('START_FAILED');
    }

    let stopPromise: Promise<{ clientId: string; durationSeconds: number; chunks: number; storageFailed: boolean }> | null = null;
    const stop = () => {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
            stopped = true;
            await new Promise<void>((resolve) => {
                if (recorder.state === 'inactive') return resolve();
                recorder.addEventListener('stop', () => resolve(), { once: true });
                try { recorder.stop(); } catch { resolve(); }
            });
            window.clearInterval(heartbeat);
            stream.getTracks().forEach((t) => t.stop());
            document.removeEventListener('visibilitychange', onVisibility);
            try { await wakeLock?.release(); } catch { /* bereits freigegeben */ }
            wakeLock = null;
            await writeChain;
            const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000));
            try {
                if (saved === 0) {
                    // Nichts gespeichert (sofort gestoppt oder Speicher voll): nichts aufzuheben.
                    await deleteRecording(clientId);
                } else {
                    await updateRecording(clientId, { state: 'pending', total_chunks: saved, duration_seconds: durationSeconds });
                }
            } finally {
                markRecordingActive(clientId, false);
            }
            void kick();
            return { clientId, durationSeconds, chunks: saved, storageFailed };
        })();
        return stopPromise;
    };
    stopFn = stop;

    return {
        clientId,
        startedAt,
        wakeLockActive: () => !!wakeLock && !wakeLock.released,
        stop,
        onStorageError: (handler) => { storageErrorHandler = handler; },
    };
}
