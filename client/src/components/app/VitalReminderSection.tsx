import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BellRing, Droplet, Plus, Scale, Trash2, type LucideIcon } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, DatePicker, Input, useToast } from '../ui';
import { useCircle } from '../../contexts/CircleContext';
import { useWebSocketUpdates } from '../../hooks/useWebSocketUpdates';

// Fork, Block E: Messwert-Erinnerungen (Seite Messwerte). Admin und Familie
// schalten die Erinnerung ein und waehlen bis zu 6 Uhrzeiten mit je einem Hinweis,
// die anderen sehen nur den Stand. Server: GET/PUT /api/vitals/reminders
// (lib/vitalReminders.ts).

type ReminderType = 'glucose' | 'weight';

interface ReminderTime {
    time: string;
    note: string | null;
}

interface ReminderDto {
    type: ReminderType;
    enabled: boolean;
    times: ReminderTime[];
}

const TYPES: ReminderType[] = ['glucose', 'weight'];
const ICONS: Record<ReminderType, LucideIcon> = { glucose: Droplet, weight: Scale };
const DEFAULT_TIME = '07:30';
/** Wie MAX_REMIND_TIMES (server/src/lib/vitalReminders.ts) */
const MAX_TIMES = 6;
/** Vorschlag fuer eine neue Uhrzeit: die erste, die noch frei ist. */
const SUGGESTED_TIMES = ['07:30', '12:00', '18:00', '21:00', '10:00', '15:00'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const cleanTimes = (raw: unknown): ReminderTime[] => (Array.isArray(raw) ? raw : [])
    .filter((x): x is ReminderTime => Boolean(x) && typeof x === 'object' && typeof (x as ReminderTime).time === 'string' && TIME_RE.test((x as ReminderTime).time))
    .map((x) => ({ time: x.time, note: typeof x.note === 'string' ? x.note : null }));

/** Toleriert fehlende Zeilen, die alte Form mit einer Uhrzeit und die Ersatzantwort der Demo ([]). */
const normalize = (raw: unknown): Record<ReminderType, ReminderDto> => {
    const out = {} as Record<ReminderType, ReminderDto>;
    const list = Array.isArray(raw) ? raw : [];
    for (const type of TYPES) {
        const row = list.find((r) => r && typeof r === 'object' && (r as ReminderDto).type === type) as
            (ReminderDto & { remind_time?: unknown; note?: unknown }) | undefined;
        let times = cleanTimes(row?.times);
        if (times.length === 0) times = cleanTimes([{ time: row?.remind_time, note: row?.note }]);
        if (times.length === 0) times = [{ time: DEFAULT_TIME, note: null }];
        out[type] = { type, enabled: Boolean(row?.enabled), times };
    }
    return out;
};

const hasDuplicate = (times: ReminderTime[]) => new Set(times.map((x) => x.time)).size !== times.length;

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

    const updateTime = (type: ReminderType, index: number, patch: Partial<ReminderTime>) =>
        setDrafts((prev) => ({
            ...prev,
            [type]: { ...prev[type], times: prev[type].times.map((x, i) => (i === index ? { ...x, ...patch } : x)) },
        }));

    const addTime = (type: ReminderType) =>
        setDrafts((prev) => {
            const times = prev[type].times;
            if (times.length >= MAX_TIMES) return prev;
            const time = SUGGESTED_TIMES.find((s) => !times.some((x) => x.time === s)) ?? DEFAULT_TIME;
            return { ...prev, [type]: { ...prev[type], times: [...times, { time, note: null }] } };
        });

    const removeTime = (type: ReminderType, index: number) =>
        setDrafts((prev) => {
            const times = prev[type].times;
            if (times.length <= 1) return prev;
            return { ...prev, [type]: { ...prev[type], times: times.filter((_, i) => i !== index) } };
        });

    const save = async (event: React.FormEvent, type: ReminderType) => {
        event.preventDefault();
        const draft = drafts[type];
        if (draft.times.some((x) => !TIME_RE.test(x.time))) {
            setError(t('health:reminders.timeInvalid'));
            return;
        }
        if (hasDuplicate(draft.times)) {
            setError(t('health:reminders.timeDuplicate'));
            return;
        }
        setSavingType(type);
        setError('');
        try {
            await api.put('/api/vitals/reminders', {
                type,
                enabled: draft.enabled,
                times: draft.times.map((x) => ({ time: x.time, note: x.note ?? '' })),
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
                            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                                <div className="flex items-center gap-2">
                                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft text-primary">
                                        <Icon className="h-4 w-4" aria-hidden="true" />
                                    </span>
                                    <span className="text-body font-medium">{t(`health:vitalTypes.${type}`)}</span>
                                </div>
                                {canWriteContent && (
                                    <label className="flex min-h-[48px] cursor-pointer items-center gap-3 text-body text-foreground">
                                        <input
                                            type="checkbox"
                                            checked={draft.enabled}
                                            onChange={(e) => update(type, { enabled: e.target.checked })}
                                            className="h-6 w-6 shrink-0 cursor-pointer accent-primary"
                                        />
                                        <span>{t('health:reminders.enable')}</span>
                                    </label>
                                )}
                            </div>
                            <p className="mt-2 flex items-center gap-1.5 text-caption text-muted-foreground">
                                <BellRing className="h-4 w-4 shrink-0" aria-hidden="true" />
                                {draft.enabled
                                    ? t('health:reminders.statusOn', { time: draft.times.map((x) => x.time).join(', ') })
                                    : t('health:reminders.statusOff')}
                            </p>
                            {canWriteContent && (
                                <form onSubmit={(event) => void save(event, type)} className="mt-3 space-y-3">
                                    {draft.times.map((row, index) => {
                                        const timeBad = (error === t('health:reminders.timeInvalid') && !TIME_RE.test(row.time))
                                            || (error === t('health:reminders.timeDuplicate') && draft.times.filter((x) => x.time === row.time).length > 1);
                                        return (
                                            <div key={index} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
                                                <DatePicker
                                                    type="time"
                                                    label={t('health:reminders.timeLabel')}
                                                    value={row.time}
                                                    onChange={(value) => updateTime(type, index, { time: value })}
                                                    invalid={timeBad}
                                                    describedBy={timeBad ? 'vital-reminder-error' : undefined}
                                                />
                                                <Input
                                                    id={`${fieldId}-note-${index}`}
                                                    label={t('health:reminders.noteLabel')}
                                                    value={row.note ?? ''}
                                                    maxLength={80}
                                                    onChange={(e) => updateTime(type, index, { note: e.target.value })}
                                                />
                                                {draft.times.length > 1 && (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => removeTime(type, index)}
                                                        aria-label={t('health:reminders.removeTimeLabel', { time: row.time })}
                                                    >
                                                        <Trash2 className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
                                                        {t('health:reminders.removeTime')}
                                                    </Button>
                                                )}
                                            </div>
                                        );
                                    })}
                                    {draft.times.length < MAX_TIMES ? (
                                        <Button type="button" variant="secondary" size="sm" onClick={() => addTime(type)}>
                                            <Plus className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
                                            {t('health:reminders.addTime')}
                                        </Button>
                                    ) : (
                                        <p className="text-caption text-muted-foreground">{t('health:reminders.maxTimes', { count: MAX_TIMES })}</p>
                                    )}
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
