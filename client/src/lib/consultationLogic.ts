/**
 * Arztgespraech-Modul: reine Logik ohne Browser-APIs, damit sie getestet
 * werden kann (tests/client/consultationLogic.test.ts).
 */

export type RecordingStatus = 'uploading' | 'queued' | 'transcribing' | 'summarizing' | 'done' | 'failed';
export type SummaryStatus = 'none' | 'draft' | 'approved';

export interface ConsultationSummary {
    overview: string;
    findings: string[];
    medication_changes: { name: string; change: string }[];
    recommendations: string[];
    next_steps: { text: string; due: string | null }[];
    question_answers: { question_index: number; answer: string | null }[];
    unclear: string[];
}

/** Indizes 0..total-1, die der Server noch nicht hat, aufsteigend. */
export function missingChunks(total: number, received: readonly number[]): number[] {
    if (!Number.isInteger(total) || total <= 0) return [];
    const have = new Set(received.filter((n) => Number.isInteger(n)));
    const missing: number[] = [];
    for (let i = 0; i < total; i++) {
        if (!have.has(i)) missing.push(i);
    }
    return missing;
}

/** Laeuft auf dem Server noch etwas (Live-Aktualisierung sinnvoll)? */
export function isRecordingInProgress(status: RecordingStatus): boolean {
    return status === 'uploading' || status === 'queued' || status === 'transcribing' || status === 'summarizing';
}

export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'secondary';

export function recordingBadgeVariant(status: RecordingStatus): BadgeVariant {
    switch (status) {
        case 'done': return 'success';
        case 'failed': return 'danger';
        case 'uploading': return 'secondary';
        default: return 'primary';
    }
}

export function summaryBadgeVariant(status: SummaryStatus): BadgeVariant {
    switch (status) {
        case 'approved': return 'success';
        case 'draft': return 'warning';
        default: return 'secondary';
    }
}

/** Fehlercodes laut API-Vertrag, mit eigenem Erklaertext in der Oberflaeche. */
export const KNOWN_ERROR_CODES = [
    'WHISPER_NOT_CONFIGURED',
    'WHISPER_UNAVAILABLE',
    'EMPTY_TRANSCRIPT',
    'AI_NOT_CONFIGURED',
    'LOCAL_AI_REQUIRED',
    'AI_FAILED',
    'INTERNAL',
] as const;

export type KnownErrorCode = typeof KNOWN_ERROR_CODES[number];

/** i18n-Schluessel fuer einen error_code; Unbekanntes faellt auf INTERNAL. */
export function errorCodeKey(code: string | null | undefined): string | null {
    if (!code) return null;
    const known = (KNOWN_ERROR_CODES as readonly string[]).includes(code) ? code : 'INTERNAL';
    return `consultations:errors.${known}`;
}

export function emptySummary(questionCount: number): ConsultationSummary {
    return {
        overview: '',
        findings: [],
        medication_changes: [],
        recommendations: [],
        next_steps: [],
        question_answers: Array.from({ length: Math.max(0, questionCount) }, (_, i) => ({ question_index: i, answer: null })),
        unclear: [],
    };
}

/** true, wenn die Zusammenfassung keinen Inhalt hat (Antworten zaehlen mit). */
export function isSummaryEmpty(summary: ConsultationSummary | null | undefined): boolean {
    if (!summary) return true;
    const hasText = (s: string | null | undefined) => typeof s === 'string' && s.trim().length > 0;
    return !hasText(summary.overview)
        && !summary.findings.some(hasText)
        && !summary.medication_changes.some((m) => hasText(m.name) || hasText(m.change))
        && !summary.recommendations.some(hasText)
        && !summary.next_steps.some((s) => hasText(s.text))
        && !summary.question_answers.some((a) => hasText(a.answer))
        && !summary.unclear.some(hasText);
}

/**
 * Bereinigt eine bearbeitete Zusammenfassung vor dem Speichern: leere
 * Eintraege fallen weg, Texte werden getrimmt, ungueltige Daten werden null.
 * Antworten werden auf die aktuelle Fragenzahl ausgerichtet.
 */
export function normalizeSummary(summary: ConsultationSummary, questionCount: number): ConsultationSummary {
    const clean = (s: string | null | undefined) => (typeof s === 'string' ? s.trim() : '');
    const list = (items: string[]) => items.map(clean).filter(Boolean);
    const answers = new Map<number, string>();
    for (const a of summary.question_answers) {
        const text = clean(a.answer);
        if (text && Number.isInteger(a.question_index)) answers.set(a.question_index, text);
    }
    return {
        overview: clean(summary.overview),
        findings: list(summary.findings),
        medication_changes: summary.medication_changes
            .map((m) => ({ name: clean(m.name), change: clean(m.change) }))
            .filter((m) => m.name && m.change),
        recommendations: list(summary.recommendations),
        next_steps: summary.next_steps
            .map((s) => ({ text: clean(s.text), due: isIsoDate(clean(s.due)) ? clean(s.due) : null }))
            .filter((s) => s.text),
        question_answers: Array.from({ length: Math.max(0, questionCount) }, (_, i) => ({
            question_index: i,
            answer: answers.get(i) ?? null,
        })),
        unclear: list(summary.unclear),
    };
}

export function isIsoDate(value: string | null | undefined): boolean {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Verschiebt ein Element um eine Stelle (-1 hoch, +1 runter); ausserhalb bleibt alles gleich. */
export function moveItem<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
    const target = index + direction;
    if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [...items];
    const copy = [...items];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    return copy;
}

/** Naiver lokaler Zeitstempel YYYY-MM-DDTHH:mm:ss, wie ihn OpenCare ueberall nutzt. */
export function toNaiveLocal(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Wert fuer <input type="datetime-local"> aus einem naiven Zeitstempel. */
export function toDateTimeInput(value: string | null | undefined): string {
    if (!value) return '';
    const m = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    return m ? `${m[1]}T${m[2]}` : '';
}

/** Zurueck aus <input type="datetime-local"> in einen naiven Zeitstempel, oder null. */
export function fromDateTimeInput(value: string): string | null {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/);
    return m ? `${m[1]}T${m[2]}:${m[3] ?? '00'}` : null;
}

export function formatDuration(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** Fachwort fuer die Spracherkennung pruefen (max. 80 Zeichen laut API). */
export const MAX_VOCABULARY_TERM = 80;

export function cleanVocabularyTerm(value: string): string | null {
    const term = value.replace(/\s+/g, ' ').trim();
    if (!term || term.length > MAX_VOCABULARY_TERM) return null;
    return term;
}

/** Erster MIME-Typ, den MediaRecorder kann (gleiche Reihenfolge wie im Journal). */
export const RECORDER_MIME_CANDIDATES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
];

export function pickMimeType(isSupported: (type: string) => boolean): string {
    return RECORDER_MIME_CANDIDATES.find((type) => isSupported(type)) ?? '';
}

/** Pause nach HTTP 429 oder 5xx: 1, 2, 4, 8 ... hoechstens 15 Minuten. */
export function backoffDelay(step: number): number {
    const base = 60_000;
    const max = 15 * 60_000;
    return Math.min(max, base * 2 ** Math.max(0, Math.floor(step)));
}
