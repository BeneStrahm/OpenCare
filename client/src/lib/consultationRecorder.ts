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
import { pickMimeType, toNaiveLocal } from './consultationLogic';
import { deleteRecording, saveChunk, saveRecording, updateRecording, isLocalStoreAvailable } from './consultationStore';
import { kick, markRecordingActive } from './consultationUploader';

// 30 s je Stueck: deutlich unter 2 MB und wenige Anfragen (Server-Limit).
export const CHUNK_MS = 30_000;

export interface StartOptions {
    circleId: string | null;
    consultationId: string | null;
    fromKiosk: boolean;
    /** Muss true sein: Der Arzt hat der Aufnahme zugestimmt. */
    consentConfirmed: boolean;
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
    stop: () => Promise<{ clientId: string; durationSeconds: number; chunks: number }>;
    /** Fehler beim Speichern eines Stuecks (z. B. Speicher voll) */
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
    const consentAt = toNaiveLocal(startedAt);
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
        from_kiosk: options.fromKiosk,
        last_error: null,
        updated_at: Date.now(),
    });
    markRecordingActive(clientId, true);

    // Stuecke strikt nacheinander speichern, Reihenfolge = Index.
    let index = 0;
    let writeChain: Promise<void> = Promise.resolve();
    let storageErrorHandler: ((error: unknown) => void) | null = null;
    recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        const myIndex = index++;
        const blob = event.data;
        writeChain = writeChain
            .then(() => saveChunk(clientId, myIndex, blob))
            .then(() => updateRecording(clientId, {}))
            .catch((error) => {
                console.error('[consultationRecorder] chunk save failed:', error);
                storageErrorHandler?.(error);
            });
    };

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
        document.removeEventListener('visibilitychange', onVisibility);
        stream.getTracks().forEach((t) => t.stop());
        markRecordingActive(clientId, false);
        throw new ConsultationRecorderError('START_FAILED');
    }

    const stop = async () => {
        if (!stopped) {
            stopped = true;
            await new Promise<void>((resolve) => {
                if (recorder.state === 'inactive') return resolve();
                recorder.addEventListener('stop', () => resolve(), { once: true });
                try { recorder.stop(); } catch { resolve(); }
            });
            stream.getTracks().forEach((t) => t.stop());
            document.removeEventListener('visibilitychange', onVisibility);
            try { await wakeLock?.release(); } catch { /* bereits freigegeben */ }
            wakeLock = null;
        }
        await writeChain;
        const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000));
        if (index === 0) {
            // Nichts aufgenommen (sofort gestoppt): nichts aufzuheben.
            await deleteRecording(clientId);
        } else {
            await updateRecording(clientId, { state: 'pending', total_chunks: index, duration_seconds: durationSeconds });
        }
        markRecordingActive(clientId, false);
        void kick();
        return { clientId, durationSeconds, chunks: index };
    };

    return {
        clientId,
        startedAt,
        wakeLockActive: () => !!wakeLock && !wakeLock.released,
        stop,
        onStorageError: (handler) => { storageErrorHandler = handler; },
    };
}
