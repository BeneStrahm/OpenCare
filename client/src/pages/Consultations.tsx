import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Stethoscope, CalendarClock, MessageSquareText, Mic, CloudUpload } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { api } from '../lib/api';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { Card, CardContent, Button, Badge, Dialog, Input, Textarea, useToast } from '../components/ui';
import EmptyState from '../components/app/EmptyState';
import VocabularyCard from '../components/consultations/VocabularyCard';
import { useLocalRecordings } from '../components/consultations/useLocalRecordings';
import { dateLocale } from '../i18n/format';
import {
    fromDateTimeInput,
    recordingBadgeVariant,
    summaryBadgeVariant,
    type RecordingStatus,
    type SummaryStatus,
} from '../lib/consultationLogic';

export interface ConsultationListItem {
    id: string;
    doctor_name: string | null;
    specialty: string | null;
    scheduled_at: string | null;
    location: string | null;
    reason: string | null;
    summary_status: SummaryStatus;
    question_count: number;
    recording_count: number;
    latest_recording_status: RecordingStatus | null;
    created_at: string;
}

export const consultationTitle = (
    c: { doctor_name: string | null; specialty: string | null },
    fallback: string
): string => c.doctor_name?.trim() || c.specialty?.trim() || fallback;

export const formatConsultationDate = (value: string | null): string | null => {
    if (!value) return null;
    try {
        return format(parseISO(value), 'EEEE d MMMM yyyy, HH:mm', { locale: dateLocale() });
    } catch {
        return value;
    }
};

const emptyForm = { doctor_name: '', specialty: '', scheduled_at: '', location: '', reason: '', create_event: true };

const Consultations: React.FC = () => {
    const { t } = useTranslation(['consultations', 'common']);
    const { activeCircle, canWriteContent } = useCircle();
    const { showToast } = useToast();
    const navigate = useNavigate();
    const { items: localItems, uploader } = useLocalRecordings();

    const [list, setList] = useState<ConsultationListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [form, setForm] = useState(emptyForm);
    const [saving, setSaving] = useState(false);

    const load = async () => {
        try {
            const res = await api.get<{ success: boolean; data: ConsultationListItem[] }>('/api/consultations');
            if (res.success && Array.isArray(res.data)) {
                setList(res.data);
                setFailed(false);
            }
        } catch {
            setFailed(true);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!activeCircle) return;
        setLoading(true);
        void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    useWebSocketUpdates('consultations', () => void load());

    // Neu hochgeladene Aufnahme (z. B. vom Tablet) erscheint ohne Neuladen.
    useEffect(() => {
        if (uploader.lastCompleted) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uploader.lastCompleted?.client_id]);

    const create = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            const res = await api.post<{ success: boolean; data: { id: string } }>('/api/consultations', {
                doctor_name: form.doctor_name.trim() || null,
                specialty: form.specialty.trim() || null,
                scheduled_at: fromDateTimeInput(form.scheduled_at),
                location: form.location.trim() || null,
                reason: form.reason.trim() || null,
                create_event: Boolean(form.create_event && form.scheduled_at),
            });
            if (res.success && res.data) {
                setDialogOpen(false);
                setForm(emptyForm);
                navigate(`/consultations/${res.data.id}`);
            }
        } catch {
            showToast({ variant: 'error', title: t('consultations:list.createError') });
        } finally {
            setSaving(false);
        }
    };

    if (!activeCircle) {
        return (
            <div className="rounded-card border border-dashed border-border-strong p-8 text-center">
                <p className="text-body text-muted-foreground">{t('consultations:noCircle')}</p>
            </div>
        );
    }

    const waiting = localItems.filter((r) => r.state === 'pending' || r.state === 'recording').length;

    return (
        <div className="mx-auto max-w-3xl space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h1 className="font-serif text-display text-foreground">{t('consultations:list.title')}</h1>
                    <p className="mt-1 text-body text-muted-foreground">{t('consultations:list.subtitle')}</p>
                </div>
                {canWriteContent && (
                    <Button size="lg" onClick={() => setDialogOpen(true)} className="min-h-[52px]">
                        <Plus className="mr-2 h-5 w-5" aria-hidden="true" />
                        {t('consultations:list.new')}
                    </Button>
                )}
            </div>

            {waiting > 0 && (
                <p className="flex items-center gap-2 rounded-input border border-primary/30 bg-primary/5 p-4 text-body" role="status">
                    <CloudUpload className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                    {uploader.offline
                        ? t('consultations:queue.waitingOffline', { count: waiting })
                        : t('consultations:queue.waiting', { count: waiting })}
                </p>
            )}

            {failed && (
                <p className="rounded-input border border-dashed border-border-strong p-4 text-center text-body text-muted-foreground" role="alert">
                    {t('consultations:list.loadError')}
                </p>
            )}

            {loading ? (
                <div className="flex justify-center py-8"><div className="spinner-brand" /></div>
            ) : list.length === 0 && !failed ? (
                <EmptyState
                    icon={<Stethoscope className="h-10 w-10" />}
                    title={t('consultations:list.empty')}
                    description={t('consultations:list.emptyHint')}
                    actionLabel={canWriteContent ? t('consultations:list.new') : undefined}
                    onAction={canWriteContent ? () => setDialogOpen(true) : undefined}
                />
            ) : (
                <ul className="space-y-3">
                    {list.map((c) => {
                        const when = formatConsultationDate(c.scheduled_at);
                        return (
                            <li key={c.id}>
                                <Link
                                    to={`/consultations/${c.id}`}
                                    className="block rounded-card focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                                >
                                    <Card>
                                        <CardContent className="space-y-2 pt-5">
                                            <p className="text-h2 font-semibold text-foreground">{consultationTitle(c, t('consultations:defaultTitle'))}</p>
                                            {c.doctor_name && c.specialty && (
                                                <p className="text-body text-muted-foreground">{c.specialty}</p>
                                            )}
                                            {when && (
                                                <p className="flex items-center gap-2 text-body text-foreground">
                                                    <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{when}
                                                </p>
                                            )}
                                            <div className="flex flex-wrap items-center gap-2 pt-1">
                                                <Badge variant={summaryBadgeVariant(c.summary_status)}>
                                                    {t(`consultations:summaryStatus.${c.summary_status}`)}
                                                </Badge>
                                                {c.latest_recording_status && (
                                                    <Badge variant={recordingBadgeVariant(c.latest_recording_status)}>
                                                        {t(`consultations:recordingStatus.${c.latest_recording_status}`)}
                                                    </Badge>
                                                )}
                                                <span className="inline-flex items-center gap-1 text-caption text-muted-foreground">
                                                    <MessageSquareText className="h-4 w-4" aria-hidden="true" />
                                                    {t('consultations:list.questions', { count: c.question_count })}
                                                </span>
                                                <span className="inline-flex items-center gap-1 text-caption text-muted-foreground">
                                                    <Mic className="h-4 w-4" aria-hidden="true" />
                                                    {t('consultations:list.recordings', { count: c.recording_count })}
                                                </span>
                                            </div>
                                        </CardContent>
                                    </Card>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}

            <VocabularyCard canWrite={canWriteContent} />

            <Dialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                title={t('consultations:list.new')}
                description={t('consultations:form.hint')}
            >
                <form onSubmit={(e) => void create(e)} className="space-y-4 px-5 py-5 md:px-6">
                    <Input id="c-doctor" label={t('consultations:form.doctor')} value={form.doctor_name} onChange={(e) => setForm({ ...form, doctor_name: e.target.value })} />
                    <Input id="c-specialty" label={t('consultations:form.specialty')} value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} />
                    <Input id="c-when" type="datetime-local" label={t('consultations:form.scheduledAt')} value={form.scheduled_at} onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })} />
                    <Input id="c-location" label={t('consultations:form.location')} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
                    <Textarea label={t('consultations:form.reason')} rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
                    <label className="flex items-center gap-3 text-body">
                        <input
                            type="checkbox"
                            className="h-5 w-5 accent-primary"
                            checked={form.create_event}
                            disabled={!form.scheduled_at}
                            onChange={(e) => setForm({ ...form, create_event: e.target.checked })}
                        />
                        {t('consultations:form.createEvent')}
                    </label>
                    <div className="flex justify-end gap-2 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>{t('common:actions.cancel')}</Button>
                        <Button type="submit" disabled={saving}>{t('consultations:form.create')}</Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Consultations;
