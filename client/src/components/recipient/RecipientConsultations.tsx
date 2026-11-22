// E59: Arztgespraech in der einfachen Ansicht (Rolle recipient), Figma-Reihe "Arztgespraech",
// Rahmen A1 (Auswahl), A2 (Aufnahme laeuft), A3/A15 (Gespraech mit vier Karten), A4/A5 (Neues
// Gespraech), A8 (Frage hinzufuegen), A9 (Frage loeschen). A11 bis A14 (Pruefen und Freigeben
// durch die Familie am Tablet) kommen erst mit dem Teambereich (Roadmap "Teambereich am Tablet").
//
// Rechte (middleware/circle.ts): anlegen, Angaben aendern, Fragen hinzufuegen und loeschen,
// aufnehmen und abspielen. Nach beiden Freigaben (locked) nur noch lesen.
// Offline: Aufnehmen und Abspielen der lokalen Kopie gehen immer; Lesen aus dem Zwischenspeicher
// (sw.js); Anlegen und Aendern brauchen Internet und sagen das.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    CalendarClock, CalendarPlus, Check, ChevronRight, CircleAlert, ClipboardList, CloudOff, FileText, Loader2, Mic, Pause, Play, Plus,
    Square, Stethoscope, Trash2, Users,
} from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useWebSocketUpdates } from '../../hooks/useWebSocketUpdates';
import { intlLocale } from '../../i18n/format';
import { clockDate } from '../../lib/clock';
import { formatDuration, toNaiveLocal } from '../../lib/consultationLogic';
import {
    startConsultationRecording, isRecordingSupported, ConsultationRecorderError, type ActiveRecording,
} from '../../lib/consultationRecorder';
import { isUnsent, type LocalRecording } from '../../lib/consultationStore';
import {
    answerFor, consultationDayParts, formatConsultationWhen, loadRecordingAudio, reviewState, summaryView,
    type ConsultationDetailData, type ConsultationQuestion, type ConsultationRecordingInfo,
} from '../../lib/consultationView';
import type { RecordingStatus, SummaryStatus } from '../../lib/consultationLogic';
import { localDay } from '../../lib/recipientView';
import { useLocalRecordings } from '../consultations/useLocalRecordings';
import RecipientEventForm, { emptyEventForm, eventFormBody, type EventFormMode, type EventFormValues } from './RecipientEventForm';
import { ViewWindow } from './ViewWindow';
import { TeamPasswordWindow } from './TeamArea';
import { SummaryReviewWindow, TranscriptReviewWindow } from './ConsultationReview';
import type { TeamUnlockResult } from '../../lib/teamAccess';
import type { RecipientUi } from './ui';

interface ListItem {
    id: string;
    doctor_name: string | null;
    specialty: string | null;
    scheduled_at: string | null;
    summary_status: SummaryStatus;
    transcript_status: 'draft' | 'approved';
    question_count: number;
    recording_count: number;
    latest_recording_status: RecordingStatus | null;
    locked: boolean;
}

/** Eine Aufnahme in der Karte "Aufnahmen": vom Server oder nur auf diesem Tablet. */
interface RecordingRow {
    key: string;
    serverId: string | null;
    clientId: string;
    startedAt: string;
    durationSeconds: number | null;
    /** Noch nicht gesendet (lokal) */
    unsent: boolean;
    audioGone: boolean;
}

type Notice = { kind: 'ok' | 'error'; text: string } | null;
type Player = { key: string; playing: boolean; current: number; duration: number } | null;

interface Props {
    ui: RecipientUi;
    circleId: string | null;
    /** Gleich ein Gespraech oeffnen ("Zum Arztgespraech" auf der Terminkarte, A16) */
    initialId: string | null;
    onClose: () => void;
    /** Zurueck-Taste (Android): true, wenn hier etwas geschlossen wurde */
    backRef: React.MutableRefObject<(() => boolean) | null>;
    /**
     * E64: Pruefen und Freigeben im Teambereich (Funktion "consultation", Figma A11 bis A14).
     * enabled: von admin gewaehlt; open: Teambereich schon offen (dann keine PIN).
     */
    teamReview?: { configured: boolean | null; open: boolean; onUnlocked: (result: TeamUnlockResult) => void };
}

const EXCERPT_CHARS = 180;

const RecipientConsultations: React.FC<Props> = ({ ui, circleId, initialId, onClose, backRef, teamReview }) => {
    const { t } = useTranslation(['simpleView', 'consultations']);
    const { C, fs, tile, secondaryButton, windowProps, clockOf } = ui;
    const { items: localItems } = useLocalRecordings();

    const [list, setList] = useState<ListItem[] | null>(null);
    const [listError, setListError] = useState(false);
    const [openId, setOpenId] = useState<string | null>(initialId);
    const [detail, setDetail] = useState<ConsultationDetailData | null>(null);
    const [detailError, setDetailError] = useState(false);
    const [form, setForm] = useState<{ mode: EventFormMode; initial: EventFormValues; withExtras: boolean } | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<Notice>(null);
    const [newQuestion, setNewQuestion] = useState<{ text: string; error: boolean } | null>(null);
    const [deleteQuestion, setDeleteQuestion] = useState<ConsultationQuestion | null>(null);
    const [transcriptOpen, setTranscriptOpen] = useState(false);
    // E64: Mitschrift oder Zusammenfassung pruefen (erst PIN, dann bearbeiten)
    const [review, setReview] = useState<{ kind: 'transcript' | 'summary'; step: 'pin' | 'edit' } | null>(null);
    // Aufnahme: Einwilligung, laufende Aufnahme, Fenster fuer "jetzt aufnehmen" ohne Internet
    const [consent, setConsent] = useState(false);
    const [consentAt, setConsentAt] = useState<Date | null>(null);
    const [quickRecord, setQuickRecord] = useState(false);
    const [active, setActive] = useState<ActiveRecording | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [recordError, setRecordError] = useState<string | null>(null);
    const activeRef = useRef<ActiveRecording | null>(null);
    activeRef.current = active;
    // Abspielen
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const urlRef = useRef<string | null>(null);
    const [player, setPlayer] = useState<Player>(null);
    // Aufnahme wird geladen (Abspielen dauert manchmal): Taste zeigt "Wird geladen" und ist gesperrt
    const [loadingKey, setLoadingKey] = useState<string | null>(null);
    const recordingsRef = useRef<HTMLDivElement>(null);

    const offlineText = t('simpleView:doctor.offline');

    // ── Laden ──

    const loadList = useCallback(async () => {
        try {
            const res = await api.get<{ success: boolean; data: ListItem[] }>('/api/consultations');
            const rows = Array.isArray(res.data) ? res.data : [];
            setList(rows);
            setListError(false);
            // Fuer das Lesen ohne Internet: jedes Gespraech einmal abrufen (Zwischenspeicher sw.js).
            if (navigator.onLine) {
                for (const row of rows.slice(0, 30)) void api.get(`/api/consultations/${row.id}`).catch(() => undefined);
            }
        } catch {
            setListError(true);
        }
    }, []);

    const loadDetail = useCallback(async (id: string) => {
        try {
            const res = await api.get<{ success: boolean; data: ConsultationDetailData }>(`/api/consultations/${id}`);
            if (res.data) {
                setDetail(res.data);
                setDetailError(false);
            }
        } catch {
            setDetailError(true);
        }
    }, []);

    useEffect(() => { void loadList(); }, [loadList]);
    useEffect(() => {
        setDetail(null);
        setDetailError(false);
        setConsent(false);
        setConsentAt(null);
        setTranscriptOpen(false);
        setReview(null);
        if (openId) void loadDetail(openId);
    }, [openId, loadDetail]);
    useWebSocketUpdates('consultations', () => {
        void loadList();
        if (openId) void loadDetail(openId);
    });

    // Meldungen bleiben 15 Sekunden stehen (lange genug zum Lesen).
    useEffect(() => {
        if (!notice) return;
        const id = window.setTimeout(() => setNotice(null), 15_000);
        return () => window.clearTimeout(id);
    }, [notice]);

    // ── Aufnahme ──

    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - active.startedAt.getTime()) / 1000)), 1000);
        return () => window.clearInterval(timer);
    }, [active]);

    const stopRecording = useCallback(async () => {
        const rec = activeRef.current;
        if (!rec) return;
        setBusy(true);
        try {
            await rec.stop();
        } finally {
            setActive(null);
            setQuickRecord(false);
            setConsent(false);
            setConsentAt(null);
            setBusy(false);
            setNotice({ kind: 'ok', text: t('simpleView:doctor.recordSaved') });
            if (openId) void loadDetail(openId);
            void loadList();
        }
    }, [loadDetail, loadList, openId, t]);

    // Fenster schliessen waehrend der Aufnahme: sauber beenden, nichts geht verloren.
    useEffect(() => () => { void activeRef.current?.stop(); }, []);

    const startRecording = async (consultationId: string | null) => {
        if (!consent || busy) return;
        setRecordError(null);
        if (!isRecordingSupported()) {
            setRecordError(t('consultations:recorder.errors.UNSUPPORTED'));
            return;
        }
        setBusy(true);
        try {
            const rec = await startConsultationRecording({
                circleId,
                consultationId,
                consentConfirmed: true,
                consentAt: consentAt ?? new Date(),
            });
            rec.onStorageError(() => {
                setRecordError(t('consultations:recorder.errors.STORAGE_FULL'));
            });
            rec.onMicEnded(() => {
                setRecordError(t('simpleView:doctor.micEnded'));
            });
            setElapsed(0);
            setActive(rec);
        } catch (e) {
            const code = e instanceof ConsultationRecorderError ? e.code : 'START_FAILED';
            setRecordError(t(`consultations:recorder.errors.${code}`));
        } finally {
            setBusy(false);
        }
    };

    // ── Abspielen ──

    const stopPlayer = useCallback(() => {
        audioRef.current?.pause();
        audioRef.current = null;
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
        setPlayer(null);
    }, []);
    useEffect(() => stopPlayer, [stopPlayer]);

    const togglePlay = async (row: RecordingRow) => {
        if (player?.key === row.key && audioRef.current) {
            if (player.playing) { audioRef.current.pause(); setPlayer({ ...player, playing: false }); }
            else { void audioRef.current.play(); setPlayer({ ...player, playing: true }); }
            return;
        }
        if (loadingKey) return;
        stopPlayer();
        setLoadingKey(row.key);
        try {
            const { blob } = await loadRecordingAudio({ id: row.serverId, client_id: row.clientId });
            const url = URL.createObjectURL(blob);
            urlRef.current = url;
            const audio = new Audio(url);
            audioRef.current = audio;
            const fallback = row.durationSeconds ?? 0;
            const durationOf = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallback);
            audio.ontimeupdate = () => setPlayer((p) => (p && p.key === row.key ? { ...p, current: audio.currentTime, duration: durationOf() } : p));
            audio.onended = () => setPlayer((p) => (p && p.key === row.key ? { ...p, playing: false, current: 0 } : p));
            setPlayer({ key: row.key, playing: true, current: 0, duration: fallback });
            await audio.play();
        } catch {
            stopPlayer();
            setNotice({ kind: 'error', text: navigator.onLine ? t('simpleView:doctor.playError') : t('simpleView:doctor.playOffline') });
        } finally {
            setLoadingKey(null);
        }
    };

    // ── Aktionen ──

    const openNewDoctor = () => {
        setFormError(null);
        setForm({ mode: 'doctor', initial: emptyEventForm(localDay(new Date()), 'doctor'), withExtras: true });
    };

    const openEdit = () => {
        if (!detail) return;
        const c = detail.consultation;
        const date = c.scheduled_at ? clockDate(c.scheduled_at) : null;
        const pad = (n: number) => String(n).padStart(2, '0');
        setFormError(null);
        setForm({
            mode: 'doctorEdit',
            withExtras: Boolean(c.event_id),
            initial: {
                ...emptyEventForm(date ? localDay(date) : localDay(new Date()), 'doctor'),
                title: c.doctor_name ?? '',
                time: date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : '',
                location: c.location ?? '',
                companionNeeded: c.companion_needed,
                companionName: c.companions[0] ?? '',
                companionMemberId: c.companion_member_ids[0] ?? null,
                travelNeeded: c.travel_needed,
                driver: c.driver ?? '',
                takeAlong: c.take_along ?? '',
            },
        });
    };

    const submitForm = async (values: EventFormValues, startTime: string) => {
        if (!form || busy) return;
        setBusy(true);
        setFormError(null);
        try {
            if (form.mode === 'doctor') {
                // E59: Termin ueber die Termin-Route (Art Arzt), dann das Gespraech damit verknuepfen.
                const ev = await api.post<{ success: boolean; data: { id: string } | null; queued?: boolean }>(
                    '/api/events', { ...eventFormBody(values, startTime), category: 'doctor' }
                );
                if (!ev.data?.id) throw new Error('EVENT');
                try {
                    const created = await api.post<{ success: boolean; data: { id: string } | null }>('/api/consultations', {
                        event_id: ev.data.id, doctor_name: values.title, scheduled_at: startTime, location: values.location.trim() || null,
                    });
                    if (!created.data?.id) throw new Error('CONSULTATION');
                    setForm(null);
                    // B2: danach zurueck zur Liste (A1), das neue Gespraech steht darin.
                    await loadList();
                } catch {
                    setForm(null);
                    setNotice({ kind: 'error', text: t('simpleView:doctor.linkError') });
                }
            } else if (detail) {
                const body = eventFormBody(values, startTime);
                await api.put(`/api/consultations/${detail.consultation.id}`, {
                    doctor_name: body.title,
                    scheduled_at: startTime,
                    location: body.location,
                    ...(form.withExtras ? {
                        companion_needed: body.companion_needed,
                        ...(values.companionMemberId ? { companion_member_id: values.companionMemberId } : { companion_name: values.companionName.trim() || null }),
                        travel_needed: body.travel_needed,
                        driver: body.driver,
                        take_along: body.take_along,
                    } : {}),
                });
                setForm(null);
                setNotice({ kind: 'ok', text: t('simpleView:doctor.saved') });
                await loadDetail(detail.consultation.id);
                void loadList();
            }
        } catch {
            setFormError(navigator.onLine ? t('simpleView:meds.error') : offlineText);
        } finally {
            setBusy(false);
        }
    };

    /** "Gespraech jetzt aufnehmen": ohne Termin, mit heutigem Datum (E59). Ohne Internet direkt aufnehmen. */
    const recordNow = async () => {
        if (busy) return;
        setNotice(null);
        if (!navigator.onLine) {
            setConsent(false);
            setRecordError(null);
            setQuickRecord(true);
            return;
        }
        setBusy(true);
        try {
            const res = await api.post<{ success: boolean; data: { id: string } | null }>('/api/consultations', {
                scheduled_at: toNaiveLocal(new Date()).slice(0, 16),
            });
            await loadList();
            if (res.data?.id) {
                setOpenId(res.data.id);
                window.setTimeout(() => recordingsRef.current?.scrollIntoView({ block: 'start' }), 300);
            }
        } catch {
            // Server nicht erreichbar: trotzdem aufnehmen, das Gespraech entsteht beim Senden.
            setConsent(false);
            setRecordError(null);
            setQuickRecord(true);
        } finally {
            setBusy(false);
        }
    };

    const addQuestion = async () => {
        if (!newQuestion || !detail || busy) return;
        const text = newQuestion.text.trim();
        if (!text) { setNewQuestion({ ...newQuestion, error: true }); return; }
        setBusy(true);
        try {
            await api.post(`/api/consultations/${detail.consultation.id}/questions`, { text });
            setNewQuestion(null);
            await loadDetail(detail.consultation.id);
            void loadList();
        } catch {
            setNewQuestion(null);
            setNotice({ kind: 'error', text: navigator.onLine ? t('simpleView:meds.error') : offlineText });
        } finally {
            setBusy(false);
        }
    };

    const confirmDeleteQuestion = async () => {
        if (!deleteQuestion || !detail || busy) return;
        setBusy(true);
        try {
            await api.delete(`/api/consultations/${detail.consultation.id}/questions/${deleteQuestion.id}`);
            setDeleteQuestion(null);
            await loadDetail(detail.consultation.id);
            void loadList();
        } catch {
            setDeleteQuestion(null);
            setNotice({ kind: 'error', text: navigator.onLine ? t('simpleView:meds.error') : offlineText });
        } finally {
            setBusy(false);
        }
    };

    // ── Zurueck-Taste: oberstes Fenster schliessen ──
    backRef.current = () => {
        if (review) { setReview(null); return true; }
        if (active) { void stopRecording(); return true; }
        if (quickRecord) { setQuickRecord(false); return true; }
        if (deleteQuestion) { setDeleteQuestion(null); return true; }
        if (newQuestion) { setNewQuestion(null); return true; }
        if (form) { setForm(null); return true; }
        if (transcriptOpen) { setTranscriptOpen(false); return true; }
        if (openId) { stopPlayer(); setOpenId(null); return true; }
        return false;
    };

    // ── Bausteine ──

    const statusLine = (kind: 'saved' | 'checked' | 'unchecked', text: string) => {
        const color = kind === 'checked' ? C.green : C.amber;
        const bg = kind === 'checked' ? C.greenSoft : C.amberSoft;
        const Icon = kind === 'saved' ? CloudOff : kind === 'checked' ? Check : CircleAlert;
        return (
            <p className="flex items-start gap-3 rounded-2xl px-4 py-3 font-bold" style={{ ...fs(19), color, backgroundColor: bg }}>
                <Icon className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
                <span>{text}</span>
            </p>
        );
    };

    const cardTitle = (n: number, text: string, id: string) => (
        <h3 id={id} className="flex items-center gap-4 font-bold" style={{ ...fs(26), lineHeight: 1.3 }}>
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full" style={{ ...fs(21), backgroundColor: C.blueSoft, color: C.blueDark }} aria-hidden="true">{n}</span>
            {text}
        </h3>
    );

    const infoRow = (Icon: React.FC<{ className?: string; style?: React.CSSProperties }>, label: string, value: string) => (
        <div className="flex items-start gap-4">
            <Icon className="mt-1 h-8 w-8 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
            <div className="min-w-0">
                <p className="font-bold" style={{ ...fs(19), color: C.muted }}>{label}</p>
                <p className="font-bold" style={fs(22)}>{value}</p>
            </div>
        </div>
    );

    const primaryButton: React.CSSProperties = { ...fs(21), backgroundColor: C.blue, color: '#ffffff' };

    const consentCard = (onStart: () => void) => (
        <div className="space-y-4">
            <label
                className="flex min-h-[4.5rem] cursor-pointer items-center gap-4 rounded-2xl p-4 font-bold"
                style={{ ...fs(20), backgroundColor: consent ? C.blueSoft : C.card, border: `2px solid ${consent ? C.blue : C.control}` }}
            >
                <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => { setConsent(e.target.checked); setConsentAt(e.target.checked ? new Date() : null); }}
                    className="h-10 w-10 shrink-0 cursor-pointer"
                    style={{ accentColor: C.blue }}
                />
                {t('simpleView:doctor.consent')}
            </label>
            <button
                type="button"
                onClick={onStart}
                disabled={!consent || busy}
                className="flex min-h-[4rem] w-full items-center justify-center gap-3 rounded-2xl px-4 font-bold disabled:opacity-50"
                style={primaryButton}
            >
                <Mic className="h-7 w-7 shrink-0" aria-hidden="true" />
                {t('simpleView:doctor.startRecording')}
            </button>
            {!consent && <p style={{ ...fs(18), color: C.muted }}>{t('simpleView:doctor.consentHint')}</p>}
            {recordError && <p role="alert" className="font-bold" style={{ ...fs(20), color: C.red }}>{recordError}</p>}
        </div>
    );

    const noticeBox = notice && (
        <div role={notice.kind === 'error' ? 'alert' : 'status'} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4"
            style={{ backgroundColor: notice.kind === 'ok' ? C.greenSoft : C.card, border: `2px solid ${notice.kind === 'error' ? C.red : C.green}` }}>
            <p className="font-bold" style={{ ...fs(21), color: notice.kind === 'error' ? C.red : C.text }}>{notice.text}</p>
            <button type="button" onClick={() => setNotice(null)} className="min-h-[3.5rem] min-w-[6rem] rounded-2xl px-4 font-bold" style={secondaryButton}>
                {t('simpleView:ok')}
            </button>
        </div>
    );

    // ── A2: Aufnahme laeuft (liegt ueber allem) ──
    if (active) {
        return (
            <ViewWindow id="rv-doc-recording" title={t('simpleView:doctor.recordingTitle')} icon={<Mic className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} layer="dialog" {...windowProps} onClose={() => void stopRecording()}>
                <section className="space-y-4 rounded-3xl p-6 text-center" style={{ backgroundColor: C.redSoft, border: `2px solid ${C.red}` }} aria-live="polite">
                    <p className="flex items-center justify-center gap-3 font-bold" style={{ ...fs(26), color: C.red }}>
                        <span className="inline-block h-6 w-6 rounded-full" style={{ backgroundColor: C.red }} aria-hidden="true" />
                        {t('simpleView:doctor.recordingTitle')}
                    </p>
                    <p className="font-bold tabular-nums" style={{ ...fs(56), lineHeight: 1.1 }}>{formatDuration(elapsed)}</p>
                    <p className="font-bold" style={fs(20)}>{t('simpleView:doctor.recordingHint')}</p>
                    {recordError && <p role="alert" className="font-bold" style={{ ...fs(20), color: C.red }}>{recordError}</p>}
                    <button type="button" onClick={() => void stopRecording()} disabled={busy} className="flex min-h-[4rem] w-full items-center justify-center gap-3 rounded-2xl px-4 font-bold disabled:opacity-70" style={primaryButton}>
                        <Square className="h-7 w-7 shrink-0" aria-hidden="true" />
                        {t('simpleView:doctor.stopRecording')}
                    </button>
                </section>
            </ViewWindow>
        );
    }

    // ── Formular (A4/A5, Angaben aendern) ──
    if (form) {
        return (
            <RecipientEventForm
                ui={ui}
                mode={form.mode}
                initial={form.initial}
                withExtras={form.withExtras}
                busy={busy}
                saveError={formError}
                onCancel={() => setForm(null)}
                onSubmit={(values, start) => void submitForm(values, start)}
            />
        );
    }

    // ── Aufnehmen ohne Internet: Gespraech entsteht beim Senden ──
    if (quickRecord) {
        return (
            <ViewWindow id="rv-doc-quick" title={t('simpleView:doctor.recordNow')} icon={<Mic className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} layer="dialog" {...windowProps} onClose={() => setQuickRecord(false)}>
                <section className="space-y-4 rounded-3xl p-5 min-[512px]:p-6" style={tile}>
                    <p style={fs(21)}>{t('simpleView:doctor.quickHint')}</p>
                    {consentCard(() => void startRecording(null))}
                </section>
            </ViewWindow>
        );
    }

    // ── A9: Frage loeschen ──
    if (deleteQuestion && detail) {
        const c = detail.consultation;
        const when = c.scheduled_at ? new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'long' }).format(clockDate(c.scheduled_at) ?? new Date()) : '';
        return (
            <ViewWindow id="rv-doc-delq" title={t('simpleView:doctor.deleteQuestionTitle')} role="alertdialog" layer="dialog" {...windowProps} onClose={() => setDeleteQuestion(null)}>
                <div className="rounded-3xl p-6 min-[512px]:p-8" style={tile}>
                    <p style={fs(21)}>{t('simpleView:doctor.deleteQuestionAsk')}</p>
                    <div className="mt-3 rounded-2xl p-4" style={{ backgroundColor: C.blueSoft, color: C.blueDark }}>
                        <p className="font-bold" style={fs(24)}>{deleteQuestion.text}</p>
                        {(c.doctor_name || when) && (
                            <p className="font-bold" style={fs(19)}>{t('simpleView:doctor.deleteQuestionFor', { doctor: c.doctor_name ?? t('consultations:defaultTitle'), date: when })}</p>
                        )}
                    </div>
                    <div className="mt-6 grid grid-cols-1 gap-3 min-[512px]:grid-cols-2">
                        <button type="button" onClick={() => setDeleteQuestion(null)} className="min-h-[4rem] rounded-2xl px-4 font-bold" style={secondaryButton}>
                            {t('simpleView:doctor.keep')}
                        </button>
                        <button type="button" onClick={() => void confirmDeleteQuestion()} disabled={busy} className="flex min-h-[4rem] items-center justify-center gap-2 rounded-2xl px-4 font-bold disabled:opacity-70" style={primaryButton}>
                            <Trash2 className="h-7 w-7 shrink-0" aria-hidden="true" />
                            {t('simpleView:doctor.yesDelete')}
                        </button>
                    </div>
                </div>
            </ViewWindow>
        );
    }

    // ── A8: Frage hinzufuegen ──
    if (newQuestion && detail) {
        return (
            <ViewWindow id="rv-doc-addq" title={t('simpleView:doctor.addQuestion')} layer="dialog" {...windowProps} onClose={() => setNewQuestion(null)}>
                <form className="space-y-5 rounded-3xl p-6 min-[512px]:p-8" style={tile} onSubmit={(e) => { e.preventDefault(); void addQuestion(); }} noValidate>
                    <div>
                        <label htmlFor="rv-doc-q" className="block font-bold" style={fs(21)}>{t('simpleView:doctor.questionLabel')}</label>
                        <input
                            id="rv-doc-q"
                            type="text"
                            autoFocus
                            autoComplete="off"
                            maxLength={1000}
                            value={newQuestion.text}
                            onChange={(e) => setNewQuestion({ text: e.target.value, error: false })}
                            aria-invalid={newQuestion.error ? true : undefined}
                            aria-describedby={newQuestion.error ? 'rv-doc-q-error' : undefined}
                            className="mt-2 min-h-[4rem] w-full min-w-0 rounded-2xl px-4 font-bold"
                            style={{ ...fs(24), backgroundColor: C.card, color: C.text, border: `2px solid ${newQuestion.error ? C.red : C.control}` }}
                        />
                        {newQuestion.error && <p id="rv-doc-q-error" role="alert" className="mt-2 font-bold" style={{ ...fs(20), color: C.red }}>{t('simpleView:doctor.questionError')}</p>}
                    </div>
                    <div className="grid grid-cols-1 gap-3 min-[512px]:grid-cols-2">
                        <button type="button" onClick={() => setNewQuestion(null)} className="min-h-[4rem] rounded-2xl px-4 font-bold" style={secondaryButton}>
                            {t('simpleView:measure.cancel')}
                        </button>
                        <button type="submit" disabled={busy} className="flex min-h-[4rem] items-center justify-center gap-2 rounded-2xl px-4 font-bold disabled:opacity-70" style={primaryButton}>
                            <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                            {t('simpleView:doctor.add')}
                        </button>
                    </div>
                </form>
            </ViewWindow>
        );
    }

    // ── E64: Pruefen und freigeben (A11 bis A14) ──
    if (review && detail) {
        const back = () => setReview(null);
        const title = t(review.kind === 'transcript' ? 'simpleView:doctor.review.transcriptTitle' : 'simpleView:doctor.review.summaryTitle');
        if (review.step === 'pin') {
            return (
                <TeamPasswordWindow
                    ui={ui}
                    title={title}
                    intro={t('simpleView:doctor.review.pinIntro')}
                    icon={review.kind === 'transcript'
                        ? <FileText className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
                        : <ClipboardList className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />}
                    onClose={back}
                    onUnlocked={(result) => {
                        teamReview?.onUnlocked(result);
                        if (result.functions.includes('consultation')) {
                            setReview({ ...review, step: 'edit' });
                        } else {
                            setReview(null);
                            setNotice({ kind: 'error', text: t('simpleView:doctor.review.notSetUp') });
                        }
                    }}
                />
            );
        }
        const ReviewWindow = review.kind === 'transcript' ? TranscriptReviewWindow : SummaryReviewWindow;
        return (
            <ReviewWindow
                ui={ui}
                detail={detail}
                onCancel={back}
                onApproved={() => {
                    setReview(null);
                    setNotice({ kind: 'ok', text: t('simpleView:doctor.review.done') });
                    if (openId) void loadDetail(openId);
                }}
                onExpired={() => setReview({ ...review, step: 'pin' })}
            />
        );
    }
    // Roadmap 21.2: Taste immer da. Ohne PIN (sicher bekannt, nicht nur offline) ein Hinweis statt der PIN-Seite.
    const startReview = (kind: 'transcript' | 'summary') => {
        if (!teamReview?.open && teamReview?.configured === false) {
            setNotice({ kind: 'error', text: t('simpleView:doctor.review.notSetUp') });
            return;
        }
        setReview({ kind, step: teamReview?.open ? 'edit' : 'pin' });
    };
    const reviewButton = (kind: 'transcript' | 'summary') => (
        <button
            type="button"
            onClick={() => startReview(kind)}
            className="flex min-h-[4rem] w-full items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white"
            style={{ ...fs(21), backgroundColor: C.blue }}
        >
            <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
            {t('simpleView:doctor.review.button')}
        </button>
    );

    // ── Ganze Mitschrift lesen ──
    if (transcriptOpen && detail) {
        const parts = detail.recordings.filter((r) => r.transcript);
        return (
            <ViewWindow id="rv-doc-transcript" title={t('simpleView:doctor.transcriptTitle')} icon={<FileText className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} layer="dialog" {...windowProps} onClose={() => setTranscriptOpen(false)}>
                <section className="space-y-5 rounded-3xl p-5 min-[512px]:p-6" style={tile}>
                    {detail.consultation.transcript_status === 'approved'
                        ? statusLine('checked', t('simpleView:doctor.checkedByFamily'))
                        : statusLine('unchecked', t('simpleView:doctor.transcriptUnchecked'))}
                    {parts.map((r, i) => (
                        <div key={r.id}>
                            <p className="font-bold" style={{ ...fs(20), color: C.muted }}>{t('simpleView:doctor.recordingN', { n: i + 1 })}, {clockOf(r.created_at)}</p>
                            <p className="whitespace-pre-wrap" style={fs(21)}>{r.transcript}</p>
                        </div>
                    ))}
                </section>
            </ViewWindow>
        );
    }

    // ── A3/A15: ein Gespraech ──
    if (openId) {
        const close = () => { stopPlayer(); setOpenId(null); void loadList(); };
        if (!detail) {
            return (
                <ViewWindow id="rv-doc-detail" title={t('simpleView:tiles.doctor')} icon={<Stethoscope className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={close}>
                    <section className="rounded-3xl p-5" style={tile}>
                        <p className="font-bold" style={{ ...fs(21), color: detailError ? C.red : C.text }} role={detailError ? 'alert' : undefined}>
                            {detailError ? t('simpleView:loadError') : t('simpleView:ask.loading')}
                        </p>
                    </section>
                </ViewWindow>
            );
        }
        const c = detail.consultation;
        const locked = c.locked;
        const questions = [...detail.questions].sort((a, b) => a.position - b.position);
        // Aufnahmen: vom Server, dazu die noch nicht gesendeten dieses Tablets
        const serverClientIds = new Set(detail.recordings.map((r) => r.client_id));
        const localFor = localItems.filter((r: LocalRecording) => r.consultation_id === c.id && !serverClientIds.has(r.client_id) && isUnsent(r));
        const rows: RecordingRow[] = [
            ...detail.recordings.map((r: ConsultationRecordingInfo) => {
                const local = localItems.find((l) => l.client_id === r.client_id);
                return {
                    key: r.id, serverId: r.id, clientId: r.client_id, startedAt: r.consent_at || r.created_at,
                    durationSeconds: r.duration_seconds, unsent: false, audioGone: Boolean(r.audio_deleted_at) && !local,
                };
            }),
            ...localFor.map((l) => ({
                key: l.client_id, serverId: null, clientId: l.client_id, startedAt: l.started_at,
                durationSeconds: l.duration_seconds, unsent: true, audioGone: false,
            })),
        ].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        const transcript = detail.transcript;
        const summary = c.summary;
        // B3: Kurzfassung als eigener Absatz, Punkte darunter ohne Wiederholungen (lib/consultationView.ts).
        const { overview: summaryOverview, groups: summaryGroups } = summaryView(summary);
        // Mindestens eine Aufnahme ist beim Server und wird noch verarbeitet (nicht fehlgeschlagen).
        const sentRows = detail.recordings.some((r: ConsultationRecordingInfo) => r.status !== 'failed' && r.status !== 'done');
        const summaryAnswers = questions
            .map((q, i) => ({ q, a: answerFor(q, i, summary) }))
            .filter((x): x is { q: ConsultationQuestion; a: string } => Boolean(x.a));
        const title = c.doctor_name || c.specialty || t('consultations:defaultTitle');
        // Roadmap 21.2: immer, solange nicht freigegeben (die PIN fragt startReview ab)
        const canReviewTranscript = Boolean(teamReview) && Boolean(transcript) && c.transcript_status !== 'approved';
        const canReviewSummary = Boolean(teamReview) && c.summary_status !== 'approved';

        return (
            <ViewWindow id="rv-doc-detail" title={title} icon={<Stethoscope className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={close}>
                {noticeBox}
                {/* 1 Vorbereitung */}
                <section aria-labelledby="rv-doc-c1" className="space-y-5 rounded-3xl p-5 min-[512px]:p-6" style={tile}>
                    {cardTitle(1, t('simpleView:doctor.card.prep'), 'rv-doc-c1')}
                    {infoRow(CalendarClock, t('simpleView:doctor.when'), formatConsultationWhen(c.scheduled_at, false) ?? '–')}
                    {infoRow(Stethoscope, t('simpleView:doctor.doctor'), [c.doctor_name, c.location].filter(Boolean).join(', ') || '–')}
                    {c.companions.length > 0 && infoRow(Users, t('simpleView:doctor.companion'), c.companions.join(', '))}
                    {!locked && (
                        <button type="button" onClick={openEdit} className="min-h-[4rem] rounded-2xl px-5 font-bold" style={secondaryButton}>
                            {t('simpleView:doctor.editTitle')}
                        </button>
                    )}
                    <div className="space-y-3">
                        <p className="font-bold" style={fs(21)}>{t('simpleView:doctor.myQuestions')}</p>
                        {questions.length === 0 && <p style={{ ...fs(20), color: C.muted }}>{t('simpleView:doctor.noQuestions')}</p>}
                        <ol className="space-y-3">
                            {questions.map((q, i) => (
                                <li key={q.id} className="flex items-center gap-3 rounded-2xl p-3 pl-4" style={{ backgroundColor: C.bg, border: `1px solid ${C.border}` }}>
                                    <span className="font-bold" style={{ ...fs(20), color: C.blueDark }} aria-hidden="true">{i + 1}.</span>
                                    <span className="min-w-0 flex-1" style={fs(21)}>{q.text}</span>
                                    {!locked && (
                                        <button type="button" onClick={() => setDeleteQuestion(q)} className="flex min-h-[3.5rem] shrink-0 items-center gap-2 rounded-2xl px-4 font-bold" style={secondaryButton} aria-label={t('simpleView:doctor.deleteQuestionN', { n: i + 1 })}>
                                            <Trash2 className="h-6 w-6 shrink-0" aria-hidden="true" />
                                            {t('simpleView:doctor.delete')}
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ol>
                        {!locked && (
                            <button type="button" onClick={() => setNewQuestion({ text: '', error: false })} className="flex min-h-[4rem] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                                <Plus className="h-7 w-7 shrink-0" aria-hidden="true" />
                                {t('simpleView:doctor.addQuestion')}
                            </button>
                        )}
                    </div>
                </section>

                {/* 2 Aufnahmen */}
                <section ref={recordingsRef} aria-labelledby="rv-doc-c2" className="space-y-4 rounded-3xl p-5 min-[512px]:p-6" style={tile}>
                    {cardTitle(2, t('simpleView:doctor.card.recordings'), 'rv-doc-c2')}
                    {!locked && consentCard(() => void startRecording(c.id))}
                    {rows.length === 0 && <p style={{ ...fs(20), color: C.muted }}>{t('simpleView:doctor.noRecordings')}</p>}
                    {rows.map((row, i) => {
                        const p = player?.key === row.key ? player : null;
                        const minutes = row.durationSeconds != null ? Math.max(1, Math.round(row.durationSeconds / 60)) : null;
                        return (
                            <div key={row.key} className="space-y-3 rounded-2xl p-4" style={{ backgroundColor: p ? C.blueSoft : C.bg, border: `2px solid ${p ? C.blue : C.border}` }}>
                                <div className="flex flex-wrap items-center gap-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="font-bold" style={fs(22)}>{t('simpleView:doctor.recordingN', { n: i + 1 })}</p>
                                        <p style={{ ...fs(18), color: C.muted }}>
                                            {t('simpleView:doctor.recordingMeta', { time: clockOf(row.startedAt), count: minutes ?? 0 })}
                                        </p>
                                    </div>
                                    {!row.audioGone && (
                                        <button type="button" onClick={() => void togglePlay(row)} disabled={loadingKey !== null} aria-busy={loadingKey === row.key || undefined} className="flex min-h-[3.5rem] shrink-0 items-center gap-2 rounded-2xl px-5 font-bold disabled:cursor-wait" style={secondaryButton}>
                                            {loadingKey === row.key
                                                ? <Loader2 className="h-6 w-6 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
                                                : p?.playing ? <Pause className="h-6 w-6 shrink-0" aria-hidden="true" /> : <Play className="h-6 w-6 shrink-0" aria-hidden="true" />}
                                            {loadingKey === row.key ? t('simpleView:doctor.playLoading') : p?.playing ? t('simpleView:doctor.pause') : t('simpleView:doctor.play')}
                                        </button>
                                    )}
                                </div>
                                {p && (
                                    <div className="flex items-center gap-3">
                                        <div className="h-4 min-w-0 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: C.card, border: `2px solid ${C.control}` }}>
                                            <div className="h-full" style={{ width: `${p.duration > 0 ? Math.min(100, (p.current / p.duration) * 100) : 0}%`, backgroundColor: C.blue }} />
                                        </div>
                                        <span className="shrink-0 font-bold tabular-nums" style={{ ...fs(18), color: C.blueDark }}>
                                            {t('simpleView:doctor.progress', { current: formatDuration(p.current), total: formatDuration(p.duration) })}
                                        </span>
                                    </div>
                                )}
                                {row.audioGone && <p style={{ ...fs(18), color: C.muted }}>{t('simpleView:doctor.audioGone')}</p>}
                                {row.unsent && statusLine('saved', t('simpleView:doctor.savedOnTablet'))}
                            </div>
                        );
                    })}
                </section>

                {/* 3 Mitschrift */}
                <section aria-labelledby="rv-doc-c3" className="space-y-4 rounded-3xl p-5 min-[512px]:p-6" style={tile}>
                    {cardTitle(3, t('simpleView:doctor.card.transcript'), 'rv-doc-c3')}
                    {transcript ? (
                        <>
                            {c.transcript_status === 'approved'
                                ? statusLine('checked', t('simpleView:doctor.checkedByFamily'))
                                : statusLine('unchecked', t('simpleView:doctor.transcriptUnchecked'))}
                            <p className="rounded-2xl p-4" style={{ ...fs(21), backgroundColor: C.bg }}>
                                {t('simpleView:doctor.quote', { text: transcript.length > EXCERPT_CHARS ? `${transcript.slice(0, EXCERPT_CHARS).trimEnd()} …` : transcript })}
                            </p>
                            <div className="grid grid-cols-1 gap-3 min-[512px]:grid-cols-2">
                                <button type="button" onClick={() => setTranscriptOpen(true)} className={cn('flex min-h-[4rem] w-full items-center justify-center gap-2 rounded-2xl px-4 font-bold', !canReviewTranscript && 'min-[512px]:col-span-2')} style={secondaryButton}>
                                    <FileText className="h-7 w-7 shrink-0" aria-hidden="true" />
                                    {t('simpleView:doctor.readTranscript')}
                                </button>
                                {canReviewTranscript && reviewButton('transcript')}
                            </div>
                        </>
                    ) : (
                        // Roadmap 21.6: Aufnahme auf dem Server, aber noch keine Mitschrift: gelbe Box
                        sentRows ? statusLine('unchecked', t('simpleView:doctor.transcriptProcessing'))
                            : <p style={{ ...fs(20), color: C.muted }}>{rows.length > 0 ? t('simpleView:doctor.transcriptLater') : t('simpleView:doctor.noTranscript')}</p>
                    )}
                </section>

                {/* 4 Zusammenfassung */}
                <section aria-labelledby="rv-doc-c4" className="space-y-4 rounded-3xl p-5 min-[512px]:p-6" style={tile}>
                    {cardTitle(4, t('simpleView:doctor.card.summary'), 'rv-doc-c4')}
                    {summary && (summaryOverview || summaryGroups.length > 0 || summaryAnswers.length > 0) ? (
                        <>
                            {c.summary_status === 'approved'
                                ? statusLine('checked', t('simpleView:doctor.checkedByFamily'))
                                : statusLine('unchecked', t('simpleView:doctor.summaryUnchecked'))}
                            {summaryOverview && <p style={fs(21)}>{summaryOverview}</p>}
                            {summaryGroups.map(({ key, items }) => (
                                <div key={key}>
                                    <p className="font-bold" style={{ ...fs(20), color: C.blueDark }}>{t(`simpleView:doctor.summary.${key}`)}</p>
                                    <ul className="mt-1 list-disc space-y-1 pl-7" style={fs(21)}>
                                        {items.map((item, i) => <li key={i}>{item}</li>)}
                                    </ul>
                                </div>
                            ))}
                            {/* Roadmap 21.5: Antworten auf die vorbereiteten Fragen auch am Tablet */}
                            {summaryAnswers.length > 0 && (
                                <div>
                                    <p className="font-bold" style={{ ...fs(20), color: C.blueDark }}>{t('simpleView:doctor.review.answers')}</p>
                                    <ul className="mt-1 list-disc space-y-1 pl-7" style={fs(21)}>
                                        {summaryAnswers.map(({ q, a }) => <li key={q.id}><span className="font-bold">{q.text}</span> {a}</li>)}
                                    </ul>
                                </div>
                            )}
                            {canReviewSummary && reviewButton('summary')}
                        </>
                    ) : sentRows ? (
                        // Roadmap 21.6: Aufnahme auf dem Server, Zusammenfassung noch nicht da: gelbe Box
                        statusLine('unchecked', t('simpleView:doctor.summaryProcessing'))
                    ) : (
                        <p style={{ ...fs(20), color: C.muted }}>{rows.length > 0 ? t('simpleView:doctor.summaryLater') : t('simpleView:doctor.noSummary')}</p>
                    )}
                </section>
            </ViewWindow>
        );
    }

    // ── A1: Auswahl ──
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const startOf = (i: ListItem) => (i.scheduled_at ? clockDate(i.scheduled_at) : null);
    const upcoming = (list ?? []).filter((i) => { const d = startOf(i); return d && d.getTime() >= todayStart.getTime(); })
        .sort((a, b) => (a.scheduled_at ?? '').localeCompare(b.scheduled_at ?? ''));
    const earlier = (list ?? []).filter((i) => !upcoming.includes(i));
    // Ohne Internet aufgenommen: Gespraech entsteht erst beim Senden.
    const waitingNew = localItems.filter((r) => r.consultation_id === null && isUnsent(r));

    const badge = (item: ListItem, isUpcoming: boolean) => {
        const style = (kind: 'blue' | 'green' | 'amber'): React.CSSProperties => ({
            ...fs(17),
            backgroundColor: kind === 'blue' ? C.blueSoft : kind === 'green' ? C.greenSoft : C.amberSoft,
            color: kind === 'blue' ? C.blueDark : kind === 'green' ? C.green : C.amber,
        });
        const state = reviewState(item, item.latest_recording_status === 'done');
        let kind: 'blue' | 'green' | 'amber' = 'blue';
        let text: string | null = null;
        if (state === 'checked') { kind = 'green'; text = t('simpleView:doctor.badge.checked'); }
        else if (state === 'unchecked') { kind = 'amber'; text = t('simpleView:doctor.badge.unchecked'); }
        else if (!isUpcoming && item.recording_count > 0) text = t('simpleView:doctor.badge.later');
        else if (item.question_count > 0) text = t('simpleView:doctor.badge.questions', { count: item.question_count });
        return text && <span className="mt-1 inline-block rounded-full px-3 py-1 font-bold" style={style(kind)}>{text}</span>;
    };

    const row = (item: ListItem, isUpcoming: boolean) => {
        const parts = consultationDayParts(item.scheduled_at);
        const date = startOf(item);
        const sub = date
            ? `${new Intl.DateTimeFormat(intlLocale(), { weekday: 'long' }).format(date)}, ${t('simpleView:doctor.clock', { time: clockOf(date) })}`
            : null;
        return (
            <li key={item.id}>
                <button type="button" onClick={() => setOpenId(item.id)} className="flex w-full items-center gap-4 rounded-2xl p-4 text-left" style={{ backgroundColor: C.card, color: C.text, border: `2px solid ${C.border}` }}>
                    <span className="flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-2xl" style={{ backgroundColor: C.blueSoft, color: C.blueDark }} aria-hidden="true">
                        <span className="font-bold" style={{ ...fs(28), lineHeight: 1.1 }}>{parts?.day ?? '–'}</span>
                        <span className="font-bold" style={fs(16)}>{parts?.month ?? ''}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block font-bold" style={fs(23)}>{item.doctor_name || item.specialty || t('consultations:defaultTitle')}</span>
                        {sub && <span className="block" style={{ ...fs(19), color: C.muted }}>{sub}</span>}
                        {badge(item, isUpcoming)}
                    </span>
                    <ChevronRight className="h-8 w-8 shrink-0" style={{ color: C.text }} aria-hidden="true" />
                </button>
            </li>
        );
    };

    return (
        <ViewWindow id="rv-doc-list" title={t('simpleView:doctor.listTitle')} icon={<Stethoscope className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={onClose}>
            {noticeBox}
            {listError && !list && <p role="alert" className="font-bold" style={{ ...fs(21), color: C.red }}>{t('simpleView:loadError')}</p>}
            <section aria-labelledby="rv-doc-upcoming" className="space-y-4 rounded-3xl p-5 min-[512px]:p-6" style={tile}>
                <h3 id="rv-doc-upcoming" className="font-bold" style={{ ...fs(24), lineHeight: 1.3 }}>{t('simpleView:doctor.upcoming')}</h3>
                {waitingNew.length > 0 && (
                    statusLine('saved', t('simpleView:doctor.waitingNew', { count: waitingNew.length }))
                )}
                {upcoming.length === 0 ? (
                    <p style={{ ...fs(20), color: C.muted }}>{t('simpleView:doctor.noUpcoming')}</p>
                ) : (
                    <ul className="space-y-3">{upcoming.map((i) => row(i, true))}</ul>
                )}
                <div className="grid grid-cols-1 gap-3 min-[512px]:grid-cols-2">
                    <button type="button" onClick={openNewDoctor} disabled={busy} className="flex min-h-[4rem] items-center justify-center gap-3 rounded-2xl px-4 font-bold disabled:opacity-70" style={primaryButton}>
                        <CalendarPlus className="h-7 w-7 shrink-0" aria-hidden="true" />
                        {t('simpleView:doctor.newAppointment')}
                    </button>
                    <button type="button" onClick={() => void recordNow()} disabled={busy} className="flex min-h-[4rem] items-center justify-center gap-3 rounded-2xl px-4 font-bold disabled:opacity-70" style={secondaryButton}>
                        <Mic className="h-7 w-7 shrink-0" aria-hidden="true" />
                        {t('simpleView:doctor.recordNow')}
                    </button>
                </div>
            </section>
            {earlier.length > 0 && (
                <section aria-labelledby="rv-doc-earlier" className="space-y-4 rounded-3xl p-5 min-[512px]:p-6" style={tile}>
                    <h3 id="rv-doc-earlier" className="font-bold" style={{ ...fs(24), lineHeight: 1.3 }}>{t('simpleView:doctor.earlier')}</h3>
                    <ul className="space-y-3">{earlier.map((i) => row(i, false))}</ul>
                </section>
            )}
        </ViewWindow>
    );
};

export default RecipientConsultations;
