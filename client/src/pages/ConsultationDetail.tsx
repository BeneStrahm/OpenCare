import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
    ArrowLeft, Printer, Trash2, Plus, Save, CheckCircle2, RefreshCw, AlertTriangle,
    Sparkles, FileText, Mic, ClipboardList, CloudUpload, Pencil, Play, Lock, Undo2,
} from 'lucide-react';
import { api } from '../lib/api';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { Card, CardContent, Button, Badge, Input, Textarea, useToast } from '../components/ui';
import RecorderPanel from '../components/consultations/RecorderPanel';
import SummarySectionsEditor from '../components/consultations/SummarySectionsEditor';
import { useLocalRecordings } from '../components/consultations/useLocalRecordings';
import { discardLocalRecording, kick, retryLocalRecording, saveAsNewConsultation } from '../lib/consultationUploader';
import { consultationTitle, formatConsultationDate } from './Consultations';
import {
    answerFor, loadRecordingAudio, summaryView,
    type ConsultationDetailData, type ConsultationQuestion, type ConsultationRecordingInfo,
} from '../lib/consultationView';
import { isUnsent } from '../lib/consultationStore';
import {
    emptySummary,
    errorCodeKey,
    formatDuration,
    fromDateTimeInput,
    isRecordingInProgress,
    isSummaryEmpty,
    normalizeSummary,
    recordingBadgeVariant,
    toDateTimeInput,
    withDefaults,
    type ConsultationSummary,
    isRetryableRecording,
} from '../lib/consultationLogic';

// Typen gemeinsam mit der einfachen Ansicht (lib/consultationView.ts, E59)
type Question = ConsultationQuestion;
type Recording = ConsultationRecordingInfo;
type Detail = ConsultationDetailData;
type DoctorOption = { name: string; organization: string | null; location: string | null };

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
    const { t } = useTranslation(['consultations', 'common', 'simpleView']);
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

    // Mitschrift je Aufnahme (E59): bearbeiten und freigeben
    const [transcripts, setTranscripts] = useState<Record<string, string>>({});
    const [transcriptDirty, setTranscriptDirty] = useState(false);
    // Abspielen: geladene Aufnahmen (Objekt-URL je Aufnahme)
    const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
    const audioUrlsRef = useRef<Record<string, string>>({});
    audioUrlsRef.current = audioUrls;
    useEffect(() => () => { Object.values(audioUrlsRef.current).forEach((u) => URL.revokeObjectURL(u)); }, []);
    // Aerzte aus den Kontakten fuer das Autovervollstaendigen (E59)
    const [doctors, setDoctors] = useState<DoctorOption[]>([]);
    useEffect(() => {
        api.get<{ success: boolean; data: { doctors: DoctorOption[] } }>('/api/events/people')
            .then((res) => setDoctors(Array.isArray(res.data?.doctors) ? res.data.doctors : []))
            .catch(() => undefined);
    }, [activeCircle?.id]);

    // Ergebnis
    const [summary, setSummary] = useState<ConsultationSummary | null>(null);
    const [summaryDirty, setSummaryDirty] = useState(false);

    // Bearbeiten erst auf Knopfdruck (B5, wie am Tablet)
    const [editPrep, setEditPrep] = useState(false);
    const [editTranscript, setEditTranscript] = useState(false);
    const [editSummary, setEditSummary] = useState(false);
    // E67: Medikamente ohne "Name: Änderung" im Bearbeiten (dann nicht speichern oder freigeben)
    const [summaryInvalid, setSummaryInvalid] = useState(false);
    const [busy, setBusy] = useState(false);

    // Aktueller Stand der ungespeicherten Eingaben fuer load(): Intervall und
    // WebSocket rufen eine aeltere load()-Fassung auf, darum ueber eine Ref.
    const dirtyRef = useRef({ prep: false, summary: false, transcript: false });
    dirtyRef.current = { prep: prepDirty, summary: summaryDirty, transcript: transcriptDirty };

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
                if (!opts.keepEdits || !dirty.transcript) {
                    const next: Record<string, string> = {};
                    for (const r of d.recordings) if (r.transcript) next[r.id] = r.transcript;
                    setTranscripts(next);
                    setTranscriptDirty(false);
                }
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
        showToast({ variant: 'error', title: t('consultations:detail.actionError') });
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
    // Nur noch nicht gesendete Aufnahmen; gesendete bleiben 30 Tage nur zum Abspielen auf dem Geraet (E59).
    const myLocal = localItems.filter((r) => r.consultation_id === id && isUnsent(r));
    // E59: Mitschrift und Zusammenfassung freigegeben: Fragen, Angaben und Aufnahmen gesperrt.
    const locked = c.locked;
    const prepReadOnly = readOnly || locked;

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
                .then(() => { setSummaryDirty(false); setEditSummary(false); }),
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

    const unapproveSummary = () => {
        if (!window.confirm(t('consultations:summary.confirmUnapprove'))) return;
        void run(() => api.post(`/api/consultations/${id}/summary/unapprove`, {}), t('consultations:summary.unapproved'));
    };

    const transcriptBody = () => ({
        recordings: Object.entries(transcripts)
            .filter(([, text]) => text.trim())
            .map(([recId, text]) => ({ id: recId, transcript: text })),
    });
    const saveTranscript = () => run(
        () => api.put(`/api/consultations/${id}/transcript`, transcriptBody()).then(() => setTranscriptDirty(false)),
        t('consultations:detail.saved')
    );
    const approveTranscript = () => {
        if (!window.confirm(t('consultations:transcript.confirmApprove'))) return;
        void run(async () => {
            if (transcriptDirty) {
                await api.put(`/api/consultations/${id}/transcript`, transcriptBody());
                setTranscriptDirty(false);
            }
            await api.post(`/api/consultations/${id}/transcript/approve`, {});
            setEditTranscript(false);
        }, t('consultations:transcript.approved'));
    };
    const unapproveTranscript = () => {
        if (!window.confirm(t('consultations:transcript.confirmUnapprove'))) return;
        void run(() => api.post(`/api/consultations/${id}/transcript/unapprove`, {}), t('consultations:transcript.unapproved'));
    };

    const playRecording = async (r: Recording) => {
        try {
            const { blob } = await loadRecordingAudio({ id: r.id, client_id: r.client_id });
            setAudioUrls((prev) => ({ ...prev, [r.id]: URL.createObjectURL(blob) }));
        } catch {
            showToast({ variant: 'error', title: navigator.onLine ? t('consultations:recordings.playError') : t('consultations:recordings.playOffline') });
        }
    };

    const retryRecording = (r: Recording) => run(() => api.post(`/api/consultations/recordings/${r.id}/retry`, {}), t('consultations:recordings.retried'));
    const deleteAudio = (r: Recording) => {
        if (!window.confirm(t('consultations:recordings.confirmDeleteAudio'))) return;
        void run(() => api.delete(`/api/consultations/recordings/${r.id}/audio`), t('consultations:recordings.audioDeleted'));
    };


    const latestError = [...detail.recordings].reverse().find((r) => r.error_code)?.error_code ?? null;
    // B5: gleicher Aufbau wie am Tablet (vier Karten), Bearbeiten erst auf Knopfdruck.
    const view = summaryView(c.summary ? withDefaults(c.summary, questionIds) : null, { withUnclear: true });
    const infoRows: Array<[string, string | null]> = [
        [t('consultations:detail.when'), when],
        [t('consultations:form.doctor'), [c.doctor_name, c.specialty].filter(Boolean).join(', ') || null],
        [t('consultations:form.location'), c.location],
        [t('consultations:prep.companion'), c.event_id && c.companions.length > 0 ? c.companions.join(', ') : null],
        [t('consultations:prep.driver'), c.event_id && c.travel_needed ? (c.driver || t('consultations:prep.driverMissing')) : null],
        [t('consultations:prep.takeAlong'), c.event_id ? c.take_along : null],
        [t('consultations:form.reason'), c.reason],
    ];
    const statusNote = (approved: boolean, approvedText: string, draftText: string) => approved ? (
        <p className="flex items-center gap-2 rounded-input border border-success/40 bg-success/10 p-3 text-body text-foreground">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />{approvedText}
        </p>
    ) : (
        <p className="rounded-input border-2 border-warning bg-warning/10 p-3 text-body font-semibold text-foreground" role="note">{draftText}</p>
    );

    return (
        <div className="mx-auto max-w-3xl space-y-6">
            <div className="space-y-2">
                <Link to="/consultations" className="inline-flex items-center gap-1 text-body text-primary underline-offset-2 hover:underline">
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />{t('consultations:detail.back')}
                </Link>
                <h1 className="font-serif text-display text-foreground">{consultationTitle(c, t('consultations:defaultTitle'))}</h1>
                {when && <p className="text-body text-muted-foreground">{when}</p>}
            </div>

            {locked && (
                <p className="flex items-start gap-2 rounded-input border border-success/40 bg-success/10 p-4 text-body text-foreground" role="note">
                    <Lock className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
                    {t('consultations:detail.locked')}
                </p>
            )}

            {/* 1. Vorbereitung */}
            <Section id="section-prep" icon={<ClipboardList className="h-5 w-5 text-primary" aria-hidden="true" />} title={t('consultations:prep.title')}>
                {editPrep && !prepReadOnly ? (
                    <div className="space-y-3">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <Input
                                id="p-doctor"
                                label={t('consultations:form.doctor')}
                                list="p-doctor-options"
                                autoComplete="off"
                                value={prep.doctor_name}
                                onChange={(e) => {
                                    const name = e.target.value;
                                    // Arzt aus den Kontakten gewaehlt: Ort vorausfuellen, wenn noch leer (E60).
                                    const match = doctors.find((d) => d.name === name);
                                    setPrep({ ...prep, doctor_name: name, location: !prep.location.trim() && match?.location ? match.location : prep.location });
                                    setPrepDirty(true);
                                }}
                            />
                            <datalist id="p-doctor-options">
                                {doctors.map((d) => <option key={d.name} value={d.name}>{d.organization ?? ''}</option>)}
                            </datalist>
                            <Input id="p-specialty" label={t('consultations:form.specialty')} value={prep.specialty} onChange={(e) => { setPrep({ ...prep, specialty: e.target.value }); setPrepDirty(true); }} />
                            <Input id="p-when" type="datetime-local" label={t('consultations:form.scheduledAt')} value={prep.scheduled_at} onChange={(e) => { setPrep({ ...prep, scheduled_at: e.target.value }); setPrepDirty(true); }} />
                            <Input id="p-location" label={t('consultations:form.location')} value={prep.location} onChange={(e) => { setPrep({ ...prep, location: e.target.value }); setPrepDirty(true); }} />
                        </div>
                        <Textarea label={t('consultations:form.reason')} rows={3} value={prep.reason} onChange={(e) => { setPrep({ ...prep, reason: e.target.value }); setPrepDirty(true); }} />
                        {c.event_id && <p className="text-caption text-muted-foreground">{t('consultations:prep.eventHint')}</p>}
                        <div className="flex flex-wrap justify-end gap-2">
                            <Button variant="secondary" onClick={() => { setEditPrep(false); void load(); }} disabled={busy}>{t('common:actions.cancel')}</Button>
                            <Button onClick={() => void savePrep().then(() => setEditPrep(false))} disabled={busy || !prepDirty}>
                                <Save className="mr-2 h-4 w-4" aria-hidden="true" />{t('common:actions.save')}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <>
                        <dl className="space-y-2 text-body">
                            {infoRows.filter(([, value]) => value).map(([label, value]) => (
                                <div key={label}>
                                    <dt className="text-caption text-muted-foreground">{label}</dt>
                                    <dd className="whitespace-pre-wrap font-medium text-foreground">{value}</dd>
                                </div>
                            ))}
                        </dl>
                        {!prepReadOnly && (
                            <Button variant="secondary" onClick={() => setEditPrep(true)}>
                                <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />{t('consultations:detail.editPrep')}
                            </Button>
                        )}
                    </>
                )}

                <div className="space-y-3 border-t border-border pt-4">
                    <h3 className="text-body font-semibold text-foreground">{t('consultations:prep.questions')}</h3>
                    {questions.length === 0 && <p className="text-body text-muted-foreground">{t('consultations:prep.noQuestions')}</p>}
                    <ol className="space-y-2">
                        {questions.map((q, i) => {
                            const answer = answerFor(q, i, c.summary);
                            return (
                                <li key={q.id} className="flex items-start gap-2 rounded-input border border-border bg-card p-3">
                                    <span className="pt-1.5 text-body font-semibold text-muted-foreground" aria-hidden="true">{i + 1}.</span>
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
                                        <div className="flex-1 py-1">
                                            <p className="text-body text-foreground">{q.text}</p>
                                            {answer && <p className="mt-1 text-body text-muted-foreground">{t('consultations:prep.answer', { text: answer })}</p>}
                                        </div>
                                    )}
                                    {!prepReadOnly && editingQuestion?.id !== q.id && (
                                        <div className="flex shrink-0 items-center">
                                            <Button variant="ghost" size="icon" className="h-12 w-12" onClick={() => setEditingQuestion({ id: q.id, text: q.text })} aria-label={t('consultations:prep.editQuestionN', { n: i + 1 })}>
                                                <Pencil className="h-4 w-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" className="h-12 w-12 text-muted-foreground hover:text-danger" onClick={() => deleteQuestion(q)} aria-label={t('consultations:prep.deleteQuestionN', { n: i + 1 })}>
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ol>
                    {!prepReadOnly && (
                        <form onSubmit={addQuestion} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                            <Input
                                id="new-question"
                                label={t('consultations:prep.newQuestion')}
                                placeholder={t('consultations:prep.newQuestionPlaceholder')}
                                value={newQuestion}
                                onChange={(e) => setNewQuestion(e.target.value)}
                            />
                            <Button type="submit" disabled={busy || !newQuestion.trim()} className="min-h-[48px] shrink-0">
                                <Plus className="mr-1 h-4 w-4" aria-hidden="true" />{t('common:actions.add')}
                            </Button>
                        </form>
                    )}
                    <Link to="/consultation" className="inline-flex items-center gap-2 text-body text-primary underline-offset-2 hover:underline">
                        <Printer className="h-4 w-4" aria-hidden="true" />{t('consultations:prep.printReport')}
                    </Link>
                </div>
            </Section>

            {/* 2. Aufnahmen */}
            <Section id="section-recording" icon={<Mic className="h-5 w-5 text-primary" aria-hidden="true" />} title={t('consultations:recordings.title')}>
                {!prepReadOnly ? (
                    <RecorderPanel circleId={activeCircle?.id ?? null} consultationId={id} onStopped={() => void kick()} />
                ) : (
                    <p className="text-body text-muted-foreground">{locked ? t('consultations:recording.locked') : t('consultations:recording.readOnly')}</p>
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

                {detail.recordings.length === 0 ? (
                    <p className="text-body text-muted-foreground">{t('consultations:recordings.none')}</p>
                ) : (
                    <ul className="space-y-2">
                        {detail.recordings.map((r, i) => {
                            const errKey = errorCodeKey(r.error_code);
                            return (
                                <li key={r.id} className="space-y-2 rounded-input border border-border bg-card p-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                            <p className="text-body font-semibold text-foreground">{t('consultations:recordings.recordingN', { n: i + 1 })}</p>
                                            <p className="text-caption text-muted-foreground">
                                                {[formatConsultationDate(r.created_at), r.duration_seconds != null ? formatDuration(r.duration_seconds) : null].filter(Boolean).join(' · ')}
                                            </p>
                                        </div>
                                        {r.status !== 'done' && <Badge variant={recordingBadgeVariant(r.status)}>{t(`consultations:recordingStatus.${r.status}`)}</Badge>}
                                        {!audioUrls[r.id] && !r.audio_deleted_at && !isRecordingInProgress(r.status) && r.status !== 'uploading' && (
                                            <Button variant="secondary" onClick={() => void playRecording(r)}>
                                                <Play className="mr-1 h-4 w-4" aria-hidden="true" />{t('consultations:recordings.play')}
                                            </Button>
                                        )}
                                    </div>
                                    {r.audio_deleted_at && <p className="text-caption text-muted-foreground">{t('consultations:recordings.audioGone')}</p>}
                                    {errKey && <p className="text-caption text-foreground">{t(errKey)}</p>}
                                    {audioUrls[r.id] && <audio controls autoPlay src={audioUrls[r.id]} className="w-full" aria-label={t('consultations:recordings.player')} />}
                                    {!readOnly && ((r.status === 'failed' && isRetryableRecording(r.error_code, Boolean(r.audio_deleted_at))) || (!r.audio_deleted_at && !isRecordingInProgress(r.status))) && (
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
            </Section>

            {/* 3. Mitschrift (E59) */}
            <Section id="section-transcript" icon={<FileText className="h-5 w-5 text-primary" aria-hidden="true" />} title={t('consultations:transcript.title')}>
                {!detail.transcript ? (
                    <p className="text-body text-muted-foreground">
                        {serverBusy ? t('consultations:result.processing') : t('consultations:transcript.none')}
                    </p>
                ) : (
                    <>
                        {statusNote(
                            c.transcript_status === 'approved',
                            c.transcript_approved_by_name
                                ? t('consultations:result.approvedBy', { name: c.transcript_approved_by_name, date: formatConsultationDate(c.transcript_approved_at) ?? '' })
                                : t('consultations:result.approvedPlain'),
                            t('consultations:transcript.draftBanner'),
                        )}
                        {editTranscript && !readOnly ? (
                            detail.recordings.filter((r) => r.transcript).map((r, i) => (
                                <div key={r.id} className="space-y-1">
                                    <label htmlFor={`tr-${r.id}`} className="block text-body font-semibold text-foreground">
                                        {t('consultations:transcript.recordingN', { n: i + 1, time: formatConsultationDate(r.created_at) ?? '' })}
                                    </label>
                                    <Textarea
                                        id={`tr-${r.id}`}
                                        rows={8}
                                        className="scrollbar-visible"
                                        value={transcripts[r.id] ?? ''}
                                        onChange={(e) => { setTranscripts({ ...transcripts, [r.id]: e.target.value }); setTranscriptDirty(true); }}
                                    />
                                </div>
                            ))
                        ) : (
                            <p className="scrollbar-visible max-h-96 overflow-y-auto whitespace-pre-wrap rounded-input border border-border bg-card p-3 text-body leading-relaxed">{detail.transcript}</p>
                        )}
                        {!readOnly && (
                            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                                {editTranscript ? (
                                    <>
                                        <Button variant="secondary" onClick={() => { setEditTranscript(false); void load(); }} disabled={busy}>{t('common:actions.cancel')}</Button>
                                        <Button variant="secondary" onClick={() => void saveTranscript().then(() => setEditTranscript(false))} disabled={busy || !transcriptDirty}>
                                            <Save className="mr-2 h-4 w-4" aria-hidden="true" />{t('consultations:transcript.save')}
                                        </Button>
                                    </>
                                ) : (
                                    <Button variant="secondary" onClick={() => setEditTranscript(true)} disabled={busy}>
                                        <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />{t('common:actions.edit')}
                                    </Button>
                                )}
                                {c.transcript_status === 'approved' && !transcriptDirty ? (
                                    <Button variant="ghost" onClick={unapproveTranscript} disabled={busy}>
                                        <Undo2 className="mr-2 h-4 w-4" aria-hidden="true" />{t('consultations:transcript.unapprove')}
                                    </Button>
                                ) : (
                                    <Button onClick={approveTranscript} disabled={busy}>
                                        <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />{t('consultations:transcript.approve')}
                                    </Button>
                                )}
                            </div>
                        )}
                    </>
                )}
            </Section>

            {/* 4. Zusammenfassung */}
            <Section id="section-result" icon={<Sparkles className="h-5 w-5 text-primary" aria-hidden="true" />} title={t('consultations:result.title')}>
                {c.summary_status !== 'none' && statusNote(
                    c.summary_status === 'approved',
                    c.approved_by_name
                        ? t('consultations:result.approvedBy', { name: c.approved_by_name, date: formatConsultationDate(c.approved_at) ?? '' })
                        : t('consultations:result.approvedPlain'),
                    t('consultations:result.draftBanner'),
                )}
                {c.summary_outdated && (
                    <p className="flex items-start gap-2 rounded-input border-2 border-warning/50 bg-warning/10 p-3 text-body text-foreground" role="status">
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
                        {t('consultations:result.outdated')}
                    </p>
                )}
                {c.summary_status === 'none' && !editSummary && (
                    <p className="text-body text-muted-foreground">
                        {serverBusy ? t('consultations:result.processing') : t('consultations:result.noSummary')}
                    </p>
                )}
                {c.summary_status === 'none' && latestError && errorCodeKey(latestError) && (
                    <p className="text-caption text-foreground">{t(errorCodeKey(latestError)!)}</p>
                )}

                {editSummary && !readOnly ? (
                    <SummarySectionsEditor
                        original={currentSummary}
                        questions={questions}
                        onChange={(next, invalid) => { setSummary(next); setSummaryDirty(true); setSummaryInvalid(invalid); }}
                    />
                ) : (view.overview || view.groups.length > 0) && (
                    <div className="space-y-4">
                        {view.overview && <p className="text-body leading-relaxed text-foreground">{view.overview}</p>}
                        {view.groups.map(({ key, items }) => (
                            <div key={key}>
                                <h3 className="text-body font-semibold text-foreground">{t(`simpleView:doctor.summary.${key}`)}</h3>
                                <ul className="mt-1 list-disc space-y-1 pl-6 text-body">
                                    {items.map((item, i) => <li key={i}>{item}</li>)}
                                </ul>
                            </div>
                        ))}
                    </div>
                )}

                {!readOnly && (c.summary || detail.transcript) && (
                    <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                        {editSummary ? (
                            <>
                                <Button variant="secondary" onClick={() => { setEditSummary(false); setSummaryInvalid(false); void load(); }} disabled={busy}>{t('common:actions.cancel')}</Button>
                                <Button variant="secondary" onClick={() => void saveSummary().then(() => setEditSummary(false))} disabled={busy || !summaryDirty || summaryInvalid}>
                                    <Save className="mr-2 h-4 w-4" aria-hidden="true" />{t('consultations:summary.save')}
                                </Button>
                            </>
                        ) : (
                            <>
                                {detail.transcript && (
                                    <Button variant="ghost" onClick={regenerate} disabled={busy || serverBusy}>
                                        <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />{t('consultations:summary.regenerate')}
                                    </Button>
                                )}
                                <Button variant="secondary" onClick={() => setEditSummary(true)} disabled={busy}>
                                    <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />{c.summary ? t('common:actions.edit') : t('consultations:summary.write')}
                                </Button>
                            </>
                        )}
                        {c.summary_status === 'approved' && !summaryDirty ? (
                            <Button variant="ghost" onClick={unapproveSummary} disabled={busy}>
                                <Undo2 className="mr-2 h-4 w-4" aria-hidden="true" />{t('consultations:summary.unapprove')}
                            </Button>
                        ) : (c.summary || summaryDirty) && (
                            <Button onClick={approveSummary} disabled={busy || isSummaryEmpty(currentSummary) || (editSummary && summaryInvalid)}>
                                <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />{t('consultations:summary.approve')}
                            </Button>
                        )}
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
