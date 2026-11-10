import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, formatDistanceToNow, subDays } from 'date-fns';
import {
    Activity,
    AlertTriangle,
    Droplet,
    Gauge,
    HeartPulse,
    Plus,
    Scale,
    Smile,
    Thermometer,
    Trash2,
    type LucideIcon,
} from 'lucide-react';
import {
    CartesianGrid,
    Legend,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useFeatures } from '../lib/features';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { Button, Dialog, Input, Select, Textarea, useToast } from '../components/ui';
import { ChartCard, EmptyState, ListRow } from '../components/app';
import { dateLocale, formatNumber, intlLocale } from '../i18n/format';
import {
    decimalsFor,
    displayUnit,
    formatVital,
    storageUnit,
    toDisplayValue,
    toInputValue,
    toStorageValue,
    type UnitSystem,
} from '../lib/units';

// ─── Types alignés sur server/src/routes/vitals.ts ──────────────────────────

type VitalType = 'weight' | 'bp' | 'pain' | 'mood' | 'temperature' | 'glucose';

interface Vital {
    id: string;
    type: VitalType;
    value: number | string;
    value2: number | string | null;
    /** Puls pro Minute, nur beim Blutdruck. */
    pulse?: number | string | null;
    unit: string | null;
    measured_at: string;
    recorded_by_user: string | null;
    notes: string | null;
}

/** Plage normale d'une constante, telle que le serveur la renvoie. */
interface VitalThreshold {
    type: VitalType;
    min_value: number | string | null;
    max_value: number | string | null;
    min_value2: number | string | null;
    max_value2: number | string | null;
    min_pulse?: number | string | null;
    max_pulse?: number | string | null;
}

/** Les memes bornes, normalisees en nombres pour les comparaisons. */
interface VitalRange {
    min: number | null;
    max: number | null;
    min2: number | null;
    max2: number | null;
    minP: number | null;
    maxP: number | null;
}

/** Saisie en cours des bornes, gardee en chaines pour accepter la virgule. */
interface ThresholdDraft {
    min: string;
    max: string;
    min2: string;
    max2: string;
    minP: string;
    maxP: string;
}

const VITAL_TYPES: VitalType[] = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'];

const VITAL_ICONS: Record<VitalType, LucideIcon> = {
    weight: Scale,
    bp: HeartPulse,
    pain: Gauge,
    mood: Smile,
    temperature: Thermometer,
    glucose: Droplet,
};

type PeriodKey = '30' | '90' | '365';
const PERIODS: Array<{ key: PeriodKey; days: number }> = [
    { key: '30', days: 30 },
    { key: '90', days: 90 },
    { key: '365', days: 365 },
];

const RECENT_LIST_SIZE = 15;

const toLocalInputValue = (date: Date) => format(date, "yyyy-MM-dd'T'HH:mm");
const parseLocaleNumber = (raw: string): number => Number(raw.trim().replace(',', '.'));

// PostgreSQL renvoie parfois les numeriques en chaine: on normalise avant toute
// comparaison, sinon '9' serait juge superieur a '10'.
const toBound = (raw: number | string | null | undefined): number | null => {
    if (raw === null || raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
};

// Le reglage vit dans les settings du cercle, tapes de facon generique: on le
// lit ici sans elargir le type partage, dont une autre page a la charge.
const readUnitSystem = (settings: unknown): UnitSystem => {
    if (settings !== null && typeof settings === 'object') {
        const raw = (settings as { unit_system?: unknown }).unit_system;
        if (raw === 'imperial') return 'imperial';
    }
    return 'metric';
};

const emptyDrafts = (): Record<VitalType, ThresholdDraft> => ({
    weight: { min: '', max: '', min2: '', max2: '', minP: '', maxP: '' },
    bp: { min: '', max: '', min2: '', max2: '', minP: '', maxP: '' },
    pain: { min: '', max: '', min2: '', max2: '', minP: '', maxP: '' },
    mood: { min: '', max: '', min2: '', max2: '', minP: '', maxP: '' },
    temperature: { min: '', max: '', min2: '', max2: '', minP: '', maxP: '' },
    glucose: { min: '', max: '', min2: '', max2: '', minP: '', maxP: '' },
});

/** Couleur d'un jeton CSS (triplet RGB) résolue pour les attributs SVG de recharts. */
const themeColor = (token: string, fallback: string): string => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return value ? `rgb(${value})` : fallback;
};

// ─── Page ────────────────────────────────────────────────────────────────────

const Health: React.FC = () => {
    const { t } = useTranslation(['health', 'common']);
    const { user } = useAuth();
    const { activeCircle, canWriteContent, canWriteJournal, isAdmin, myRole } = useCircle();
    // Fork: nur die vom Admin gewaehlten Messwerte.
    const { vitalTypes: enabledTypes } = useFeatures();
    const typesKey = enabledTypes.join(',');
    const shownTypes = useMemo(() => VITAL_TYPES.filter((type) => typesKey.split(',').includes(type)), [typesKey]);
    const firstType: VitalType = shownTypes.includes('bp') ? 'bp' : shownTypes[0] ?? 'bp';
    const { showToast } = useToast();

    // Le cercle decide du systeme d'unites: la base reste metrique, seuls la
    // saisie et l'affichage suivent ce choix.
    const unitSystem = readUnitSystem(activeCircle?.settings);

    const [latest, setLatest] = useState<Vital[]>([]);
    const [series, setSeries] = useState<Vital[]>([]);
    const [recent, setRecent] = useState<Vital[]>([]);
    const [thresholds, setThresholds] = useState<VitalThreshold[]>([]);
    const [drafts, setDrafts] = useState<Record<VitalType, ThresholdDraft>>(emptyDrafts);
    const [savingType, setSavingType] = useState<VitalType | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [chartType, setChartType] = useState<VitalType>(firstType);
    const [period, setPeriod] = useState<PeriodKey>('90');

    // Saisie rapide
    const [dialogOpen, setDialogOpen] = useState(false);
    const [formType, setFormType] = useState<VitalType>(firstType);
    const [formValue, setFormValue] = useState('');
    const [formValue2, setFormValue2] = useState('');
    const [formPulse, setFormPulse] = useState('');
    const [formMeasuredAt, setFormMeasuredAt] = useState(() => toLocalInputValue(new Date()));
    const [formNotes, setFormNotes] = useState('');
    const [saving, setSaving] = useState(false);

    const loadLatest = async () => {
        const response = await api.get<{ success: boolean; data: Vital[] }>('/api/vitals/latest');
        if (response.success) setLatest(response.data);
    };

    const loadSeries = async (type: VitalType, periodKey: PeriodKey) => {
        const days = PERIODS.find((p) => p.key === periodKey)?.days ?? 90;
        const params = new URLSearchParams();
        params.set('type', type);
        params.set('from', subDays(new Date(), days).toISOString());
        params.set('limit', '2000');
        const response = await api.get<{ success: boolean; data: Vital[] }>(`/api/vitals?${params.toString()}`);
        if (response.success) setSeries(response.data);
    };

    const loadRecent = async () => {
        const params = new URLSearchParams();
        params.set('from', subDays(new Date(), 90).toISOString());
        params.set('limit', '2000');
        const response = await api.get<{ success: boolean; data: Vital[] }>(`/api/vitals?${params.toString()}`);
        if (response.success) {
            // Le serveur renvoie du plus ancien au plus récent: on garde la fin, inversée.
            setRecent(response.data.slice(-RECENT_LIST_SIZE).reverse());
        }
    };

    const loadThresholds = async () => {
        const response = await api.get<{ success: boolean; data: VitalThreshold[] }>('/api/vitals/thresholds');
        if (response.success) setThresholds(response.data);
    };

    const refreshAll = async (showSpinner: boolean) => {
        if (showSpinner) setLoading(true);
        try {
            await Promise.all([loadLatest(), loadSeries(chartType, period), loadRecent(), loadThresholds()]);
            setError('');
        } catch (err) {
            console.error('Failed to load vitals:', err);
            setError(err instanceof Error ? err.message : t('health:errors.load'));
        } finally {
            if (showSpinner) setLoading(false);
        }
    };

    // Recharger quand le cercle actif change.
    useEffect(() => {
        if (!activeCircle?.id) return;
        void refreshAll(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    // Recharger seulement la courbe quand le type ou la période change.
    useEffect(() => {
        if (!activeCircle?.id) return;
        loadSeries(chartType, period).catch((err) => {
            console.error('Failed to load vital series:', err);
            setError(err instanceof Error ? err.message : t('health:errors.load'));
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chartType, period]);

    // Temps réel: une mesure ajoutée ailleurs (ou via le journal) rafraîchit tout.
    useWebSocketUpdates('vitals', () => {
        void refreshAll(false);
    });

    // ─── Saisie rapide ───────────────────────────────────────────────────────

    const openDialog = () => {
        setFormType('bp');
        setFormValue('');
        setFormValue2('');
        setFormPulse('');
        setFormMeasuredAt(toLocalInputValue(new Date()));
        setFormNotes('');
        setDialogOpen(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (saving) return;

        const value = parseLocaleNumber(formValue);
        if (!formValue.trim() || !Number.isFinite(value)) {
            setError(t('health:errors.valueRequired'));
            return;
        }
        let value2: number | null = null;
        if (formType === 'bp') {
            value2 = parseLocaleNumber(formValue2);
            if (!formValue2.trim() || !Number.isFinite(value2)) {
                setError(t('health:errors.valueRequired'));
                return;
            }
        }
        // Puls ist freiwillig, aber wenn eingetragen, eine Zahl groesser 0.
        let pulse: number | null = null;
        if (formType === 'bp' && formPulse.trim()) {
            pulse = parseLocaleNumber(formPulse);
            if (!Number.isFinite(pulse) || pulse <= 0) {
                setError(t('health:errors.pulseInvalid'));
                return;
            }
        }

        setSaving(true);
        setError('');
        try {
            // La saisie est ramenee a l'unite de stockage avant l'envoi: sans
            // cela, 150 lb seraient enregistrees comme 150 kg.
            const payload: Record<string, unknown> = {
                type: formType,
                value: toStorageValue(formType, value, unitSystem),
                value2: value2 === null ? null : toStorageValue(formType, value2, unitSystem),
                unit: storageUnit(formType),
            };
            if (pulse !== null) payload.pulse = pulse;
            if (formMeasuredAt) payload.measured_at = new Date(formMeasuredAt).toISOString();
            if (formNotes.trim()) payload.notes = formNotes.trim();

            await api.post('/api/vitals', payload);
            setDialogOpen(false);
            showToast({ title: t('health:toasts.saved') });
            await refreshAll(false);
        } catch (err) {
            console.error('Failed to save vital:', err);
            setError(err instanceof Error ? err.message : t('health:errors.save'));
        } finally {
            setSaving(false);
        }
    };

    const canManage = (vital: Vital) =>
        isAdmin || (vital.recorded_by_user !== null && vital.recorded_by_user === user?.id);

    const handleDelete = async (vital: Vital) => {
        if (!window.confirm(t('health:confirmDelete'))) return;
        try {
            await api.delete(`/api/vitals/${vital.id}`);
            showToast({ title: t('health:toasts.deleted') });
            await refreshAll(false);
        } catch (err) {
            console.error('Failed to delete vital:', err);
            setError(err instanceof Error ? err.message : t('health:errors.delete'));
        }
    };

    // ─── Plages normales ─────────────────────────────────────────────────────

    const rangeByType = useMemo(() => {
        const map = new Map<VitalType, VitalRange>();
        for (const row of thresholds) {
            map.set(row.type, {
                min: toBound(row.min_value),
                max: toBound(row.max_value),
                min2: toBound(row.min_value2),
                max2: toBound(row.max_value2),
                minP: toBound(row.min_pulse),
                maxP: toBound(row.max_pulse),
            });
        }
        return map;
    }, [thresholds]);

    // Les champs rejouent ce que le serveur a accepte, y compris apres un
    // rafraichissement declenche par un autre membre du cercle. Les bornes sont
    // stockees en metrique: on les prerempli dans l'unite affichee.
    useEffect(() => {
        const next = emptyDrafts();
        rangeByType.forEach((range, type) => {
            next[type] = {
                min: toInputValue(type, range.min, unitSystem),
                max: toInputValue(type, range.max, unitSystem),
                min2: toInputValue(type, range.min2, unitSystem),
                max2: toInputValue(type, range.max2, unitSystem),
                // Puls hat keine Einheitenumrechnung.
                minP: range.minP === null ? '' : formatNumber(range.minP),
                maxP: range.maxP === null ? '' : formatNumber(range.maxP),
            };
        });
        setDrafts(next);
    }, [rangeByType, unitSystem]);

    const updateDraft = (type: VitalType, field: keyof ThresholdDraft, value: string) => {
        setDrafts((prev) => ({ ...prev, [type]: { ...prev[type], [field]: value } }));
    };

    const handleSaveThreshold = async (event: React.FormEvent, type: VitalType) => {
        event.preventDefault();
        if (savingType) return;

        const draft = drafts[type];
        // Un champ vide vaut « pas de borne »: le serveur retire la plage quand tout est vide.
        const bounds = [draft.min, draft.max, draft.min2, draft.max2, draft.minP, draft.maxP].map((raw) =>
            raw.trim() ? parseLocaleNumber(raw) : null
        );
        if (bounds.some((bound) => bound !== null && !Number.isFinite(bound))) {
            setError(t('health:errors.thresholdInvalid'));
            return;
        }
        // Les plages sont comparees a des mesures metriques: on les convertit
        // avant l'envoi, jamais a la lecture.
        const [minValue, maxValue, minValue2, maxValue2] = bounds
            .slice(0, 4)
            .map((bound) => (bound === null ? null : toStorageValue(type, bound, unitSystem)));
        const [minPulse, maxPulse] = bounds.slice(4);

        setSavingType(type);
        setError('');
        try {
            await api.put('/api/vitals/thresholds', {
                type,
                min_value: minValue,
                max_value: maxValue,
                // Seule la tension porte une seconde valeur, la diastolique.
                min_value2: type === 'bp' ? minValue2 : null,
                max_value2: type === 'bp' ? maxValue2 : null,
                min_pulse: type === 'bp' ? minPulse : null,
                max_pulse: type === 'bp' ? maxPulse : null,
            });
            showToast({ title: t('health:toasts.thresholdSaved') });
            await refreshAll(false);
        } catch (err) {
            console.error('Failed to save vital threshold:', err);
            setError(err instanceof Error ? err.message : t('health:errors.threshold'));
        } finally {
            setSavingType(null);
        }
    };

    const isOutOfRange = (vital: Vital): boolean => {
        const range = rangeByType.get(vital.type);
        if (!range) return false;

        const value = toBound(vital.value);
        if (value !== null) {
            if (range.min !== null && value < range.min) return true;
            if (range.max !== null && value > range.max) return true;
        }
        if (vital.type !== 'bp') return false;

        const value2 = toBound(vital.value2);
        if (value2 !== null) {
            if (range.min2 !== null && value2 < range.min2) return true;
            if (range.max2 !== null && value2 > range.max2) return true;
        }
        const pulse = toBound(vital.pulse);
        if (pulse === null) return false;
        if (range.minP !== null && pulse < range.minP) return true;
        return range.maxP !== null && pulse > range.maxP;
    };

    const rangeLabel = (type: VitalType, min: number | null, max: number | null, pulse = false): string => {
        if (pulse) {
            const unit = t('health:pulseUnit');
            if (min !== null && max !== null) {
                return t('health:thresholds.between', { min: formatNumber(min), max: formatNumber(max), unit });
            }
            if (min !== null) return t('health:thresholds.minOnly', { min: formatNumber(min), unit });
            if (max !== null) return t('health:thresholds.maxOnly', { max: formatNumber(max), unit });
            return t('health:thresholds.none');
        }
        const unit = displayUnit(type, unitSystem);
        // Les bornes viennent du serveur en metrique: elles se lisent converties.
        const shown = (bound: number) =>
            formatNumber(toDisplayValue(type, bound, unitSystem), {
                maximumFractionDigits: decimalsFor(type, unitSystem),
            });
        if (min !== null && max !== null) {
            return t('health:thresholds.between', { min: shown(min), max: shown(max), unit });
        }
        if (min !== null) return t('health:thresholds.minOnly', { min: shown(min), unit });
        if (max !== null) return t('health:thresholds.maxOnly', { max: shown(max), unit });
        return t('health:thresholds.none');
    };

    // ─── Présentation ────────────────────────────────────────────────────────

    // L'unite enregistree par le serveur est ignoree a l'affichage: la valeur
    // est toujours metrique, c'est le cercle qui decide de sa lecture.
    const formatMeasure = (vital: Vital): string => {
        const value = Number(vital.value);
        const raw2 = vital.value2 !== null && vital.value2 !== undefined ? Number(vital.value2) : null;
        const value2 = raw2 !== null && Number.isFinite(raw2) ? raw2 : null;
        const text = formatVital(vital.type, value, value2, unitSystem, intlLocale());
        const pulse = toBound(vital.pulse);
        return vital.type === 'bp' && pulse !== null
            ? `${text} · ${t('health:pulseShort', { value: formatNumber(pulse) })}`
            : text;
    };

    // L'infobulle lit un point de la courbe, deja converti: on l'habille de son
    // unite sans le reconvertir, sinon la valeur serait doublement changee.
    const formatShown = (type: VitalType, shown: number): string => {
        const text = formatNumber(shown, { maximumFractionDigits: decimalsFor(type, unitSystem) });
        const unit = displayUnit(type, unitSystem);
        return type === 'pain' || type === 'mood' ? `${text}${unit}` : `${text} ${unit}`;
    };

    const relativeDate = (iso: string) =>
        formatDistanceToNow(new Date(iso), { addSuffix: true, locale: dateLocale() });

    const latestByType = useMemo(() => {
        const map = new Map<VitalType, Vital>();
        for (const vital of latest) map.set(vital.type, vital);
        return shownTypes.filter((type) => map.has(type)).map((type) => map.get(type)!);
    }, [latest, shownTypes]);

    // La serie est tracee dans l'unite affichee: l'echelle de l'axe suit donc
    // le systeme du cercle, sans conversion au moment du rendu.
    const chartData = useMemo(
        () =>
            series.map((vital) => {
                const raw2 = vital.value2 !== null && vital.value2 !== undefined ? Number(vital.value2) : null;
                return {
                    time: new Date(vital.measured_at).getTime(),
                    value: toDisplayValue(vital.type, Number(vital.value), unitSystem),
                    value2:
                        raw2 !== null && Number.isFinite(raw2)
                            ? toDisplayValue(vital.type, raw2, unitSystem)
                            : null,
                    pulse: toBound(vital.pulse),
                };
            }),
        [series, unitSystem]
    );

    // Tabelle: gleiche Auswahl wie der Verlauf, neueste Messung zuerst.
    const tableRows = useMemo(() => [...series].reverse(), [series]);

    const shownNumber = (type: VitalType, raw: number | string | null): string => {
        if (raw === null || raw === undefined) return '–';
        const value = Number(raw);
        if (!Number.isFinite(value)) return '–';
        return formatNumber(toDisplayValue(type, value, unitSystem), {
            maximumFractionDigits: decimalsFor(type, unitSystem),
        });
    };

    // La couleur seule ne suffit pas: le repere porte aussi un texte lu par les lecteurs d'ecran.
    const outOfRangeTag = (
        <span className="inline-flex items-center gap-1 rounded-pill border border-warning/20 bg-warning/10 px-2 py-0.5 text-micro font-medium text-warning">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {t('health:thresholds.outOfRange')}
            <span className="sr-only">{t('health:thresholds.outOfRangeLabel')}</span>
        </span>
    );

    const primaryColor = themeColor('--primary', '#3e6b54');
    const borderColor = themeColor('--border', '#e7e4df');
    const pulseColor = themeColor('--info', '#44617c');
    const hasPulse = chartType === 'bp' && chartData.some((row) => row.pulse !== null);

    // Jeder Messpunkt als Kreuz: auch ohne Farbe erkennbar, auch bei dicht liegenden Punkten.
    const crossDot = (color: string) => (props: { cx?: number | null; cy?: number | null; index?: number; dataKey?: unknown }) => {
        const { cx, cy, index } = props;
        const key = `cross-${String(props.dataKey)}-${index ?? 0}`;
        if (typeof cx !== 'number' || typeof cy !== 'number') return <g key={key} />;
        const s = 4;
        return (
            <path
                key={key}
                d={`M${cx - s},${cy - s}L${cx + s},${cy + s}M${cx - s},${cy + s}L${cx + s},${cy - s}`}
                stroke={color}
                strokeWidth={2}
                strokeLinecap="round"
                fill="none"
            />
        );
    };

    // Données de santé: accès refusé au rôle voisin (matrice de la SPEC).
    if (myRole === 'neighbor') {
        return (
            <div className="mx-auto max-w-3xl">
                <EmptyState
                    icon={<Activity className="h-10 w-10" />}
                    title={t('health:restricted.title')}
                    description={t('health:restricted.description')}
                />
            </div>
        );
    }

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center min-h-[50vh]">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="text-muted-foreground font-medium animate-pulse">{t('health:loading')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-h1 mb-1">{t('health:title')}</h1>
                    <p className="text-muted-foreground text-body">{t('health:subtitle')}</p>
                </div>
                {canWriteJournal && (
                    <Button onClick={openDialog}>
                        <Plus className="mr-2 h-4 w-4" />
                        {t('health:addMeasure')}
                    </Button>
                )}
            </div>

            {/* Dernières valeurs par type */}
            {latestByType.length === 0 ? (
                <EmptyState
                    icon={<Activity className="h-10 w-10" />}
                    title={t('health:latest.emptyTitle')}
                    description={t('health:latest.emptyDescription')}
                    actionLabel={canWriteJournal ? t('health:latest.addFirst') : undefined}
                    onAction={canWriteJournal ? openDialog : undefined}
                />
            ) : (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                    {latestByType.map((vital) => {
                        const Icon = VITAL_ICONS[vital.type];
                        const active = chartType === vital.type;
                        const outOfRange = isOutOfRange(vital);
                        return (
                            <button
                                key={vital.type}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setChartType(vital.type)}
                                className={cn(
                                    'min-h-[44px] rounded-card border bg-card p-4 text-left shadow-surface transition-colors',
                                    outOfRange
                                        ? 'border-warning/40'
                                        : active
                                          ? 'border-primary/40'
                                          : 'border-border hover:border-border-strong'
                                )}
                            >
                                <div className="flex items-center gap-2 text-muted-foreground">
                                    <Icon className="h-4 w-4" />
                                    <span className="text-micro font-medium">{t(`health:vitalTypes.${vital.type}`)}</span>
                                </div>
                                <p
                                    className={cn(
                                        'mt-2 font-serif text-2xl tracking-tight',
                                        outOfRange ? 'text-warning' : 'text-foreground'
                                    )}
                                >
                                    {formatMeasure(vital)}
                                </p>
                                {outOfRange ? <p className="mt-1.5">{outOfRangeTag}</p> : null}
                                <p className="mt-1 text-micro text-muted-foreground">{relativeDate(vital.measured_at)}</p>
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Messwerte als Tabelle, folgt der Auswahl im Verlauf */}
            <ChartCard
                title={t('health:table.title')}
            >
                {tableRows.length === 0 ? (
                    <p className="py-6 text-center text-body text-muted-foreground">{t('health:chart.empty')}</p>
                ) : (
                    <>
                        <div className="max-h-[480px] overflow-auto rounded-card border border-border-strong">
                            <table className="w-full border-collapse text-left text-body">
                                <caption className="sr-only">
                                    {t('health:table.caption', { type: t(`health:vitalTypes.${chartType}`) })}
                                </caption>
                                <thead className="sticky top-0 z-10 bg-muted">
                                    <tr>
                                        <th scope="col" className="whitespace-nowrap px-3 py-3 text-caption font-semibold text-foreground">
                                            {t('health:table.date')}
                                        </th>
                                        <th scope="col" className="whitespace-nowrap px-3 py-3 text-caption font-semibold text-foreground">
                                            {t('health:table.time')}
                                        </th>
                                        {chartType === 'bp' ? (
                                            <>
                                                <th scope="col" className="whitespace-nowrap px-3 py-3 text-right text-caption font-semibold text-foreground">
                                                    {t('health:chart.systolic')} ({displayUnit('bp', unitSystem)})
                                                </th>
                                                <th scope="col" className="whitespace-nowrap px-3 py-3 text-right text-caption font-semibold text-foreground">
                                                    {t('health:chart.diastolic')} ({displayUnit('bp', unitSystem)})
                                                </th>
                                                <th scope="col" className="whitespace-nowrap px-3 py-3 text-right text-caption font-semibold text-foreground">
                                                    {t('health:chart.pulse')} ({t('health:pulseUnit')})
                                                </th>
                                            </>
                                        ) : (
                                            <th scope="col" className="whitespace-nowrap px-3 py-3 text-right text-caption font-semibold text-foreground">
                                                {t('health:table.value')} ({displayUnit(chartType, unitSystem)})
                                            </th>
                                        )}
                                        <th scope="col" className="px-3 py-3 text-caption font-semibold text-foreground">
                                            {t('health:table.notes')}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {tableRows.map((vital) => {
                                        const when = new Date(vital.measured_at);
                                        const outOfRange = isOutOfRange(vital);
                                        return (
                                            <tr
                                                key={vital.id}
                                                className={cn('border-t border-border', outOfRange && 'bg-warning/5')}
                                            >
                                                <td className="whitespace-nowrap px-3 py-3">
                                                    {when.toLocaleDateString(intlLocale(), {
                                                        weekday: 'short',
                                                        day: 'numeric',
                                                        month: 'short',
                                                        year: 'numeric',
                                                    })}
                                                </td>
                                                <td className="whitespace-nowrap px-3 py-3">
                                                    {when.toLocaleTimeString(intlLocale(), {
                                                        hour: '2-digit',
                                                        minute: '2-digit',
                                                    })}
                                                </td>
                                                <td
                                                    className={cn(
                                                        'whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums',
                                                        outOfRange ? 'text-warning' : 'text-foreground'
                                                    )}
                                                >
                                                    {shownNumber(vital.type, vital.value)}
                                                </td>
                                                {chartType === 'bp' ? (
                                                    <td
                                                        className={cn(
                                                            'whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums',
                                                            outOfRange ? 'text-warning' : 'text-foreground'
                                                        )}
                                                    >
                                                        {shownNumber(vital.type, vital.value2)}
                                                    </td>
                                                ) : null}
                                                {chartType === 'bp' ? (
                                                    <td
                                                        className={cn(
                                                            'whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums',
                                                            outOfRange ? 'text-warning' : 'text-foreground'
                                                        )}
                                                    >
                                                        {toBound(vital.pulse) === null ? '–' : formatNumber(toBound(vital.pulse)!)}
                                                    </td>
                                                ) : null}
                                                <td className="min-w-[10rem] px-3 py-3 text-muted-foreground">
                                                    <span className="flex flex-wrap items-center gap-2">
                                                        {outOfRange ? outOfRangeTag : null}
                                                        {vital.notes ? <span>{vital.notes}</span> : null}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </ChartCard>

            {/* Courbe dans le temps */}
            <ChartCard
                title={t('health:chart.title')}
                subtitle={t('health:chart.subtitle')}
                action={
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <Select
                            value={chartType}
                            onValueChange={(value) => setChartType(value as VitalType)}
                            options={shownTypes.map((type) => ({
                                value: type,
                                label: t(`health:vitalTypes.${type}`),
                            }))}
                            className="w-40"
                        />
                        <div className="flex gap-1" role="group" aria-label={t('health:chart.subtitle')}>
                            {PERIODS.map(({ key }) => (
                                <button
                                    key={key}
                                    type="button"
                                    aria-pressed={period === key}
                                    onClick={() => setPeriod(key)}
                                    className={cn(
                                        'min-h-[36px] rounded-pill border px-3 text-micro font-medium transition-colors',
                                        period === key
                                            ? 'border-primary/30 bg-primary-soft text-primary'
                                            : 'border-border bg-card text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    {t(`health:chart.periods.${key}`)}
                                </button>
                            ))}
                        </div>
                    </div>
                }
            >
                {chartData.length === 0 ? (
                    <p className="py-10 text-center text-caption text-muted-foreground">{t('health:chart.empty')}</p>
                ) : (
                    <div className="h-[280px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                                <CartesianGrid stroke={borderColor} strokeDasharray="3 3" vertical={false} />
                                <XAxis
                                    dataKey="time"
                                    type="number"
                                    scale="time"
                                    domain={['dataMin', 'dataMax']}
                                    tickFormatter={(value) =>
                                        format(new Date(Number(value)), 'd MMM', { locale: dateLocale() })
                                    }
                                    tick={{ fontSize: 11 }}
                                    stroke={borderColor}
                                />
                                <YAxis
                                    tick={{ fontSize: 11 }}
                                    stroke={borderColor}
                                    domain={['auto', 'auto']}
                                    tickFormatter={(value) =>
                                        formatNumber(Number(value), {
                                            maximumFractionDigits: decimalsFor(chartType, unitSystem),
                                        })
                                    }
                                />
                                <Tooltip
                                    labelFormatter={(value) =>
                                        format(new Date(Number(value)), 'd MMM yyyy HH:mm', { locale: dateLocale() })
                                    }
                                    formatter={(value, name) =>
                                        name === t('health:chart.pulse')
                                            ? `${formatNumber(Number(value))} ${t('health:pulseUnit')}`
                                            : formatShown(chartType, Number(value))
                                    }
                                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                                />
                                {chartType === 'bp' && <Legend wrapperStyle={{ fontSize: 12 }} />}
                                <Line
                                    type="linear"
                                    dataKey="value"
                                    name={chartType === 'bp' ? t('health:chart.systolic') : t(`health:vitalTypes.${chartType}`)}
                                    stroke={primaryColor}
                                    strokeWidth={2}
                                    dot={crossDot(primaryColor)}
                                    activeDot={{ r: 5 }}
                                    connectNulls
                                    isAnimationActive={false}
                                />
                                {chartType === 'bp' && (
                                    <Line
                                        type="linear"
                                        dataKey="value2"
                                        name={t('health:chart.diastolic')}
                                        stroke={primaryColor}
                                        strokeWidth={2}
                                        strokeDasharray="5 4"
                                        dot={crossDot(primaryColor)}
                                        activeDot={{ r: 5 }}
                                        connectNulls
                                        isAnimationActive={false}
                                    />
                                )}
                                {hasPulse && (
                                    <Line
                                        type="linear"
                                        dataKey="pulse"
                                        name={t('health:chart.pulse')}
                                        stroke={pulseColor}
                                        strokeWidth={2}
                                        strokeDasharray="2 4"
                                        dot={crossDot(pulseColor)}
                                        activeDot={{ r: 5 }}
                                        connectNulls
                                        isAnimationActive={false}
                                    />
                                )}
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </ChartCard>

            {/* Mesures récentes */}
            <section>
                <h2 className="mb-2 text-caption font-semibold text-muted-foreground">{t('health:recent.title')}</h2>
                {recent.length === 0 ? (
                    <p className="rounded-card border border-dashed border-border bg-card px-4 py-6 text-center text-caption text-muted-foreground">
                        {t('health:recent.empty')}
                    </p>
                ) : (
                    <div className="space-y-2">
                        {recent.map((vital) => {
                            const Icon = VITAL_ICONS[vital.type];
                            const outOfRange = isOutOfRange(vital);
                            return (
                                <ListRow
                                    key={vital.id}
                                    className={outOfRange ? 'border-warning/40 bg-warning/5' : undefined}
                                    leading={
                                        <div
                                            className={cn(
                                                'flex h-9 w-9 items-center justify-center rounded-full',
                                                outOfRange
                                                    ? 'bg-warning/10 text-warning'
                                                    : 'bg-primary-soft text-primary'
                                            )}
                                        >
                                            <Icon className="h-4 w-4" />
                                        </div>
                                    }
                                    title={
                                        <span className="flex flex-wrap items-center gap-2">
                                            <span className="truncate">
                                                {`${t(`health:vitalTypes.${vital.type}`)}: ${formatMeasure(vital)}`}
                                            </span>
                                            {outOfRange ? outOfRangeTag : null}
                                        </span>
                                    }
                                    meta={
                                        <>
                                            {format(new Date(vital.measured_at), 'd MMM yyyy HH:mm', { locale: dateLocale() })}
                                            {vital.notes ? ` · ${vital.notes}` : ''}
                                        </>
                                    }
                                    trailing={
                                        canManage(vital) ? (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t('health:actions.delete')}
                                                onClick={() => void handleDelete(vital)}
                                            >
                                                <Trash2 className="h-4 w-4 text-danger" />
                                            </Button>
                                        ) : undefined
                                    }
                                />
                            );
                        })}
                    </div>
                )}
            </section>

            {/* Plages normales par constante */}
            <section>
                <h2 className="mb-2 text-caption font-semibold text-muted-foreground">
                    {t('health:thresholds.title')}
                </h2>
                <p className="mb-3 text-caption text-muted-foreground">
                    {canWriteContent ? t('health:thresholds.description') : t('health:thresholds.readOnly')}
                </p>
                <div className="space-y-2">
                    {shownTypes.map((type) => {
                        const Icon = VITAL_ICONS[type];
                        const range = rangeByType.get(type) ?? null;
                        const unit = displayUnit(type, unitSystem);
                        const draft = drafts[type];
                        return (
                            <div
                                key={type}
                                className="rounded-card border border-border bg-card p-4 shadow-surface"
                            >
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft text-primary">
                                        <Icon className="h-4 w-4" />
                                    </span>
                                    <span className="text-body font-medium">{t(`health:vitalTypes.${type}`)}</span>
                                    <span className="text-micro text-muted-foreground">{unit}</span>
                                </div>
                                <div className="mt-2 space-y-0.5 text-caption text-muted-foreground">
                                    {type === 'bp' ? (
                                        <>
                                            <p>
                                                {t('health:thresholds.systolicPrefix')}{' '}
                                                {rangeLabel(type, range?.min ?? null, range?.max ?? null)}
                                            </p>
                                            <p>
                                                {t('health:thresholds.diastolicPrefix')}{' '}
                                                {rangeLabel(type, range?.min2 ?? null, range?.max2 ?? null)}
                                            </p>
                                            <p>
                                                {t('health:thresholds.pulsePrefix')}{' '}
                                                {rangeLabel(type, range?.minP ?? null, range?.maxP ?? null, true)}
                                            </p>
                                        </>
                                    ) : (
                                        <p>{rangeLabel(type, range?.min ?? null, range?.max ?? null)}</p>
                                    )}
                                </div>
                                {canWriteContent && (
                                    <form
                                        onSubmit={(event) => void handleSaveThreshold(event, type)}
                                        className="mt-3 space-y-3"
                                    >
                                        <div className="grid grid-cols-2 gap-3">
                                            <Input
                                                id={`threshold-${type}-min`}
                                                label={
                                                    type === 'bp'
                                                        ? t('health:thresholds.minSystolicLabel')
                                                        : t('health:thresholds.minLabel')
                                                }
                                                type="text"
                                                inputMode="decimal"
                                                value={draft.min}
                                                onChange={(e) => updateDraft(type, 'min', e.target.value)}
                                            />
                                            <Input
                                                id={`threshold-${type}-max`}
                                                label={
                                                    type === 'bp'
                                                        ? t('health:thresholds.maxSystolicLabel')
                                                        : t('health:thresholds.maxLabel')
                                                }
                                                type="text"
                                                inputMode="decimal"
                                                value={draft.max}
                                                onChange={(e) => updateDraft(type, 'max', e.target.value)}
                                            />
                                        </div>
                                        {type === 'bp' && (
                                            <div className="grid grid-cols-2 gap-3">
                                                <Input
                                                    id={`threshold-${type}-min2`}
                                                    label={t('health:thresholds.minDiastolicLabel')}
                                                    type="text"
                                                    inputMode="decimal"
                                                    value={draft.min2}
                                                    onChange={(e) => updateDraft(type, 'min2', e.target.value)}
                                                />
                                                <Input
                                                    id={`threshold-${type}-max2`}
                                                    label={t('health:thresholds.maxDiastolicLabel')}
                                                    type="text"
                                                    inputMode="decimal"
                                                    value={draft.max2}
                                                    onChange={(e) => updateDraft(type, 'max2', e.target.value)}
                                                />
                                            </div>
                                        )}
                                        {type === 'bp' && (
                                            <div className="grid grid-cols-2 gap-3">
                                                <Input
                                                    id={`threshold-${type}-minP`}
                                                    label={t('health:thresholds.minPulseLabel')}
                                                    type="text"
                                                    inputMode="numeric"
                                                    value={draft.minP}
                                                    onChange={(e) => updateDraft(type, 'minP', e.target.value)}
                                                />
                                                <Input
                                                    id={`threshold-${type}-maxP`}
                                                    label={t('health:thresholds.maxPulseLabel')}
                                                    type="text"
                                                    inputMode="numeric"
                                                    value={draft.maxP}
                                                    onChange={(e) => updateDraft(type, 'maxP', e.target.value)}
                                                />
                                            </div>
                                        )}
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <p className="text-micro text-muted-foreground">
                                                {t('health:thresholds.unitHint', { unit })}{' '}
                                                {t('health:thresholds.clearHint')}
                                            </p>
                                            <Button
                                                type="submit"
                                                variant="secondary"
                                                size="sm"
                                                disabled={savingType === type}
                                            >
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

            {/* Saisie rapide */}
            <Dialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                title={t('health:form.title')}
                description={t('health:form.description')}
            >
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <span className="mb-1.5 block text-caption font-medium text-foreground">
                            {t('health:form.typeLabel')}
                        </span>
                        <Select
                            value={formType}
                            onValueChange={(value) => setFormType(value as VitalType)}
                            options={shownTypes.map((type) => ({
                                value: type,
                                label: t(`health:vitalTypes.${type}`),
                            }))}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <Input
                            label={`${
                                formType === 'bp' ? t('health:form.systolicLabel') : t('health:form.valueLabel')
                            } (${displayUnit(formType, unitSystem)})`}
                            type="text"
                            inputMode="decimal"
                            value={formValue}
                            onChange={(e) => setFormValue(e.target.value)}
                            required
                        />
                        {formType === 'bp' && (
                            <Input
                                label={`${t('health:form.diastolicLabel')} (${displayUnit(formType, unitSystem)})`}
                                type="text"
                                inputMode="decimal"
                                value={formValue2}
                                onChange={(e) => setFormValue2(e.target.value)}
                                required
                            />
                        )}
                    </div>
                    {formType === 'bp' && (
                        <Input
                            label={`${t('health:form.pulseLabel')} (${t('health:pulseUnit')})`}
                            type="text"
                            inputMode="numeric"
                            value={formPulse}
                            onChange={(e) => setFormPulse(e.target.value)}
                        />
                    )}
                    <Input
                        label={t('health:form.dateLabel')}
                        type="datetime-local"
                        value={formMeasuredAt}
                        onChange={(e) => setFormMeasuredAt(e.target.value)}
                    />
                    <Textarea
                        label={t('health:form.notesLabel')}
                        value={formNotes}
                        onChange={(e) => setFormNotes(e.target.value)}
                        rows={2}
                    />
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {t('common:actions.save')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Health;
