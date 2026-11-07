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
    /** question_id ist massgeblich; question_index nur fuer aeltere Entwuerfe ohne ID */
    question_answers: QuestionAnswer[];
    unclear: string[];
    /** Vorschlaege fuer Termine (erst nach Bestaetigung angelegt) */
    appointments: ProposedAppointment[];
    /** Vorschlaege fuer Notizen an der Familien-Pinnwand */
    family_notes: string[];
}

export interface QuestionAnswer {
    question_id?: string | null;
    question_index: number;
    answer: string | null;
}

/** Fragen als Anzahl (alt) oder als IDs in Anzeige-Reihenfolge (bevorzugt). */
export type QuestionRef = number | readonly string[];

const questionList = (q: QuestionRef): { id: string | null; index: number }[] =>
    typeof q === 'number'
        ? Array.from({ length: Math.max(0, q) }, (_, i) => ({ id: null, index: i }))
        : q.map((id, i) => ({ id, index: i }));

export interface ProposedAppointment {
    title: string;
    date: string | null;
    time: string | null;
    location: string | null;
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

export function emptySummary(questionCount: QuestionRef): ConsultationSummary {
    return {
        overview: '',
        findings: [],
        medication_changes: [],
        recommendations: [],
        next_steps: [],
        question_answers: questionList(questionCount).map((q) =>
            q.id ? { question_id: q.id, question_index: q.index, answer: null } : { question_index: q.index, answer: null }),
        unclear: [],
        appointments: [],
        family_notes: [],
    };
}

/**
 * Ergaenzt fehlende Felder (aeltere Entwuerfe ohne appointments/family_notes),
 * damit die Oberflaeche immer mit vollstaendigen Listen arbeitet.
 */
export function withDefaults(summary: Partial<ConsultationSummary> | null | undefined, questionCount: QuestionRef): ConsultationSummary {
    const base = emptySummary(questionCount);
    if (!summary) return base;
    const arr = <T,>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);
    return {
        overview: typeof summary.overview === 'string' ? summary.overview : '',
        findings: arr(summary.findings),
        medication_changes: arr(summary.medication_changes),
        recommendations: arr(summary.recommendations),
        next_steps: arr(summary.next_steps),
        question_answers: Array.isArray(summary.question_answers) ? summary.question_answers : base.question_answers,
        unclear: arr(summary.unclear),
        appointments: arr(summary.appointments),
        family_notes: arr(summary.family_notes),
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
        && !summary.unclear.some(hasText)
        && !(summary.appointments ?? []).some((a) => hasText(a.title))
        && !(summary.family_notes ?? []).some(hasText);
}

/**
 * Bereinigt eine bearbeitete Zusammenfassung vor dem Speichern: leere
 * Eintraege fallen weg, Texte werden getrimmt, ungueltige Daten werden null.
 * Antworten werden auf die aktuelle Fragenzahl ausgerichtet.
 */
export function normalizeSummary(summary: ConsultationSummary, questionCount: QuestionRef): ConsultationSummary {
    const clean = (s: string | null | undefined) => (typeof s === 'string' ? s.trim() : '');
    const list = (items: string[]) => items.map(clean).filter(Boolean);
    const questions = questionList(questionCount);
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
        // Antworten haengen an der Frage (ID), nicht am Listenplatz.
        question_answers: questions.map((q) => {
            const raw = q.id
                ? answerForQuestion(summary.question_answers, q.id, q.index)
                : summary.question_answers.find((a) => a.question_index === q.index)?.answer ?? null;
            const answer = clean(raw) || null;
            return q.id
                ? { question_id: q.id, question_index: q.index, answer }
                : { question_index: q.index, answer };
        }),
        unclear: list(summary.unclear),
        appointments: (summary.appointments ?? [])
            .map((a) => ({
                title: clean(a.title),
                date: isIsoDate(clean(a.date)) ? clean(a.date) : null,
                time: isValidTime(clean(a.time)) ? clean(a.time) : null,
                location: clean(a.location) || null,
            }))
            .filter((a) => a.title),
        family_notes: list(summary.family_notes ?? []),
    };
}

/** Uhrzeit HH:MM (24 Stunden). */
export function isValidTime(value: string | null | undefined): boolean {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// ─── Vorschlaege uebernehmen (Vertrag: docs/consultations-api.md) ────────────

export type ProposalKind = 'task' | 'event' | 'note';

/** Grenzen wie auf dem Server (Texte werden dort getrimmt und gekuerzt). */
export const PROPOSAL_LIMITS = { task: 255, event: 255, note: 500 } as const;

/** Normalisierung exakt wie auf dem Server: Mehrfach-Leerraum, trim, Kleinschreibung. */
export function normalizeProposalText(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/** Schluessel eines Vorschlags in consultation.applied. */
export function appliedKey(kind: ProposalKind, value: string): string {
    return `${kind}:${normalizeProposalText(value)}`;
}

const cut = (value: string, max: number) => value.trim().slice(0, max);

export function taskKey(text: string): string {
    return appliedKey('task', cut(text, PROPOSAL_LIMITS.task));
}

/** Termin-Schluessel: Titel + Leerzeichen + JJJJ-MM-TTTHH:MM:00; null, solange Datum/Uhrzeit fehlen. */
export function eventKey(title: string, date: string | null, time: string | null): string | null {
    if (!isIsoDate(date) || !isValidTime(time)) return null;
    return appliedKey('event', `${cut(title, PROPOSAL_LIMITS.event)} ${date}T${time}:00`);
}

export function noteKey(content: string): string {
    return appliedKey('note', cut(content, PROPOSAL_LIMITS.note));
}

export function isApplied(applied: Record<string, string> | null | undefined, key: string | null): boolean {
    return Boolean(key && applied && Object.prototype.hasOwnProperty.call(applied, key));
}

export interface TaskDraft { text: string; due: string }
export interface AppointmentDraft { title: string; date: string; time: string; location: string }
export interface NoteDraft { content: string }

/** Darf eine Aufgabe ausgewaehlt werden? */
export function canSelectTask(d: TaskDraft): boolean {
    return d.text.trim().length > 0 && (d.due === '' || isIsoDate(d.due));
}

/** Ein Termin braucht Titel, Datum UND Uhrzeit: nichts wird erfunden. */
export function canSelectAppointment(d: AppointmentDraft): boolean {
    return d.title.trim().length > 0 && isIsoDate(d.date) && isValidTime(d.time);
}

export function canSelectNote(d: NoteDraft): boolean {
    const t = d.content.trim();
    return t.length > 0 && t.length <= PROPOSAL_LIMITS.note;
}

export function toTaskDraft(s: { text: string; due: string | null }): TaskDraft {
    return { text: s.text ?? '', due: s.due ?? '' };
}

export function toAppointmentDraft(a: ProposedAppointment): AppointmentDraft {
    return { title: a.title ?? '', date: a.date ?? '', time: a.time ?? '', location: a.location ?? '' };
}

export interface ApplyPayload {
    tasks: { text: string; due: string | null }[];
    appointments: { title: string; date: string; time: string; location: string | null }[];
    notes: { content: string }[];
}

/** Baut den Body fuer POST /:id/apply nur aus ausgewaehlten, gueltigen Vorschlaegen. */
export function buildApplyPayload(
    tasks: { draft: TaskDraft; selected: boolean }[],
    appointments: { draft: AppointmentDraft; selected: boolean }[],
    notes: { draft: NoteDraft; selected: boolean }[]
): ApplyPayload {
    return {
        tasks: tasks
            .filter((x) => x.selected && canSelectTask(x.draft))
            .map(({ draft }) => ({ text: draft.text.trim(), due: draft.due || null })),
        appointments: appointments
            .filter((x) => x.selected && canSelectAppointment(x.draft))
            .map(({ draft }) => ({
                title: draft.title.trim(),
                date: draft.date,
                time: draft.time,
                location: draft.location.trim() || null,
            })),
        notes: notes
            .filter((x) => x.selected && canSelectNote(x.draft))
            .map(({ draft }) => ({ content: draft.content.trim() })),
    };
}

export function payloadSize(p: ApplyPayload): number {
    return p.tasks.length + p.appointments.length + p.notes.length;
}

/** Fehlercodes von POST /:id/apply mit eigenem Erklaertext. */
export const APPLY_ERROR_CODES = [
    'APPOINTMENT_DATE_TIME_REQUIRED',
    'APPOINTMENT_TITLE_REQUIRED',
    'TASK_TEXT_REQUIRED',
    'INVALID_TASK_DUE',
    'NOTE_TEXT_REQUIRED',
    'NOTHING_TO_APPLY',
] as const;

export function applyErrorKey(message: string | null | undefined): string {
    const code = (message ?? '').trim();
    return (APPLY_ERROR_CODES as readonly string[]).includes(code)
        ? `consultations:proposals.errors.${code}`
        : 'consultations:proposals.errors.generic';
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

// ─── Warteschlange: Entscheidungen als reine Funktionen (Pruefungs-Fixes) ────

/** Lebenszeichen einer laufenden Aufnahme: alle 5 s, als verwaist gilt sie nach 60 s. */
export const HEARTBEAT_MS = 5_000;
export const HEARTBEAT_STALE_MS = 60_000;

/**
 * Darf eine als "recording" markierte Aufnahme als abgebrochen beendet werden?
 * Nur wenn sie nicht in diesem Fenster laeuft UND ihr Lebenszeichen alt ist.
 * So beendet ein zweites Fenster nie eine Aufnahme, die anderswo noch laeuft.
 */
export function isAbandonedRecording(
    rec: { state: string; last_heartbeat_at?: number | null; updated_at: number },
    now: number,
    activeHere: boolean
): boolean {
    if (rec.state !== 'recording' || activeHere) return false;
    const last = Math.max(rec.last_heartbeat_at ?? 0, rec.updated_at ?? 0);
    return now - last > HEARTBEAT_STALE_MS;
}

/** Anzahl lueckenloser Stuecke ab Index 0 (nur diese ergeben eine abspielbare Datei). */
export function contiguousChunkCount(indexes: readonly number[]): number {
    const set = new Set(indexes);
    let count = 0;
    while (set.has(count)) count += 1;
    return count;
}

export type UploadErrorKind = 'network' | 'backoff' | 'permanent' | 'auth' | 'retry';

/** Fehlercodes, die sich durch Wiederholen nicht von selbst loesen. */
export const PERMANENT_UPLOAD_CODES = [
    'CLIENT_ID_TAKEN',
    'CONSENT_REQUIRED',
    'LOCAL_CONSENT_MISSING',
    'UNSUPPORTED_AUDIO',
    'INVALID_CLIENT_ID',
    'RECORDING_TOO_LARGE',
    'CHUNK_TOO_LARGE',
] as const;

/**
 * Wie mit einem Upload-Fehler umgehen?
 *  - network: offline, spaeter automatisch weiter
 *  - backoff: Server ueberlastet (429/5xx), mit wachsender Pause weiter
 *  - auth: Anmeldung fehlt oder Geraet entkoppelt (401), Aufnahme bleibt, Hinweis
 *  - permanent: braucht eine Entscheidung (404, 403, bekannte Codes)
 *  - retry: sonstiges, beim naechsten Durchlauf erneut
 */
export function classifyUploadError(error: { network?: boolean; status?: number; code?: string | null }): UploadErrorKind {
    if (error.network) return 'network';
    const status = error.status ?? 0;
    if (status === 429 || status >= 500) return 'backoff';
    if (status === 401) return 'auth';
    if (status === 403 || status === 404 || status === 413) return 'permanent';
    if (error.code && (PERMANENT_UPLOAD_CODES as readonly string[]).includes(error.code)) return 'permanent';
    return 'retry';
}

/** Gehoert eine lokale Aufnahme der aktuell angemeldeten Person bzw. dem Geraet? */
export function belongsToOwner(
    rec: { from_kiosk: boolean; owner_user_id?: string | null; owner_device_id?: string | null },
    owner: { userId: string | null; deviceId: string | null }
): boolean {
    if (rec.from_kiosk) {
        // Aeltere Datensaetze ohne Geraete-ID gehoeren dem gekoppelten Geraet.
        return Boolean(owner.deviceId) && (rec.owner_device_id == null || rec.owner_device_id === owner.deviceId);
    }
    return Boolean(owner.userId) && (rec.owner_user_id == null || rec.owner_user_id === owner.userId);
}

/** Tablet: Folgeaufnahme innerhalb von 3 Stunden gehoert zum selben Gespraech. */
export const KIOSK_FOLLOW_UP_MS = 3 * 60 * 60_000;

export interface KioskLastRecording {
    client_id: string;
    consultation_id: string | null;
    at: number;
}

export function kioskFollowUp(last: KioskLastRecording | null, now: number): { consultation_id: string | null; follows_client_id: string | null } {
    if (!last || now - last.at > KIOSK_FOLLOW_UP_MS || now < last.at) return { consultation_id: null, follows_client_id: null };
    return last.consultation_id
        ? { consultation_id: last.consultation_id, follows_client_id: null }
        : { consultation_id: null, follows_client_id: last.client_id };
}

/** Antwort zu einer Frage: zuerst ueber question_id, nur ohne ID ueber den Listenplatz. */
export function answerForQuestion(
    answers: readonly { question_id?: string | null; question_index: number; answer: string | null }[],
    questionId: string,
    index: number
): string | null {
    const byId = answers.find((a) => a.question_id === questionId);
    if (byId) return byId.answer;
    const hasIds = answers.some((a) => a.question_id);
    if (hasIds) return null;
    return answers.find((a) => a.question_index === index)?.answer ?? null;
}
