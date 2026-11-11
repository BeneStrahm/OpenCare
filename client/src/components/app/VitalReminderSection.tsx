import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BellRing, Droplet, Scale, type LucideIcon } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, DatePicker, Input, useToast } from '../ui';
import { useCircle } from '../../contexts/CircleContext';
import { useWebSocketUpdates } from '../../hooks/useWebSocketUpdates';

// Fork, Block E: Messwert-Erinnerungen (Seite Messwerte). Admin und Familie
// schalten die Erinnerung ein und waehlen die Uhrzeit, die anderen sehen nur
// den Stand. Server: GET/PUT /api/vitals/reminders (lib/vitalReminders.ts).

type ReminderType = 'glucose' | 'weight';

interface ReminderDto {
    type: ReminderType;
    enabled: boolean;
    remind_time: string;
    note: string | null;
}

const TYPES: ReminderType[] = ['glucose', 'weight'];
const ICONS: Record<ReminderType, LucideIcon> = { glucose: Droplet, weight: Scale };
const DEFAULT_TIME = '07:30';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Toleriert fehlende Zeilen und die Ersatzantwort der Demo ([]). */
const normalize = (raw: unknown): Record<ReminderType, ReminderDto> => {
    const out = {} as Record<ReminderType, ReminderDto>;
    const list = Array.isArray(raw) ? raw : [];
    for (const type of TYPES) {
        const row = list.find((r) => r && typeof r === 'object' && (r as ReminderDto).type === type) as ReminderDto | undefined;
        out[type] = {
            type,
            enabled: Boolean(row?.enabled),
            remind_time: typeof row?.remind_time === 'string' && TIME_RE.test(row.remind_time) ? row.remind_time : DEFAULT_TIME,
            note: typeof row?.note === 'string' ? row.note : null,
        };
    }
    return out;
};

interface Props {
    /** Eingeschaltete Messwerte des Kreises; nur Blutzucker und Gewicht zaehlen hier. */
    shownTypes: string[];
}

const VitalReminderSection: React.FC<Props> = ({ shownTypes }) => {
    const { t } = useTranslation(['health', 'common']);
    const { activeCircle, canWriteContent } = useCircle();
    const { showToast } = useToast();
    const types = TYPES.filter((type) => shownTypes.includes(type));

    const [drafts, setDrafts] = useState<Record<ReminderType, ReminderDto>>(() => normalize([]));
    const [savingType, setSavingType] = useState<ReminderType | null>(null);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        try {
            const res = await api.get<{ success: boolean; data: unknown }>('/api/vitals/reminders');
            setDrafts(normalize(res.success ? res.data : []));
        } catch {
            /* Anzeige bleibt bei den Standardwerten */
        }
    }, []);

    useEffect(() => {
        if (!activeCircle?.id) return;
        void load();
    }, [activeCircle?.id, load]);

    useWebSocketUpdates('vitals', () => {
        if (savingType === null) void load();
    });

    const update = (type: ReminderType, patch: Partial<ReminderDto>) =>
        setDrafts((prev) => ({ ...prev, [type]: { ...prev[type], ...patch } }));

    const save = async (event: React.FormEvent, type: ReminderType) => {
        event.preventDefault();
        const draft = drafts[type];
        if (!TIME_RE.test(draft.remind_time)) {
            setError(t('health:reminders.timeInvalid'));
            return;
        }
        setSavingType(type);
        setError('');
        try {
            await api.put('/api/vitals/reminders', {
                type,
                enabled: draft.enabled,
                remind_time: draft.remind_time,
                note: draft.note ?? '',
            });
            showToast({ title: t('health:reminders.saved') });
            await load();
        } catch (err) {
            console.error('Failed to save vital reminder:', err);
            setError(err instanceof Error ? err.message : t('health:reminders.saveError'));
        } finally {
            setSavingType(null);
        }
    };

    if (types.length === 0) return null;

    return (
        <section>
            <h2 className="mb-2 text-caption font-semibold text-muted-foreground">{t('health:reminders.title')}</h2>
            <p className="mb-3 text-caption text-muted-foreground">
                {canWriteContent ? t('health:reminders.description') : t('health:reminders.readOnly')}
            </p>
            {error && (
                <p id="vital-reminder-error" role="alert" className="mb-3 rounded-input bg-danger/10 px-3 py-2 text-caption text-danger">
                    {error}
                </p>
            )}
            <div className="space-y-2">
                {types.map((type) => {
                    const Icon = ICONS[type];
                    const draft = drafts[type];
                    const fieldId = `vital-reminder-${type}`;
                    return (
                        <div key={type} className="rounded-card border border-border bg-card p-4 shadow-surface">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft text-primary">
                                    <Icon className="h-4 w-4" aria-hidden="true" />
                                </span>
                                <span className="text-body font-medium">{t(`health:vitalTypes.${type}`)}</span>
                            </div>
                            <p className="mt-2 flex items-center gap-1.5 text-caption text-muted-foreground">
                                <BellRing className="h-4 w-4 shrink-0" aria-hidden="true" />
                                {draft.enabled
                                    ? t('health:reminders.statusOn', { time: draft.remind_time })
                                    : t('health:reminders.statusOff')}
                            </p>
                            {canWriteContent && (
                                <form onSubmit={(event) => void save(event, type)} className="mt-3 space-y-3">
                                    <label className="flex min-h-[48px] cursor-pointer items-center gap-3 text-body text-foreground">
                                        <input
                                            type="checkbox"
                                            checked={draft.enabled}
                                            onChange={(e) => update(type, { enabled: e.target.checked })}
                                            className="h-6 w-6 shrink-0 cursor-pointer accent-primary"
                                        />
                                        <span>{t('health:reminders.enable')}</span>
                                    </label>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <DatePicker
                                            type="time"
                                            label={t('health:reminders.timeLabel')}
                                            value={draft.remind_time}
                                            onChange={(value) => update(type, { remind_time: value })}
                                            invalid={error === t('health:reminders.timeInvalid') && !TIME_RE.test(draft.remind_time)}
                                            describedBy={error === t('health:reminders.timeInvalid') && !TIME_RE.test(draft.remind_time) ? 'vital-reminder-error' : undefined}
                                        />
                                        <Input
                                            id={`${fieldId}-note`}
                                            label={t('health:reminders.noteLabel')}
                                            value={draft.note ?? ''}
                                            maxLength={80}
                                            onChange={(e) => update(type, { note: e.target.value })}
                                        />
                                    </div>
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <p className="text-caption text-muted-foreground">{t('health:reminders.hint')}</p>
                                        <Button type="submit" variant="secondary" size="sm" disabled={savingType === type}>
                                            {t('common:actions.save')}
                                        </Button>
                                    </div>
                                </form>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
};

export default VitalReminderSection;
