// Infomaniak AI Services fuer das Arztgespraech (E63): Mitschrift (Whisper) und
// Zusammenfassung. Nur dieses Modul spricht Infomaniak an, und nur fuer das
// Arztgespraech. Assistent, Sprachbefehle und Wochenrueckblick nutzen weiter
// ai_settings bzw. die Integration "whisper" und erreichen Infomaniak nicht.
//
// Freigabe von Benedikt (21. November): Audio, Mitschrift, Fragen, Fachwoerter
// (ohne Namen von Personen) und Fachrichtung duerfen an Infomaniak gehen.
// Arztname, Datum und Anlass nicht (siehe processing.ts).
//
// Die Adresse ist fest. Es gibt keinen frei waehlbaren Host und keinen Eintrag
// in LOCAL_AI_ALLOWED_HOSTS.
//
// Schnittstelle (Infomaniak-Doku, Stand November 2026):
//  - POST /1/ai/{product_id}/openai/audio/transcriptions -> { batch_id }
//    (asynchron), Ergebnis ueber GET /1/ai/{product_id}/results/{batch_id}:
//    { status: 'pending' | 'success', data } ; mit response_format=text ist
//    data der reine Text. Andere Statuswerte sind nicht belegt und gelten als
//    Fehler.
//  - POST /2/ai/{product_id}/openai/v1/chat/completions (OpenAI-kompatibel)
//  - Whisper nimmt Dateien bis 25 MB an.

import { query } from '../../db';
import { decryptCredentials } from '../../utils/crypto';
import { safeFetch } from '../../utils/safeFetch';
import { extractJson, type AiCompletionRequest } from '../../services/ai';
import logger from '../../lib/logger';

export const INFOMANIAK_BASE_URL = 'https://api.infomaniak.com';
export const INFOMANIAK_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const INFOMANIAK_DEFAULT_WHISPER_MODEL = 'whisper';
/** Grosse Modelle fassen eine lange Mitschrift in einem Schritt zusammen. */
export const INFOMANIAK_DIRECT_SUMMARY_MAX_CHARS = 150_000;
const POLL_MS = 5_000;

export interface InfomaniakSettings {
    token: string;
    productId: string;
    whisperModel: string;
    /** Leer: keine Zusammenfassung ueber Infomaniak (z. B. wenn das Modell wegfaellt). */
    summaryModel: string;
}

export class InfomaniakError extends Error {
    constructor(public code: string, public retryable: boolean) {
        super(code);
        this.name = 'InfomaniakError';
    }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Liest die gespeicherte Integration. Unvollstaendig = nicht eingerichtet. */
export function parseInfomaniakRow(row: { encrypted_credentials: string | null; config: Record<string, unknown> | null } | undefined, decrypt = decryptCredentials): InfomaniakSettings | null {
    if (!row || !row.encrypted_credentials) return null;
    let token = '';
    try {
        token = str(decrypt(row.encrypted_credentials).apiKey);
    } catch {
        return null;
    }
    const config = row.config ?? {};
    const productId = str(config.product_id);
    if (!token || !/^\d{1,12}$/.test(productId)) return null;
    return {
        token,
        productId,
        whisperModel: str(config.whisper_model) || INFOMANIAK_DEFAULT_WHISPER_MODEL,
        summaryModel: str(config.summary_model),
    };
}

export async function loadInfomaniak(circleId: string): Promise<InfomaniakSettings | null> {
    const row = (await query(
        `SELECT encrypted_credentials, config FROM integrations WHERE circle_id = $1 AND type = 'infomaniak'`,
        [circleId]
    )).rows[0] as { encrypted_credentials: string | null; config: Record<string, unknown> | null } | undefined;
    return parseInfomaniakRow(row);
}

/** HTTP-Status in einen Fehlercode. Der Antworttext wird nie geloggt. */
export function errorForStatus(status: number): InfomaniakError {
    if (status === 401 || status === 403) return new InfomaniakError('INFOMANIAK_UNAUTHORIZED', false);
    if (status === 402) return new InfomaniakError('INFOMANIAK_PAYMENT', false);
    if (status === 404) return new InfomaniakError('INFOMANIAK_NOT_FOUND', false);
    if (status === 413 || status === 422) return new InfomaniakError('AUDIO_REJECTED', false);
    // 400 nur fuer die Zusammenfassung (abgelehntes response_format), siehe infomaniakComplete.
    if (status === 400) return new InfomaniakError('INFOMANIAK_BAD_REQUEST', false);
    return new InfomaniakError('INFOMANIAK_UNAVAILABLE', status >= 500 || status === 429);
}

export interface Deps {
    fetch: (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
}

const defaultDeps: Deps = {
    // Nur oeffentliche Adressen (blockPrivate), die Adresse ist ohnehin fest.
    fetch: (url, init, timeoutMs) => safeFetch(url, init, { timeoutMs, blockPrivate: true }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
};

async function call(deps: Deps, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try {
        response = await deps.fetch(url, init, timeoutMs);
    } catch {
        throw new InfomaniakError('INFOMANIAK_UNAVAILABLE', true);
    }
    if (!response.ok) {
        logger.warn('consultations.infomaniak_status', { status: response.status });
        throw errorForStatus(response.status);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            response.json(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('BODY_TIMEOUT')), timeoutMs); }),
        ]);
    } catch {
        throw new InfomaniakError('INFOMANIAK_UNAVAILABLE', true);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Manche Infomaniak-Routen antworten mit { result, data }, andere direkt. */
function unwrap(body: unknown, key: string): Record<string, unknown> | null {
    if (!body || typeof body !== 'object') return null;
    const obj = body as Record<string, unknown>;
    if (key in obj) return obj;
    const inner = obj.data;
    if (inner && typeof inner === 'object' && key in (inner as Record<string, unknown>)) return inner as Record<string, unknown>;
    return null;
}

const auth = (s: InfomaniakSettings) => ({ Authorization: `Bearer ${s.token}` });

export async function infomaniakTranscribe(
    s: InfomaniakSettings,
    audio: { data: Buffer; mimeType: string; fileName: string },
    options: { language: string; prompt: string; timeoutMs: number },
    deps: Deps = defaultDeps
): Promise<string> {
    if (audio.data.length > INFOMANIAK_MAX_AUDIO_BYTES) throw new InfomaniakError('AUDIO_TOO_LARGE', false);
    const form = new FormData();
    form.append('file', new Blob([audio.data], { type: audio.mimeType }), audio.fileName);
    form.append('model', s.whisperModel);
    form.append('language', options.language);
    form.append('response_format', 'text');
    if (options.prompt) form.append('prompt', options.prompt);

    const base = `${INFOMANIAK_BASE_URL}/1/ai/${s.productId}`;
    const submitted = unwrap(await call(deps, `${base}/openai/audio/transcriptions`, { method: 'POST', headers: auth(s), body: form }, 120_000), 'batch_id');
    const batchId = str(submitted?.batch_id);
    if (!/^[A-Za-z0-9-]{1,100}$/.test(batchId)) throw new InfomaniakError('INFOMANIAK_INVALID_RESPONSE', true);

    const deadline = deps.now() + options.timeoutMs;
    for (;;) {
        await deps.sleep(POLL_MS);
        const result = unwrap(await call(deps, `${base}/results/${batchId}`, { headers: auth(s) }, 30_000), 'status');
        const status = str(result?.status);
        if (status === 'success') {
            const text = str(result?.data);
            if (!text) throw new InfomaniakError('EMPTY_TRANSCRIPT', false);
            return text;
        }
        if (status !== 'pending') throw new InfomaniakError('INFOMANIAK_FAILED', true);
        if (deps.now() > deadline) throw new InfomaniakError('INFOMANIAK_UNAVAILABLE', true);
    }
}

/**
 * B4: Das Antwortschema geht immer mit. Zuerst als response_format (gefuehrte
 * Ausgabe), zusaetzlich als Text im Auftrag. Lehnt Infomaniak response_format ab
 * (HTTP 400), wird einmal ohne wiederholt; dann gilt das Schema aus dem Text.
 */
export function chatBody(s: InfomaniakSettings, request: Pick<AiCompletionRequest, 'system' | 'user' | 'jsonSchema'>, withFormat: boolean): Record<string, unknown> {
    const system = `${request.system}\n\nDas JSON muss genau diesem JSON-Schema entsprechen (alle Felder, keine weiteren):\n${JSON.stringify(request.jsonSchema)}`;
    return {
        model: s.summaryModel,
        temperature: 0,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: request.user },
        ],
        ...(withFormat ? { response_format: { type: 'json_schema', json_schema: { name: 'antwort', schema: request.jsonSchema } } } : {}),
    };
}

export async function infomaniakComplete(
    s: InfomaniakSettings,
    request: Pick<AiCompletionRequest, 'system' | 'user' | 'jsonSchema'>,
    timeoutMs: number,
    deps: Deps = defaultDeps
): Promise<Record<string, unknown>> {
    if (!s.summaryModel) throw new InfomaniakError('SUMMARY_MODEL_MISSING', false);
    const url = `${INFOMANIAK_BASE_URL}/2/ai/${s.productId}/openai/v1/chat/completions`;
    const send = (withFormat: boolean) => call(deps, url, {
        method: 'POST',
        headers: { ...auth(s), 'Content-Type': 'application/json' },
        body: JSON.stringify(chatBody(s, request, withFormat)),
    }, timeoutMs) as Promise<{ choices?: Array<{ message?: { content?: unknown } }> } | null>;
    let body: { choices?: Array<{ message?: { content?: unknown } }> } | null;
    try {
        body = await send(true);
    } catch (error) {
        if (!(error instanceof InfomaniakError && error.code === 'INFOMANIAK_BAD_REQUEST')) throw error;
        body = await send(false);
    }
    const content = str(body?.choices?.[0]?.message?.content);
    if (!content) throw new InfomaniakError('INFOMANIAK_INVALID_RESPONSE', true);
    // Denkmodelle schreiben manchmal einen <think>-Teil vor das JSON.
    try {
        return extractJson(content.replace(/<think>[\s\S]*?<\/think>/gi, ''));
    } catch {
        throw new InfomaniakError('INFOMANIAK_INVALID_RESPONSE', true);
    }
}

/** Verbindungstest fuer die Einstellungsseite: Token und Produkt pruefen. */
export async function testInfomaniak(token: string, productId: string, deps: Deps = defaultDeps): Promise<'ok' | 'unauthorized' | 'product' | 'unreachable'> {
    if (!/^\d{1,12}$/.test(productId)) return 'product';
    try {
        const body = await call(deps, `${INFOMANIAK_BASE_URL}/1/ai`, { headers: { Authorization: `Bearer ${token}` } }, 10_000);
        // Die Produkt-ID muss in der Liste der KI-Produkte des Kontos vorkommen.
        return new RegExp(`(^|[^0-9])${productId}([^0-9]|$)`).test(JSON.stringify(body)) ? 'ok' : 'product';
    } catch (e) {
        if (e instanceof InfomaniakError && e.code === 'INFOMANIAK_UNAUTHORIZED') return 'unauthorized';
        return 'unreachable';
    }
}
