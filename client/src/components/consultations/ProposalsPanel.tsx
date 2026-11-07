import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { CalendarPlus, CheckCircle2, ListChecks, StickyNote, AlertTriangle, Sparkles } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Dialog, Input, Textarea, useToast } from '../ui';
import { formatClock, intlLocale } from '../../i18n/format';
import {
    PROPOSAL_LIMITS,
    applyErrorKey,
    buildApplyPayload,
    canSelectAppointment,
    canSelectNote,
    canSelectTask,
    eventKey,
    isApplied,
    noteKey,
    payloadSize,
    taskKey,
    toAppointmentDraft,
    toTaskDraft,
    type AppointmentDraft,
    type ApplyPayload,
    type ConsultationSummary,
    type NoteDraft,
    type TaskDraft,
} from '../../lib/consultationLogic';

interface Props {
    consultationId: string;
    /** Gespeicherte Zusammenfassung (Vorschlaege stammen immer aus dem gespeicherten Stand) */
    summary: ConsultationSummary;
    applied: Record<string, string>;
    readOnly: boolean;
    onApplied: () => void;
}

interface Item<D> { draft: D; selected: boolean }

interface ApplyResult { tasks: number; appointments: number; notes: number; skipped: number }

/** Datum lesbar in der Sprache der Oberflaeche, z. B. "Di., 24.11.2026". */
export function formatProposalDate(date: string): string {
    const [y, m, d] = date.split('-').map(Number);
    return new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
        .format(new Date(y, m - 1, d));
}

const Group: React.FC<{ icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode }> = ({ icon, title, hint, children }) => (
    <fieldset className="space-y-3">
        <legend className="flex items-center gap-2 text-body font-semibold text-foreground">{icon}{title}</legend>
        {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
        {children}
    </fieldset>
);

const AppliedBadge: React.FC<{ label: string }> = ({ label }) => (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-3 py-1 text-caption font-semibold text-success">
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />{label}
    </span>
);

const ProposalsPanel: React.FC<Props> = ({ consultationId, summary, applied, readOnly, onApplied }) => {
    const { t } = useTranslation(['consultations', 'common']);
    const navigate = useNavigate();
    const { showToast } = useToast();

    // Entwuerfe neu aufbauen, sobald sich der gespeicherte Stand aendert.
    const source = useMemo(
        () => JSON.stringify([summary.next_steps, summary.appointments, summary.family_notes]),
        [summary]
    );
    const [tasks, setTasks] = useState<Item<TaskDraft>[]>([]);
    const [events, setEvents] = useState<Item<AppointmentDraft>[]>([]);
    const [notes, setNotes] = useState<Item<NoteDraft>[]>([]);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setTasks(summary.next_steps.map((s) => ({ draft: toTaskDraft(s), selected: false })));
        setEvents(summary.appointments.map((a) => ({ draft: toAppointmentDraft(a), selected: false })));
        setNotes(summary.family_notes.map((n) => ({ draft: { content: n }, selected: false })));
        setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [source]);

    const total = tasks.length + events.length + notes.length;
    if (total === 0) {
        return <p className="text-body text-muted-foreground">{t('consultations:proposals.empty')}</p>;
    }

    const taskDone = (d: TaskDraft) => isApplied(applied, taskKey(d.text));
    const eventDone = (d: AppointmentDraft) => isApplied(applied, eventKey(d.title, d.date, d.time));
    const noteDone = (d: NoteDraft) => isApplied(applied, noteKey(d.content));

    // Auswahl nur, wenn gueltig und noch nicht uebernommen; sonst faellt sie weg.
    const payload: ApplyPayload = buildApplyPayload(
        tasks.map((x) => ({ ...x, selected: x.selected && !taskDone(x.draft) })),
        events.map((x) => ({ ...x, selected: x.selected && !eventDone(x.draft) })),
        notes.map((x) => ({ ...x, selected: x.selected && !noteDone(x.draft) }))
    );
    const count = payloadSize(payload);

    const update = <D,>(list: Item<D>[], set: (v: Item<D>[]) => void, index: number, patch: Partial<Item<D>>) =>
        set(list.map((x, i) => (i === index ? { ...x, ...patch } : x)));

    const timeLabel = (date: string, time: string) =>
        t('consultations:proposals.timeFormat', { time: formatClock(new Date(`${date}T${time}:00`)) });

    const apply = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await api.post<{ success: boolean; data: ApplyResult }>(`/api/consultations/${consultationId}/apply`, payload);
            const r = res.data ?? { tasks: 0, appointments: 0, notes: 0, skipped: 0 };
            const parts = [
                r.appointments ? t('consultations:proposals.countAppointments', { count: r.appointments }) : null,
                r.tasks ? t('consultations:proposals.countTasks', { count: r.tasks }) : null,
                r.notes ? t('consultations:proposals.countNotes', { count: r.notes }) : null,
            ].filter(Boolean) as string[];
            const target = r.appointments ? '/calendar' : r.tasks ? '/tasks' : r.notes ? '/' : null;
            showToast({
                title: parts.length
                    ? t('consultations:proposals.created', { list: parts.join(', ') })
                    : t('consultations:proposals.nothingNew'),
                description: r.skipped ? t('consultations:proposals.skipped', { count: r.skipped }) : undefined,
                actionLabel: target
                    ? t(target === '/calendar' ? 'consultations:proposals.openCalendar' : target === '/tasks' ? 'consultations:proposals.openTasks' : 'consultations:proposals.openBoard')
                    : undefined,
                onAction: target ? () => navigate(target) : undefined,
            });
            setConfirmOpen(false);
            onApplied();
        } catch (e) {
            setError(t(applyErrorKey(e instanceof Error ? e.message : '')));
        } finally {
            setBusy(false);
        }
    };

    const checkbox = (id: string, checked: boolean, disabled: boolean, onChange: (v: boolean) => void, label: string) => (
        <input
            id={id}
            type="checkbox"
            className="mt-1 h-6 w-6 shrink-0 accent-primary disabled:opacity-40"
            checked={checked}
            disabled={disabled}
            aria-label={label}
            onChange={(e) => onChange(e.target.checked)}
        />
    );

    const cardClass = (done: boolean, selected: boolean) =>
        `flex items-start gap-3 rounded-input border p-3 ${done ? 'border-success/40 bg-success/5' : selected ? 'border-primary bg-primary/5' : 'border-border bg-card'}`;

    return (
        <div className="space-y-6">
            <p className="flex items-start gap-2 rounded-input border border-primary/30 bg-primary/5 p-3 text-body text-foreground">
                <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                {readOnly ? t('consultations:proposals.hintReadOnly') : t('consultations:proposals.hint')}
            </p>

            {events.length > 0 && (
                <Group icon={<CalendarPlus className="h-5 w-5 text-primary" aria-hidden="true" />} title={t('consultations:proposals.appointments')}>
                    {events.map((x, i) => {
                        const done = eventDone(x.draft);
                        const valid = canSelectAppointment(x.draft);
                        const missing = !x.draft.date || !x.draft.time;
                        const label = x.draft.title || t('consultations:proposals.appointmentN', { n: i + 1 });
                        return (
                            <div key={i} className={cardClass(done, x.selected)}>
                                {!readOnly && checkbox(`prop-event-${i}`, x.selected && !done && valid, done || !valid, (v) => update(events, setEvents, i, { selected: v }), label)}
                                <div className="min-w-0 flex-1 space-y-2">
                                    {readOnly || done ? (
                                        <p className="text-body">
                                            <span className="font-semibold">{x.draft.title}</span>
                                            {x.draft.date && <span className="block text-muted-foreground">{formatProposalDate(x.draft.date)}{x.draft.time ? `, ${timeLabel(x.draft.date, x.draft.time)}` : ''}</span>}
                                            {x.draft.location && <span className="block text-muted-foreground">{x.draft.location}</span>}
                                        </p>
                                    ) : (
                                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                            <div className="sm:col-span-2">
                                                <Input id={`prop-event-title-${i}`} label={t('consultations:proposals.title')} value={x.draft.title} maxLength={PROPOSAL_LIMITS.event}
                                                    onChange={(e) => update(events, setEvents, i, { draft: { ...x.draft, title: e.target.value } })} />
                                            </div>
                                            <Input id={`prop-event-date-${i}`} type="date" label={t('consultations:proposals.date')} value={x.draft.date}
                                                onChange={(e) => update(events, setEvents, i, { draft: { ...x.draft, date: e.target.value } })} />
                                            <Input id={`prop-event-time-${i}`} type="time" label={t('consultations:proposals.time')} value={x.draft.time}
                                                onChange={(e) => update(events, setEvents, i, { draft: { ...x.draft, time: e.target.value } })} />
                                            <div className="sm:col-span-2">
                                                <Input id={`prop-event-loc-${i}`} label={t('consultations:proposals.location')} value={x.draft.location} maxLength={255}
                                                    onChange={(e) => update(events, setEvents, i, { draft: { ...x.draft, location: e.target.value } })} />
                                            </div>
                                        </div>
                                    )}
                                    {done && <AppliedBadge label={t('consultations:proposals.applied')} />}
                                    {!done && missing && (
                                        <p className="flex items-center gap-2 rounded-input bg-warning/15 px-3 py-2 text-body font-medium text-foreground" role="note">
                                            <AlertTriangle className="h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
                                            {t('consultations:proposals.needDateTime')}
                                        </p>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </Group>
            )}

            {tasks.length > 0 && (
                <Group icon={<ListChecks className="h-5 w-5 text-primary" aria-hidden="true" />} title={t('consultations:proposals.tasks')}>
                    {tasks.map((x, i) => {
                        const done = taskDone(x.draft);
                        const valid = canSelectTask(x.draft);
                        const label = x.draft.text || t('consultations:proposals.taskN', { n: i + 1 });
                        return (
                            <div key={i} className={cardClass(done, x.selected)}>
                                {!readOnly && checkbox(`prop-task-${i}`, x.selected && !done && valid, done || !valid, (v) => update(tasks, setTasks, i, { selected: v }), label)}
                                <div className="min-w-0 flex-1 space-y-2">
                                    {readOnly || done ? (
                                        <p className="text-body">
                                            <span className="font-semibold">{x.draft.text}</span>
                                            {x.draft.due && <span className="block text-muted-foreground">{t('consultations:proposals.dueOn', { date: formatProposalDate(x.draft.due) })}</span>}
                                        </p>
                                    ) : (
                                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr]">
                                            <Input id={`prop-task-text-${i}`} label={t('consultations:proposals.task')} value={x.draft.text} maxLength={PROPOSAL_LIMITS.task}
                                                onChange={(e) => update(tasks, setTasks, i, { draft: { ...x.draft, text: e.target.value } })} />
                                            <Input id={`prop-task-due-${i}`} type="date" label={t('consultations:proposals.due')} value={x.draft.due}
                                                onChange={(e) => update(tasks, setTasks, i, { draft: { ...x.draft, due: e.target.value } })} />
                                        </div>
                                    )}
                                    {done && <AppliedBadge label={t('consultations:proposals.applied')} />}
                                </div>
                            </div>
                        );
                    })}
                </Group>
            )}

            {notes.length > 0 && (
                <Group icon={<StickyNote className="h-5 w-5 text-primary" aria-hidden="true" />} title={t('consultations:proposals.notes')} hint={t('consultations:proposals.notesHint')}>
                    {notes.map((x, i) => {
                        const done = noteDone(x.draft);
                        const valid = canSelectNote(x.draft);
                        const label = x.draft.content || t('consultations:proposals.noteN', { n: i + 1 });
                        return (
                            <div key={i} className={cardClass(done, x.selected)}>
                                {!readOnly && checkbox(`prop-note-${i}`, x.selected && !done && valid, done || !valid, (v) => update(notes, setNotes, i, { selected: v }), label)}
                                <div className="min-w-0 flex-1 space-y-2">
                                    {readOnly || done ? (
                                        <p className="whitespace-pre-wrap text-body">{x.draft.content}</p>
                                    ) : (
                                        <>
                                            <Textarea id={`prop-note-${i}-text`} aria-label={label} rows={2} maxLength={PROPOSAL_LIMITS.note} value={x.draft.content}
                                                onChange={(e) => update(notes, setNotes, i, { draft: { content: e.target.value } })} />
                                            <p className="text-right text-caption text-muted-foreground">
                                                {t('consultations:proposals.charsLeft', { count: PROPOSAL_LIMITS.note - x.draft.content.trim().length })}
                                            </p>
                                        </>
                                    )}
                                    {done && <AppliedBadge label={t('consultations:proposals.applied')} />}
                                </div>
                            </div>
                        );
                    })}
                </Group>
            )}

            {!readOnly && (
                <div className="flex flex-col items-end gap-2 border-t border-border pt-4">
                    {error && !confirmOpen && <p className="text-body text-danger" role="alert">{error}</p>}
                    <Button onClick={() => { setError(null); setConfirmOpen(true); }} disabled={busy || count === 0}>
                        <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />
                        {t('consultations:proposals.applySelected', { count })}
                    </Button>
                </div>
            )}

            <Dialog
                open={confirmOpen}
                onOpenChange={(open) => { if (!busy) setConfirmOpen(open); }}
                title={t('consultations:proposals.confirmTitle')}
                description={t('consultations:proposals.confirmDescription')}
            >
                <div className="space-y-4">
                    <ul className="space-y-2 text-body">
                        {payload.appointments.map((a, i) => (
                            <li key={`a${i}`} className="flex gap-2">
                                <CalendarPlus className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                                <span>{t('consultations:proposals.confirmAppointment', {
                                    title: a.title,
                                    date: formatProposalDate(a.date),
                                    time: timeLabel(a.date, a.time),
                                })}{a.location ? `, ${a.location}` : ''}</span>
                            </li>
                        ))}
                        {payload.tasks.map((x, i) => (
                            <li key={`t${i}`} className="flex gap-2">
                                <ListChecks className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                                <span>{x.due
                                    ? t('consultations:proposals.confirmTaskDue', { title: x.text, date: formatProposalDate(x.due) })
                                    : t('consultations:proposals.confirmTask', { title: x.text })}</span>
                            </li>
                        ))}
                        {payload.notes.map((n, i) => (
                            <li key={`n${i}`} className="flex gap-2">
                                <StickyNote className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                                <span>{t('consultations:proposals.confirmNote', { text: n.content })}</span>
                            </li>
                        ))}
                    </ul>
                    {error && <p className="text-body text-danger" role="alert">{error}</p>}
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={busy}>
                            {t('consultations:proposals.cancel')}
                        </Button>
                        <Button onClick={() => void apply()} disabled={busy || count === 0}>
                            <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />
                            {t('consultations:proposals.confirmYes')}
                        </Button>
                    </div>
                </div>
            </Dialog>
        </div>
    );
};

export default ProposalsPanel;
