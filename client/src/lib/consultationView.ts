/**
 * Arztgespraech (E59): Typen, Datumsformat und Abspielen, gemeinsam fuer die einfache
 * Ansicht am Tablet (RecipientConsultations.tsx) und die App (ConsultationDetail.tsx).
 */
import i18n from '../i18n';
import { api } from './api';
import { formatClock, intlLocale } from '../i18n/format';
import { clockDate } from './clock';
import { localAudio } from './consultationStore';
import type { ConsultationSummary, RecordingStatus, SummaryStatus } from './consultationLogic';

export type TranscriptStatus = 'draft' | 'approved';

export interface ConsultationInfo {
    id: string;
    doctor_name: string | null;
    specialty: string | null;
    scheduled_at: string | null;
    location: string | null;
    reason: string | null;
    event_id: string | null;
    notes: string | null;
    summary: ConsultationSummary | null;
    summary_status: SummaryStatus;
    approved_by_name: string | null;
    approved_at: string | null;
    applied?: Record<string, string> | null;
    summary_source?: 'ai' | 'human' | null;
    summary_outdated?: boolean;
    transcript_status: TranscriptStatus;
    transcript_approved_at: string | null;
    transcript_approved_by_name: string | null;
    /** Aus dem verknuepften Termin (eine Stelle, E59) */
    companion_needed: boolean;
    companion_member_ids: string[];
    companions: string[];
    travel_needed: boolean;
    driver: string | null;
    take_along: string | null;
    /** Mitschrift und Zusammenfassung freigegeben: keine Aenderungen mehr */
    locked: boolean;
    created_at: string;
    updated_at: string;
}

export interface ConsultationQuestion { id: string; text: string; answer: string | null; position: number; created_at: string }

export interface ConsultationRecordingInfo {
    id: string;
    client_id: string;
    status: RecordingStatus;
    error_code: string | null;
    duration_seconds: number | null;
    size_bytes: number;
    consent_at: string;
    created_at: string;
    processed_at: string | null;
    audio_deleted_at: string | null;
    transcript: string | null;
    transcript_edited?: boolean;
}

export interface ConsultationDetailData {
    consultation: ConsultationInfo;
    questions: ConsultationQuestion[];
    recordings: ConsultationRecordingInfo[];
    transcript: string | null;
}

/**
 * Deutsches Datum (E61), z. B. "Montag, 9. November 2026, 10:30 Uhr".
 * Ohne Jahr: "Montag, 9. November, 10:30 Uhr" (einfache Ansicht).
 */
export function formatConsultationWhen(value: string | null | undefined, withYear = true): string | null {
    if (!value) return null;
    const date = clockDate(value);
    if (!date) return value;
    const day = new Intl.DateTimeFormat(intlLocale(), {
        weekday: 'long', day: 'numeric', month: 'long', ...(withYear ? { year: 'numeric' } : {}),
    }).format(date);
    return i18n.t('consultations:when', { date: day, time: formatClock(date) });
}

/** Kurzes Datum fuer die Kachel in der Liste: Tag ("17.") und Monat ("Nov.") */
export function consultationDayParts(value: string | null | undefined): { day: string; month: string } | null {
    const date = value ? clockDate(value) : null;
    if (!date) return null;
    const day = new Intl.DateTimeFormat(intlLocale(), { day: 'numeric' }).format(date);
    const month = new Intl.DateTimeFormat(intlLocale(), { month: 'short' }).format(date);
    return { day: /^\d+$/.test(day) ? `${day}.` : day, month };
}

/** Zustand der Pruefung fuer Liste und Karten. */
export type ReviewState = 'none' | 'unchecked' | 'checked';
export function reviewState(c: { transcript_status: TranscriptStatus; summary_status: SummaryStatus }, hasTranscript: boolean): ReviewState {
    if (c.transcript_status === 'approved' && c.summary_status === 'approved') return 'checked';
    if (hasTranscript || c.summary_status !== 'none') return 'unchecked';
    return 'none';
}

/**
 * Audio zum Abspielen (E59): zuerst die lokale Kopie auf diesem Geraet (30 Tage),
 * sonst vom Server (nur online, solange das Audio nicht geloescht ist).
 */
export async function loadRecordingAudio(rec: { id: string | null; client_id: string }): Promise<{ blob: Blob; source: 'local' | 'server' }> {
    try {
        const local = await localAudio(rec.client_id);
        if (local) return { blob: local, source: 'local' };
    } catch {
        // Lokaler Speicher nicht verfuegbar: weiter mit dem Server
    }
    if (!rec.id) throw new Error('NO_AUDIO');
    const blob = await api.getBlob(`/api/consultations/recordings/${rec.id}/audio`);
    return { blob, source: 'server' };
}

/** Tag ohne Uhrzeit, z. B. "Dienstag, 1. Dezember" (Vorschlaege, Fristen). */
function formatDay(isoDate: string): string {
    const date = clockDate(`${isoDate}T00:00:00`);
    if (!date) return isoDate;
    return new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

export type SummaryGroupKey = 'important' | 'medications' | 'nextSteps' | 'appointments' | 'unclear';

/**
 * Zusammenfassung zum Lesen, gleich am Tablet und in der App (B3, B5): Kurzfassung als
 * eigener Absatz, darunter Gruppen. Gleiche Punkte erscheinen nur einmal.
 * "unclear" (unsichere Stellen) nur fuer die Familie in der App.
 */
export function summaryView(summary: ConsultationSummary | null | undefined, options: { withUnclear?: boolean } = {}): {
    overview: string | null;
    groups: Array<{ key: SummaryGroupKey; items: string[] }>;
} {
    if (!summary) return { overview: null, groups: [] };
    const overview = summary.overview?.trim() || null;
    const seen = new Set<string>();
    const unique = (items: Array<string | null | undefined>) => items
        .map((s) => (s ?? '').trim())
        .filter((s) => {
            const key = s.toLocaleLowerCase().replace(/[\s.,;:!]+/g, ' ').trim();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    const at = (date: string | null | undefined, time: string | null | undefined) =>
        date ? [formatDay(date), time ? i18n.t('simpleView:doctor.clock', { time }) : null].filter(Boolean).join(', ') : null;
    const groups: Array<{ key: SummaryGroupKey; items: string[] }> = [
        { key: 'important', items: unique([...(summary.findings ?? []), ...(summary.recommendations ?? [])]) },
        { key: 'medications', items: unique((summary.medication_changes ?? []).map((m) => `${m.name}: ${m.change}`)) },
        { key: 'nextSteps', items: unique((summary.next_steps ?? []).map((s) => [s.text, at(s.due, null)].filter(Boolean).join(', '))) },
        { key: 'appointments', items: unique((summary.appointments ?? []).map((a) => [a.title, at(a.date, a.time), a.location].filter(Boolean).join(', '))) },
        ...(options.withUnclear ? [{ key: 'unclear' as const, items: unique(summary.unclear ?? []) }] : []),
    ];
    return { overview, groups: groups.filter((g) => g.items.length > 0) };
}

/** Antwort auf eine Frage: freigegeben (an der Frage) oder aus dem Entwurf der Zusammenfassung. */
export function answerFor(question: { id: string; answer: string | null }, index: number, summary: ConsultationSummary | null | undefined): string | null {
    if (question.answer?.trim()) return question.answer.trim();
    const qa = summary?.question_answers?.find((a) => (a.question_id ? a.question_id === question.id : a.question_index === index));
    return qa?.answer?.trim() || null;
}
