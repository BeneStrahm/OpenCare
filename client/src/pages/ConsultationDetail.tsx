import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
    ArrowLeft, ArrowUp, ArrowDown, Printer, Trash2, Plus, Save, CheckCircle2, RefreshCw, AlertTriangle,
    Sparkles, FileText, ListChecks, Mic, ClipboardList, CloudUpload, Pencil,
} from 'lucide-react';
import { api } from '../lib/api';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { Card, CardContent, Button, Badge, Input, Textarea, useToast } from '../components/ui';
import RecorderPanel from '../components/consultations/RecorderPanel';
import SummaryEditor from '../components/consultations/SummaryEditor';
import ProposalsPanel from '../components/consultations/ProposalsPanel';
import { useLocalRecordings } from '../components/consultations/useLocalRecordings';
import { discardLocalRecording, kick, retryLocalRecording, saveAsNewConsultation } from '../lib/consultationUploader';
import { consultationTitle, formatConsultationDate } from './Consultations';
import {
    emptySummary,
    errorCodeKey,
    formatDuration,
    fromDateTimeInput,
    isRecordingInProgress,
    isSummaryEmpty,
    moveItem,
    normalizeSummary,
    recordingBadgeVariant,
    summaryBadgeVariant,
    toDateTimeInput,
    withDefaults,
    type ConsultationSummary,
    type RecordingStatus,
    type SummaryStatus,
    isRetryableRecording,
} from '../lib/consultationLogic';

interface Consultation {
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
    /** Uebernommene Vorschlaege: { [schluessel]: angelegte id } */
    applied?: Record<string, string> | null;
    summary_source?: 'ai' | 'human' | null;
    summary_outdated?: boolean;
    created_at: string;
    updated_at: string;
}

interface Question { id: string; text: string; answer: string | null; position: number; created_at: string }

interface Recording {
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
}

interface Detail {
    consultation: Consultation;
    questions: Question[];
    recordings: Recording[];
    transcript: string | null;
}

const Section: React.FC<{ id: string; icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ id, icon, title, children }) => (
    <Card hover={false}>
        <CardContent className="space-y-4 pt-5 md:pt-6">
            <h2 id={id} className="flex items-center gap-2 text-h2 font-semibold text-foreground">
                {icon}{title}
            </h2>
            {children}
        </CardContent>
    </Card>
);

const ConsultationDetail: React.FC = () => {
    const { t } = useTranslation(['consultations', 'common']);
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { activeCircle, canWriteContent } = useCircle();
    const { showToast } = useToast();
    const { items: localItems, uploader } = useLocalRecordings();

    const [detail, setDetail] = useState<Detail | null>(null);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    // Laden scheiterte ohne 404 (meist keine Verbindung)
    const [loadError, setLoadError] = useState(false);

    // Vorbereitung
    const [prep, setPrep] = useState({ doctor_name: '', specialty: '', scheduled_at: '', location: '', reason: '' });
    const [prepDirty, setPrepDirty] = useState(false);
    const [newQuestion, setNewQuestion] = useState('');
    const [editingQuestion, setEditingQuestion] = useState<{ id: string; text: string } | null>(null);

    // Ergebnis
    const [summary, setSummary] = useState<ConsultationSummary | null>(null);
    const [summaryDirty, setSummaryDirty] = useState(false);

    // Nachbereitung
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [notes, setNotes] = useState('');
    const [notesDirty, setNotesDirty] = useState(false);
    const [busy, setBusy] = useState(false);

    // Aktueller Stand der ungespeicherten Eingaben fuer load(): Intervall und
    // WebSocket rufen eine aeltere load()-Fassung auf, darum ueber eine Ref.
    const dirtyRef = useRef({ prep: false, summary: false, notes: false });
    dirtyRef.current = { prep: prepDirty, summary: summaryDirty, notes: notesDirty };

    const questions = useMemo(
        () => (detail ? [...detail.questions].sort((a, b) => a.position - b.position) : []),
        [detail]
    );

    const load = async (opts: { keepEdits?: boolean } = {}) => {
        if (!id) return;
        try {
            const res = await api.get<{ success: boolean; data: Detail }>(`/api/consultations/${id}`);
            if (res.success && res.data) {
                const d = res.data;
                setDetail(d);
                setNotFound(false);
                setLoadError(false);
                const c = d.consultation;
                const dirty = dirtyRef.current;
                const questionIds = [...d.questions].sort((a, b) => a.position - b.position).map((q) => q.id);
                if (!opts.keepEdits || !dirty.prep) {
                    setPrep({
                        doctor_name: c.doctor_name ?? '',
                        specialty: c.specialty ?? '',
                        scheduled_at: toDateTimeInput(c.scheduled_at),
                        location: c.location ?? '',
                        reason: c.reason ?? '',
                    });
                    setPrepDirty(false);
                }
                if (!opts.keepEdits || !dirty.summary) {
                    setSummary(c.summary ? withDefaults(c.summary, questionIds) : null);
                    setSummaryDirty(false);
                }
                if (!opts.keepEdits || !dirty.notes) {
                    setNotes(c.notes ?? '');
                    setNotesDirty(false);
                }
                setAnswers((prev) => {
                    const next: Record<string, string> = {};
                    for (const q of d.questions) next[q.id] = opts.keepEdits && prev[q.id] !== undefined ? prev[q.id] : (q.answer ?? '');
                    return next;
                });
            }
        } catch (error) {
            // Nur ein echtes 404 heisst "nicht gefunden"; sonst meist keine Verbindung.
            if (error instanceof Error && /404|not found/i.test(error.message)) setNotFound(true);
            else setLoadError(true);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, activeCircle?.id]);

    useWebSocketUpdates('consultations', () => void load({ keepEdits: true }));

    // Solange auf dem Server etwas laeuft: alle 15 s nachsehen (falls der WebSocket fehlt).
    const serverBusy = detail?.recordings.some((r) => isRecordingInProgress(r.status)) ?? false;
    useEffect(() => {
        if (!serverBusy) return;
        const timer = window.setInterval(() => void load({ keepEdits: true }), 15_000);
        return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverBusy, id]);

    // Eigene Aufnahme fertig hochgeladen: neu laden.
    useEffect(() => {
        if (uploader.lastCompleted?.consultation_id === id) void load({ keepEdits: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uploader.lastCompleted?.client_id]);

    const fail = (error: unknown) => {
        console.error('Consultation action failed:', error);
        showToast({ title: t('consultations:detail.actionError') });
    };

    const run = async (fn: () => Promise<unknown>, successTitle?: string) => {
        setBusy(true);
        try {
            await fn();
            if (successTitle) showToast({ title: successTitle });
            await load({ keepEdits: true });
        } catch (error) {
            fail(error);
        } finally {
            setBusy(false);
        }
    };

    if (loading && !detail) {
        return <div className="flex justify-center py-12"><div className="spinner-brand" /></div>;
    }
    if (!notFound && loadError && !detail && id) {
        return (
            <div className="mx-auto max-w-3xl space-y-4">
                <Link to="/consultations" className="inline-flex items-center gap-1 text-body text-primary underline-offset-2 hover:underline">
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />{t('consultations:detail.back')}
                </Link>
                <div className="space-y-3 rounded-input border border-warning/40 bg-warning/10 p-6 text-center" role="alert">
                    <p className="text-body text-foreground">{t('consultations:detail.loadError')}</p>
                    <Button onClick={() => { setLoading(true); void load(); }}>{t('consultations:detail.reload')}</Button>
                </div>
            </div>
        );
    }
    if (notFound || !detail || !id) {
        return (
            <div className="mx-auto max-w-3xl space-y-4">
                <Link to="/consultations" className="inline-flex items-center gap-1 text-body text-primary underline-offset-2 hover:underline">
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />{t('consultations:detail.back')}
                </Link>
                <p className="rounded-input border border-dashed border-border-strong p-6 text-center text-body text-muted-foreground">
                    {t('consultations:detail.notFound')}
                </p>
            </div>
        );
    }

    const c = detail.consultation;
    const readOnly = !canWriteContent;
    const when = formatConsultationDate(c.scheduled_at);
    const myLocal = localItems.filter((r) => r.consultation_id === id);

    // ─── Aktionen ───────────────────────────────────────────────────────────

    const savePrep = () => run(() => api.put(`/api/consultations/${id}`, {
        doctor_name: prep.doctor_name.trim() || null,
        specialty: prep.specialty.trim() || null,
        scheduled_at: fromDateTimeInput(prep.scheduled_at),
        location: prep.location.trim() || null,
        reason: prep.reason.trim() || null,
    }).then(() => setPrepDirty(false)), t('consultations:detail.saved'));

    const addQuestion = (e: React.FormEvent) => {
        e.preventDefault();
        const text = newQuestion.trim();
        if (!text) return;
        void run(() => api.post(`/api/consultations/${id}/questions`, { text }).then(() => setNewQuestion('')));
    };

    const saveQuestionText = () => {
        if (!editingQuestion) return;
        const text = editingQuestion.text.trim();
        if (!text) return;
        void run(() => api.put(`/api/consultations/${id}/questions/${editingQuestion.id}`, { text }).then(() => setEditingQuestion(null)));
    };

    const moveQuestion = (index: number, direction: -1 | 1) => {
        const reordered = moveItem(questions, index, direction);
        const changed = reordered
            .map((q, position) => ({ q, position }))
            .filter(({ q, position }) => q.position !== position);
        void run(() => Promise.all(changed.map(({ q, position }) =>
            api.put(`/api/consultations/${id}/questions/${q.id}`, { position }))));
    };

    const deleteQuestion = (q: Question) => {
        if (!window.confirm(t('consultations:prep.confirmDeleteQuestion'))) return;
        void run(() => api.delete(`/api/consultations/${id}/questions/${q.id}`));
    };

    const deleteConsultation = () => {
        if (!window.confirm(t('consultations:detail.confirmDelete'))) return;
        setBusy(true);
        api.delete(`/api/consultations/${id}`)
            .then(() => navigate('/consultations'))
            .catch(fail)
            .finally(() => setBusy(false));
    };

    const questionIds = questions.map((q) => q.id);
    const currentSummary = summary ?? emptySummary(questionIds);
    const saveSummary = () => run(
        () => api.put(`/api/consultations/${id}/summary`, { summary: normalizeSummary(currentSummary, questionIds) })
            .then(() => setSummaryDirty(false)),
        t('consultations:detail.saved')
    );
    const approveSummary = () => {
        if (!window.confirm(t('consultations:summary.confirmApprove'))) return;
        void run(
            () => api.post(`/api/consultations/${id}/summary/approve`, { summary: normalizeSummary(currentSummary, questionIds) })
                .then(() => setSummaryDirty(false)),
            t('consultations:summary.approved')
        );
    };
    const regenerate = () => {
        // Ersetzt auch eine freigegebene oder von Hand bearbeitete Fassung: klar warnen.
        const protectedVersion = detail.consultation.summary_status === 'approved' || detail.consultation.summary_source === 'human';
        const message = protectedVersion ? t('consultations:summary.confirmRegenerateProtected') : t('consultations:summary.confirmRegenerate');
        if (!window.confirm(message)) return;
        void run(() => api.post(`/api/consultations/${id}/summary/regenerate`, {}), t('consultations:summary.regenerating'));
    };

    const retryRecording = (r: Recording) => run(() => api.post(`/api/consultations/recordings/${r.id}/retry`, {}), t('consultations:recordings.retried'));
    const deleteAudio = (r: Recording) => {
        if (!window.confirm(t('consultations:recordings.confirmDeleteAudio'))) return;
        void run(() => api.delete(`/api/consultations/recordings/${r.id}/audio`), t('consultations:recordings.audioDeleted'));
    };

    const saveAnswer = (q: Question) => run(() => api.put(`/api/consultations/${id}/questions/${q.id}`, { answer: (answers[q.id] ?? '').trim() || null }), t('consultations:detail.saved'));
    const saveNotes = () => run(() => api.put(`/api/consultations/${id}`, { notes: notes.trim() || null }).then(() => setNotesDirty(false)), t('consultations:detail.saved'));

    const latestError = [...detail.recordings].reverse().find((r) => r.error_code)?.error_code ?? null;

    return (
        <div className="mx-auto max-w-3xl space-y-6">
            <div className="space-y-2">
                <Link to="/consultations" className="inline-flex items-center gap-1 text-body text-primary underline-offset-2 hover:underline">
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />{t('consultations:detail.back')}
                </Link>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h1 className="font-serif text-display text-foreground">{consultationTitle(c, t('consultations:defaultTitle'))}</h1>
                        {when && <p className="mt-1 text-body text-muted-foreground">{when}</p>}
                    </div>
                    <Badge variant={summaryBadgeVariant(c.summary_status)}>{t(`consultations:summaryStatus.${c.summary_status}`)}</Badge>
                </div>
                <nav aria-label={t('consultations:detail.sections')} className="flex flex-wrap gap-2 pt-1">
                    {(['prep', 'recording', 'result', 'followUp'] as const).map((s) => (
                        <a key={s} href={`#section-${s}`} className="rounded-full border border-border bg-card px-4 py-2 text-caption font-medium text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                            {t(`consultations:detail.nav.${s}`)}
                        </a>
                    ))}
                </nav>
            </div>

            {/* 1. Vorbereitung */}
            <Section id="section-prep" icon={<ClipboardList className="h-5 w-5 text-primary" aria-hidden="true" />} title={t('consultations:prep.title')}>
                {readOnly ? (
                    <dl className="grid grid-cols-1 gap-2 text-body sm:grid-cols-2">
                        {(['doctor_name', 'specialty', 'location', 'reason'] as const).map((k) => (
                            c[k] ? (
                                <div key={k}>
                                    <dt className="text-caption text-muted-foreground">{t(`consultations:form.${k === 'doctor_name' ? 'doctor' : k}`)}</dt>
                                    <dd>{c[k]}</dd>
                                </div>
                            ) : null
                        ))}
                    </dl>
                ) : (
                    <div className="space-y-3">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <Input id="p-doctor" label={t('consultations:form.doctor')} value={prep.doctor_name} onChange={(e) => { setPrep({ ...prep, doctor_name: e.target.value }); setPrepDirty(true); }} />
                            <Input id="p-specialty" label={t('consultations:form.specialty')} value={prep.specialty} onChange={(e) => { setPrep({ ...prep, specialty: e.target.value }); setPrepDirty(true); }} />
                            <Input id="p-when" type="datetime-local" label={t('consultations:form.scheduledAt')} value={prep.scheduled_at} onChange={(e) => { setPrep({ ...prep, scheduled_at: e.target.value }); setPrepDirty(true); }} />
                            <Input id="p-location" label={t('consultations:form.location')} value={prep.location} onChange={(e) => { setPrep({ ...prep, location: e.target.value }); setPrepDirty(true); }} />
                        </div>
                        <Textarea label={t('consultations:form.reason')} rows={3} value={prep.reason} onChange={(e) => { setPrep({ ...prep, reason: e.target.value }); setPrepDirty(true); }} />
                        <div className="flex justify-end">
                            <Button onClick={() => void savePrep()} disabled={busy || !prepDirty}>
                                <Save className="mr-2 h-4 w-4" aria-hidden="true" />{t('common:actions.save')}
                            </Button>
                        </div>
                    </div>
                )}

                <div className="space-y-3 border-t border-border pt-4">
                    <h3 className="text-body font-semibold text-foreground">{t('consultations:prep.questions')}</h3>
                    <p className="text-caption text-muted-foreground">{t('consultations:prep.questionsHint')}</p>
                    {questions.length === 0 && <p className="text-body text-muted-foreground">{t('consultations:prep.noQuestions')}</p>}
                    <ol className="space-y-2">
                        {questions.map((q, i) => (
                            <li key={q.id} className="flex items-start gap-2 rounded-input border border-border bg-card p-3">
                                <span className="pt-2 text-body font-semibold text-muted-foreground" aria-hidden="true">{i + 1}.</span>
                                {editingQuestion?.id === q.id ? (
                                    <div className="flex flex-1 flex-col gap-2">
                                        <Textarea
                                            aria-label={t('consultations:prep.editQuestion')}
                                            value={editingQuestion.text}
                                            rows={2}
                                            autoFocus
                                            onChange={(e) => setEditingQuestion({ id: q.id, text: e.target.value })}
                                        />
                                        <div className="flex justify-end gap-2">
                                            <Button variant="secondary" size="sm" onClick={() => setEditingQuestion(null)}>{t('common:actions.cancel')}</Button>
                                            <Button size="sm" onClick={saveQuestionText} disabled={busy}>{t('common:actions.save')}</Button>
                                        </div>
                                    </div>
                                ) : (
                                    <p className="flex-1 py-1.5 text-body text-foreground">{q.text}</p>
                                )}
                                {!readOnly && editingQuestion?.id !== q.id && (
                                    <div className="flex shrink-0 flex-wrap items-center">
                                        <Button variant="ghost" size="icon" className="h-11 w-11" disabled={busy || i === 0} onClick={() => moveQuestion(i, -1)} aria-label={t('consultations:prep.moveUp', { n: i + 1 })}>
                                            <ArrowUp className="h-4 w-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon" className="h-11 w-11" disabled={busy || i === questions.length - 1} onClick={() => moveQuestion(i, 1)} aria-label={t('consultations:prep.moveDown', { n: i + 1 })}>
                                            <ArrowDown className="h-4 w-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => setEditingQuestion({ id: q.id, text: q.text })} aria-label={t('consultations:prep.editQuestionN', { n: i + 1 })}>
                                            <Pencil className="h-4 w-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon" className="h-11 w-11 text-muted-foreground hover:text-danger" onClick={() => deleteQuestion(q)} aria-label={t('consultations:prep.deleteQuestionN', { n: i + 1 })}>
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                )}
                            </li>
                        ))}
                    </ol>
                    {!readOnly && (
                        <form onSubmit={addQuestion} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                            <Input
                                id="new-question"
                                label={t('consultations:prep.newQuestion')}
                                placeholder={t('consultations:prep.newQuestionPlaceholder')}
                                value={newQuestion}
                                onChange={(e) => setNewQuestion(e.target.value)}
                            />
                            <Button type="submit" disabled={busy || !newQuestion.trim()} className="min-h-[44px] shrink-0">
                                <Plus className="mr-1 h-4 w-4" aria-hidden="true" />{t('common:actions.add')}
                            </Button>
                        </form>
                    )}
                    <Link to="/consultation" className="inline-flex items-center gap-2 text-body text-primary underline-offset-2 hover:underline">
                        <Printer className="h-4 w-4" aria-hidden="true" />{t('consultations:prep.printReport')}
                    </Link>
                </div>
            </Section>

            {/* 2. Aufnahme */}
            <Section id="section-recording" icon={<Mic className="h-5 w-5 text-primary" aria-hidden="true" />} title={t('consultations:recording.title')}>
                {!readOnly ? (
                    <RecorderPanel circleId={activeCircle?.id ?? null} consultationId={id} onStopped={() => void kick()} />
                ) : (
                    <p className="text-body text-muted-foreground">{t('consultations:recording.readOnly')}</p>
                )}

                {myLocal.length > 0 && (
                    <div className="space-y-2">
                        <h3 className="text-body font-semibold text-foreground">{t('consultations:queue.title')}</h3>
                        {uploader.authProblem && (
                            <p className="rounded-input border border-warning/50 bg-warning/10 p-3 text-body text-foreground" role="alert">
                                {t('consultations:queue.authProblem')}
                            </p>
                        )}
                        <ul className="space-y-2">
                            {myLocal.map((r) => {
                                const progress = uploader.progress?.client_id === r.client_id ? uploader.progress : null;
                                const help = uploader.needsHelp[r.client_id] ?? r.needs_help ?? null;
                                const err = help ? null : (uploader.errors[r.client_id] ?? r.last_error);
                                return (
                                    <li key={r.client_id} className={`flex flex-wrap items-center gap-3 rounded-input border p-3 ${help ? 'border-warning/50 bg-warning/10' : 'border-primary/30 bg-primary/5'}`}>
                                        {help
                                            ? <AlertTriangle className="h-5 w-5 text-warning" aria-hidden="true" />
                                            : <CloudUpload className="h-5 w-5 text-primary" aria-hidden="true" />}
                                        <span className="flex-1 text-body" role={help ? 'alert' : undefined}>
                                            {help
                                                ? t(help === 'CONSULTATION_GONE' ? 'consultations:queue.help.CONSULTATION_GONE' : 'consultations:queue.help.generic')
                                                : r.state === 'recording'
                                                    ? t('consultations:queue.stateRecording')
                                                    : progress
                                                        ? t('consultations:queue.uploading', { sent: progress.sent, total: progress.total })
                                                        : uploader.offline
                                                            ? t('consultations:queue.stateOffline')
                                                            : t('consultations:queue.statePending')}
                                            {r.duration_seconds != null && ` (${formatDuration(r.duration_seconds)})`}
                                            {err && <span className="block text-caption text-foreground">{t('consultations:queue.errorTemporary')}</span>}
                                            {(help || err) && <span className="block text-caption text-muted-foreground">{t('consultations:queue.code', { code: help ?? err })}</span>}
                                        </span>
                                        {help === 'CONSULTATION_GONE' && (
                                            <Button variant="secondary" size="sm" onClick={() => void saveAsNewConsultation(r.client_id)}>
                                                {t('consultations:queue.saveAsNew')}
                                            </Button>
                                        )}
                                        {help && help !== 'CONSULTATION_GONE' && (
                                            <Button variant="secondary" size="sm" onClick={() => void retryLocalRecording(r.client_id)}>
                                                {t('consultations:queue.retry')}
                                            </Button>
                                        )}
                                        {(help || err) && r.state === 'pending' && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="text-muted-foreground hover:text-danger"
                                                onClick={() => {
                                                    if (window.confirm(t('consultations:queue.confirmDiscard'))) void discardLocalRecording(r.client_id);
                                                }}
                                            >
                                                {t('consultations:queue.discard')}
                                            </Button>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                )}

                <div className="space-y-2">
                    <h3 className="text-body font-semibold text-foreground">{t('consultations:recordings.title')}</h3>
                    {detail.recordings.length === 0 ? (
                        <p className="text-body text-muted-foreground">{t('consultations:recordings.none')}</p>
                    ) : (
                        <ul className="space-y-2">
                            {detail.recordings.map((r) => {
                                const errKey = errorCodeKey(r.error_code);
                                return (
                                    <li key={r.id} className="space-y-2 rounded-input border border-border bg-card p-3">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Badge variant={recordingBadgeVariant(r.status)}>{t(`consultations:recordingStatus.${r.status}`)}</Badge>
                                            <span className="text-body">{formatConsultationDate(r.created_at)}</span>
                                            {r.duration_seconds != null && <span className="text-caption text-muted-foreground">{formatDuration(r.duration_seconds)}</span>}
                                            {r.audio_deleted_at && <span className="text-caption text-muted-foreground">{t('consultations:recordings.audioGone')}</span>}
                                        </div>
                                        {errKey && <p className="text-caption text-foreground">{t(errKey)}</p>}
                                        {!readOnly && (
                                            <div className="flex flex-wrap gap-2">
                                                {r.status === 'failed' && isRetryableRecording(r.error_code, Boolean(r.audio_deleted_at)) && (
                                                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void retryRecording(r)}>
                                                        <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" />{t('common:actions.retry')}
                                                    </Button>
                                                )}
                                                {!r.audio_deleted_at && !isRecordingInProgress(r.status) && (
                                                    <Button variant="ghost" size="sm" disabled={busy} className="text-muted-foreground hover:text-danger" onClick={() => deleteAudio(r)}>
                                                        <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />{t('consultations:recordings.deleteAudio')}
                                                    </Button>
                                                )}
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </Section>

            {/* 3. Ergebnis */}
            <Section id="section-result" icon={<Sparkles className="h-5 w-5 text-primary" aria-hidden="true" />} title={t('consultations:result.title')}>
                {c.summary_status === 'draft' && (
                    <p className="rounded-input border-2 border-warning bg-warning/10 p-4 text-body font-semibold text-foreground" role="note">
                        {t('consultations:result.draftBanner')}
                    </p>
                )}
                {c.summary_status === 'approved' && (
                    <p className="flex items-center gap-2 rounded-input border border-success/40 bg-success/10 p-4 text-body text-foreground">
                        <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
                        {c.approved_by_name
                            ? t('consultations:result.approvedBy', { name: c.approved_by_name, date: formatConsultationDate(c.approved_at) ?? '' })
                            : t('consultations:result.approvedPlain')}
                    </p>
                )}
                {c.summary_outdated && (
                    <div className="space-y-3 rounded-input border-2 border-warning/50 bg-warning/10 p-4" role="status">
                        <p className="flex items-start gap-2 text-body text-foreground">
                            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
                            {t('consultations:result.outdated')}
                        </p>
                        {!readOnly && (
                            <Button variant="secondary" onClick={regenerate} disabled={busy || serverBusy}>
                                <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />{t('consultations:summary.regenerate')}
                            </Button>
                        )}
                    </div>
                )}
                {c.summary_status === 'none' && (
                    <p className="text-body text-muted-foreground">
                        {serverBusy ? t('consultations:result.processing') : t('consultations:result.noSummary')}
                    </p>
                )}
                {c.summary_status === 'none' && latestError && errorCodeKey(latestError) && (
                    <p className="text-caption text-foreground">{t(errorCodeKey(latestError)!)}</p>
                )}

                {(c.summary || (!readOnly && detail.transcript)) && (
                    <>
                        <SummaryEditor
                            value={currentSummary}
                            onChange={(next) => { setSummary(next); setSummaryDirty(true); }}
                            questions={questions}
                            readOnly={readOnly}
                        />
                        {!readOnly && (
                            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                                {detail.transcript && (
                                    <Button variant="ghost" onClick={regenerate} disabled={busy || serverBusy}>
                                        <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />{t('consultations:summary.regenerate')}
                                    </Button>
                                )}
                                <Button variant="secondary" onClick={() => void saveSummary()} disabled={busy || !summaryDirty}>
                                    <Save className="mr-2 h-4 w-4" aria-hidden="true" />{t('consultations:summary.save')}
                                </Button>
                                <Button onClick={approveSummary} disabled={busy || isSummaryEmpty(currentSummary)}>
                                    <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />
                                    {c.summary_status === 'approved' ? t('consultations:summary.approveAgain') : t('consultations:summary.approve')}
                                </Button>
                            </div>
                        )}
                    </>
                )}

                {detail.transcript && (
                    <details className="rounded-input border border-border bg-card p-3">
                        <summary className="cursor-pointer text-body font-semibold text-foreground">
                            <FileText className="mr-2 inline h-4 w-4" aria-hidden="true" />{t('consultations:result.transcript')}
                        </summary>
                        <p className="mt-2 text-caption text-muted-foreground">{t('consultations:result.transcriptHint')}</p>
                        <p className="mt-3 whitespace-pre-wrap text-body leading-relaxed">{detail.transcript}</p>
                    </details>
                )}
            </Section>

            {/* 4. Nachbereitung */}
            <Section id="section-followUp" icon={<ListChecks className="h-5 w-5 text-primary" aria-hidden="true" />} title={t('consultations:followUp.title')}>
                {questions.length > 0 && (
                    <div className="space-y-3">
                        <h3 className="text-body font-semibold text-foreground">{t('consultations:followUp.answers')}</h3>
                        {questions.map((q, i) => (
                            <div key={q.id} className="space-y-1">
                                <p className="text-body font-medium text-foreground">{i + 1}. {q.text}</p>
                                {readOnly ? (
                                    <p className="text-body text-muted-foreground">{q.answer || t('consultations:summary.notAnswered')}</p>
                                ) : (
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                                        <Textarea
                                            aria-label={t('consultations:followUp.answerFor', { n: i + 1 })}
                                            rows={2}
                                            value={answers[q.id] ?? ''}
                                            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                                        />
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            className="shrink-0"
                                            disabled={busy || (answers[q.id] ?? '') === (q.answer ?? '')}
                                            onClick={() => void saveAnswer(q)}
                                        >
                                            {t('common:actions.save')}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                <div className="space-y-2">
                    {readOnly ? (
                        <>
                            <h3 className="text-body font-semibold text-foreground">{t('consultations:followUp.notes')}</h3>
                            <p className="whitespace-pre-wrap text-body">{c.notes || t('consultations:summary.none')}</p>
                        </>
                    ) : (
                        <>
                            <Textarea
                                label={t('consultations:followUp.notes')}
                                placeholder={t('consultations:followUp.notesPlaceholder')}
                                rows={4}
                                value={notes}
                                onChange={(e) => { setNotes(e.target.value); setNotesDirty(true); }}
                            />
                            <div className="flex justify-end">
                                <Button variant="secondary" onClick={() => void saveNotes()} disabled={busy || !notesDirty}>
                                    <Save className="mr-2 h-4 w-4" aria-hidden="true" />{t('common:actions.save')}
                                </Button>
                            </div>
                        </>
                    )}
                </div>

                {c.summary && (
                    <div className="space-y-3 border-t border-border pt-4">
                        <h3 className="text-h2 font-semibold text-foreground">{t('consultations:proposals.title_section')}</h3>
                        <ProposalsPanel
                            consultationId={c.id}
                            summary={withDefaults(c.summary, questionIds)}
                            applied={c.applied ?? {}}
                            readOnly={readOnly}
                            onApplied={() => void load({ keepEdits: true })}
                        />
                    </div>
                )}
            </Section>

            {!readOnly && (
                <div className="flex justify-end">
                    <Button variant="destructive" onClick={deleteConsultation} disabled={busy}>
                        <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />{t('consultations:detail.delete')}
                    </Button>
                </div>
            )}
        </div>
    );
};

export default ConsultationDetail;
