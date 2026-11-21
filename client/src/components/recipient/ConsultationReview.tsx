// E64 (E59, Figma A12 und A14): Mitschrift oder Zusammenfassung eines Arztgespraechs am Tablet
// pruefen, direkt aendern und freigeben. Nur im offenen Teambereich mit der Funktion
// "consultation" (PIN, A11/A13); der Server prueft das. Zuruecknehmen nur in der App.
import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ClipboardList, FileText } from 'lucide-react';
import { api } from '../../lib/api';
import type { ConsultationDetailData } from '../../lib/consultationView';
import { summaryView } from '../../lib/consultationView';
import { draftToSummary, invalidMedicationLines, summaryToDraft, type SummaryDraft } from '../../lib/consultationReview';
import { ViewWindow } from './ViewWindow';
import type { RecipientUi } from './ui';

interface Props {
    ui: RecipientUi;
    detail: ConsultationDetailData;
    onCancel: () => void;
    /** Freigegeben: Gespraech neu laden und zurueck */
    onApproved: () => void;
    /** Der Teambereich ist zu (Zeit abgelaufen): PIN neu eingeben */
    onExpired: () => void;
}

type SaveError = 'empty' | 'medications' | 'failed' | 'offline' | null;

const useReviewUi = (ui: RecipientUi) => {
    const { C, fs } = ui;
    // Feld waechst mit dem Text (kein Scrollen im Feld, keine versteckte Geste).
    const fieldStyle: React.CSSProperties = {
        ...fs(21),
        lineHeight: 1.5,
        backgroundColor: C.card,
        color: C.text,
        border: `2px solid ${C.control}`,
        ['fieldSizing' as string]: 'content',
    };
    const label = (htmlFor: string, text: string) => (
        <label htmlFor={htmlFor} className="block font-bold" style={fs(21)}>{text}</label>
    );
    return { fieldStyle, label };
};

/** 403 heisst hier: Teambereich abgelaufen oder Funktion abgewaehlt. */
const isForbidden = (err: unknown) => err instanceof Error && /Insufficient role/i.test(err.message);

const Buttons: React.FC<{ ui: RecipientUi; busy: boolean; onCancel: () => void }> = ({ ui, busy, onCancel }) => {
    const { t } = useTranslation(['simpleView']);
    const { C, fs, secondaryButton } = ui;
    return (
        <div className="grid grid-cols-1 gap-3 pt-1 min-[512px]:grid-cols-2">
            <button type="button" onClick={onCancel} className="min-h-[4rem] rounded-2xl px-4 font-bold" style={secondaryButton}>
                {t('simpleView:doctor.review.cancel')}
            </button>
            <button
                type="submit"
                disabled={busy}
                className="flex min-h-[4rem] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white disabled:opacity-70"
                style={{ ...fs(21), backgroundColor: C.blue }}
            >
                <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                {t('simpleView:doctor.review.approve')}
            </button>
        </div>
    );
};

const ErrorLine: React.FC<{ ui: RecipientUi; id: string; error: SaveError }> = ({ ui, id, error }) => {
    const { t } = useTranslation(['simpleView']);
    if (!error) return null;
    return (
        <p id={id} role="alert" className="rounded-2xl p-4 font-bold" style={{ ...ui.fs(21), color: ui.C.red, backgroundColor: ui.C.card, border: `2px solid ${ui.C.red}` }}>
            {t(`simpleView:doctor.review.error.${error}`)}
        </p>
    );
};

/** A12: Mitschrift je Aufnahme pruefen und freigeben. */
export const TranscriptReviewWindow: React.FC<Props> = ({ ui, detail, onCancel, onApproved, onExpired }) => {
    const { t } = useTranslation(['simpleView']);
    const { C, fs, tile, windowProps, clockOf } = ui;
    const uid = useId();
    const { fieldStyle, label } = useReviewUi(ui);
    const parts = detail.recordings.filter((r) => r.transcript);
    const initial = useMemo(() => Object.fromEntries(parts.map((r) => [r.id, r.transcript ?? ''])), [detail]); // eslint-disable-line react-hooks/exhaustive-deps
    const [texts, setTexts] = useState<Record<string, string>>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<SaveError>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (busy) return;
        if (parts.some((r) => !(texts[r.id] ?? '').trim())) { setError('empty'); return; }
        setBusy(true);
        setError(null);
        try {
            const changed = parts.filter((r) => (texts[r.id] ?? '').trim() !== (initial[r.id] ?? '').trim());
            if (changed.length > 0) {
                await api.put(`/api/consultations/${detail.consultation.id}/transcript`, {
                    recordings: parts.map((r) => ({ id: r.id, transcript: texts[r.id] })),
                });
            }
            await api.post(`/api/consultations/${detail.consultation.id}/transcript/approve`, {});
            onApproved();
        } catch (err) {
            if (isForbidden(err)) { onExpired(); return; }
            setError(navigator.onLine ? 'failed' : 'offline');
        } finally {
            setBusy(false);
        }
    };

    return (
        <ViewWindow id={`${uid}-title`} title={t('simpleView:doctor.review.transcriptTitle')} icon={<FileText className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={onCancel}>
            <form onSubmit={submit} className="space-y-5 rounded-3xl p-6 min-[512px]:p-8" style={tile} noValidate>
                <p className="font-bold" style={{ ...fs(20), color: C.muted }}>{t('simpleView:doctor.review.transcriptIntro')}</p>
                {parts.map((r, i) => (
                    <div key={r.id}>
                        {label(`${uid}-${r.id}`, `${t('simpleView:doctor.recordingN', { n: i + 1 })}, ${t('simpleView:doctor.clock', { time: clockOf(r.created_at) })}`)}
                        <textarea
                            id={`${uid}-${r.id}`}
                            value={texts[r.id] ?? ''}
                            onChange={(e) => setTexts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                            rows={4}
                            className="mt-2 w-full min-w-0 rounded-2xl p-4"
                            style={fieldStyle}
                        />
                    </div>
                ))}
                <ErrorLine ui={ui} id={`${uid}-error`} error={error} />
                <Buttons ui={ui} busy={busy} onCancel={onCancel} />
            </form>
        </ViewWindow>
    );
};

/** A14: Zusammenfassung pruefen und freigeben. */
export const SummaryReviewWindow: React.FC<Props> = ({ ui, detail, onCancel, onApproved, onExpired }) => {
    const { t } = useTranslation(['simpleView']);
    const { C, fs, tile, windowProps } = ui;
    const uid = useId();
    const { fieldStyle, label } = useReviewUi(ui);
    const questions = useMemo(() => [...detail.questions].sort((a, b) => a.position - b.position), [detail]);
    const summary = detail.consultation.summary;
    const initial = useMemo<SummaryDraft | null>(() => (summary ? summaryToDraft(summary, questions) : null), [summary, questions]);
    const [draft, setDraft] = useState<SummaryDraft | null>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<SaveError>(null);
    // Termine nur ansehen (aendern in der App)
    const appointments = summaryView(summary).groups.find((g) => g.key === 'appointments')?.items ?? [];

    if (!summary || !initial || !draft) return null;
    const set = (patch: Partial<SummaryDraft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (busy) return;
        if (invalidMedicationLines(draft.medications).length > 0) { setError('medications'); return; }
        setBusy(true);
        setError(null);
        try {
            const next = draftToSummary(summary, initial, draft, questions);
            await api.post(`/api/consultations/${detail.consultation.id}/summary/approve`, { summary: next });
            onApproved();
        } catch (err) {
            if (isForbidden(err)) { onExpired(); return; }
            setError(navigator.onLine ? 'failed' : 'offline');
        } finally {
            setBusy(false);
        }
    };

    const area = (key: 'overview' | 'important' | 'medications' | 'nextSteps', text: string, hint?: string) => (
        <div>
            {label(`${uid}-${key}`, text)}
            {hint && <p className="mt-1" style={{ ...fs(19), color: C.muted }}>{hint}</p>}
            <textarea
                id={`${uid}-${key}`}
                value={draft[key]}
                onChange={(e) => set({ [key]: e.target.value })}
                rows={2}
                className="mt-2 w-full min-w-0 rounded-2xl p-4"
                style={fieldStyle}
            />
        </div>
    );

    return (
        <ViewWindow id={`${uid}-title`} title={t('simpleView:doctor.review.summaryTitle')} icon={<ClipboardList className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={onCancel}>
            <form onSubmit={submit} className="space-y-5 rounded-3xl p-6 min-[512px]:p-8" style={tile} noValidate>
                <p className="font-bold" style={{ ...fs(20), color: C.muted }}>{t('simpleView:doctor.review.summaryIntro')}</p>
                {initial.overview.trim() !== '' && area('overview', t('simpleView:doctor.review.overview'))}
                {area('important', t('simpleView:doctor.summary.important'), t('simpleView:doctor.review.lineHint'))}
                {area('medications', t('simpleView:doctor.summary.medications'), t('simpleView:doctor.review.medicationHint'))}
                {questions.length > 0 && (
                    <fieldset className="space-y-4">
                        <legend className="font-bold" style={fs(21)}>{t('simpleView:doctor.review.answers')}</legend>
                        {questions.map((q, i) => (
                            <div key={q.id}>
                                <label htmlFor={`${uid}-q-${q.id}`} className="block" style={fs(20)}>{`${i + 1}. ${q.text}`}</label>
                                <textarea
                                    id={`${uid}-q-${q.id}`}
                                    value={draft.answers[q.id] ?? ''}
                                    onChange={(e) => set({ answers: { ...draft.answers, [q.id]: e.target.value } })}
                                    rows={1}
                                    className="mt-2 w-full min-w-0 rounded-2xl p-4"
                                    style={fieldStyle}
                                />
                            </div>
                        ))}
                    </fieldset>
                )}
                {area('nextSteps', t('simpleView:doctor.summary.nextSteps'), t('simpleView:doctor.review.lineHint'))}
                {appointments.length > 0 && (
                    <div>
                        <p className="font-bold" style={fs(21)}>{t('simpleView:doctor.summary.appointments')}</p>
                        <ul className="mt-1 list-disc space-y-1 pl-7" style={fs(21)}>
                            {appointments.map((item, i) => <li key={i}>{item}</li>)}
                        </ul>
                        <p className="mt-1" style={{ ...fs(19), color: C.muted }}>{t('simpleView:doctor.review.appointmentsHint')}</p>
                    </div>
                )}
                <ErrorLine ui={ui} id={`${uid}-error`} error={error} />
                <Buttons ui={ui} busy={busy} onCancel={onCancel} />
            </form>
        </ViewWindow>
    );
};
