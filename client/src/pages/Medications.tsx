import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO, startOfDay, differenceInCalendarDays } from 'date-fns';
import {
    Plus,
    Pill,
    Check,
    CheckCheck,
    RotateCcw,
    Edit2,
    Trash2,
    Archive,
    ArchiveRestore,
    FileText,
    Clock,
    PlusCircle,
    Package,
} from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { DEFAULT_UNIT_BY_FORM, MEDICATION_FORMS, MEDICATION_UNITS, formatAmount, safeQuantity, unitFor } from '../lib/medications';
import { useCircle } from '../contexts/CircleContext';
import { circleWeekStart, orderedIsoDays, sortIsoDays } from '../lib/weekStart';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { dateLocale, formatClock, intlLocale } from '../i18n/format';
import {
    Card,
    CardContent,
    Button,
    Dialog,
    Input,
    Select,
    Textarea,
    DatePicker,
    Badge,
    Tabs,
} from '../components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

type IntakeStatus = 'pending' | 'taken' | 'skipped' | 'missed';
type Moment = 'morning' | 'noon' | 'evening' | 'night';

type WithFood = 'with' | 'without' | 'any';
type IntakeSource = 'caregiver' | 'kiosk' | 'phone' | 'link' | 'self';

interface MedicationSchedule {
    id?: string;
    time_of_day: string;
    days_of_week: number[];
    label: string | null;
    /** Combien prendre a cet horaire (2 = "2 comprimes") */
    quantity: number;
    /** Unite ; null = deduite de la forme */
    unit: string | null;
    /** false = nur Tageszeit, Uhrzeit ist ein Standardwert für Erinnerungen */
    time_fixed?: boolean;
}

interface Medication {
    id: string;
    name: string;
    dosage: string | null;
    form: string | null;
    instructions: string | null;
    photo_url: string | null;
    prescriber: string | null;
    start_date: string | null;
    end_date: string | null;
    active: boolean;
    /** Si besoin : pas d'horaire, prises ponctuelles */
    prn: boolean;
    with_food: WithFood | null;
    reason: string | null;
    appearance: string | null;
    /** Wirkstoff */
    active_ingredient: string | null;
    /** Stock restant, dans l'unite d'une prise ; null = stock non suivi */
    stock_quantity: number | null;
    /** Sous ce seuil le stock est signale comme bas ; null = pas d'alerte */
    stock_alert_threshold: number | null;
    stock_updated_at: string | null;
    schedules: MedicationSchedule[];
}

interface Intake {
    id: string;
    medication_id: string;
    schedule_id: string | null;
    due_at: string;
    status: IntakeStatus;
    confirmed_at: string | null;
    confirmed_source: IntakeSource | null;
    quantity: number | string | null;
    unit: string | null;
    medication_name: string;
    medication_dosage: string | null;
    form: string | null;
    photo_url: string | null;
    prn: boolean;
    schedule_label: string | null;
    time_fixed?: boolean;
    active_ingredient?: string | null;
    instructions: string | null;
    with_food: WithFood | null;
    appearance: string | null;
    /** Nur fuer die betreute Person: Restzeit fuer "Rueckgaengig" in ms, vom Server berechnet. */
    undo_ms_left?: number;
    /** Lokal: bis wann die Taste "Rueckgaengig" zu sehen ist (Date.now()-Zeit). */
    undo_until?: number;
}

interface Prescription {
    id: string;
    title: string;
    prescribed_by: string | null;
    issued_date: string | null;
    renewal_date: string | null;
    reminder_days: number;
    notes: string | null;
}

interface ContactOption {
    id: string;
    name: string;
    organization: string | null;
}

interface ScheduleRow {
    time_of_day: string;
    days_of_week: number[];
    label: string;
    /** Saisie libre ("1", "2", "0.5"), validee a l'envoi */
    quantity: string;
    /** '' = unite deduite de la forme */
    unit: string;
    /** false = nur Tageszeit (Morgens, Mittags ...) */
    time_fixed: boolean;
}

// ─── Constants and helpers ────────────────────────────────────────────────────

/** Reiter "Rezepte" ausgeblendet; auf true setzen, um ihn wieder zu zeigen. */
const SHOW_PRESCRIPTIONS: boolean = false;

/** Vorgeschlagene Uhrzeit je Tageszeit (passt zu momentOf); im Formular änderbar. */
const MOMENT_TIMES: Record<Moment, string> = {
    morning: '08:00',
    noon: '12:00',
    evening: '18:00',
    night: '22:00',
};

const MOMENTS: Moment[] = ['morning', 'noon', 'evening', 'night'];
const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7];
const FORM_VALUES = [...MEDICATION_FORMS];
const UNIT_VALUES = [...MEDICATION_UNITS];
const WITH_FOOD_VALUES: WithFood[] = ['with', 'without', 'any'];
const parseQuantity = (raw: string): number | null => {
    const value = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0 || value > 99) return null;
    return Math.round(value * 100) / 100;
};
// Memes bornes que le serveur pour le stock.
const MAX_STOCK = 100000;
/** Saisie libre du stock : vide = valeur non suivie, `undefined` = saisie refusee. */
const parseStockValue = (raw: string): number | null | undefined => {
    const text = raw.trim();
    if (text === '') return null;
    const value = Number(text.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > MAX_STOCK) return undefined;
    return Math.round(value * 100) / 100;
};

// PostgreSQL renvoie ses colonnes NUMERIC en texte : on repasse par Number avant
// toute comparaison, sinon "9" passerait pour plus grand que "10".
const stockNumber = (value: number | null | undefined): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

/** Unite du stock : celle des horaires, c'est a dire l'unite d'une prise. */
const stockUnitOf = (med: Medication): string | null => med.schedules[0]?.unit ?? null;

// Un horaire qui ne tombe pas tous les jours ne consomme pas une dose par jour :
// on le compte au prorata de ses jours pour rester juste sur les semaines partielles.
const dailyDoseTotal = (med: Medication): number =>
    med.schedules.reduce(
        (total, schedule) =>
            total + safeQuantity(schedule.quantity) * (schedule.days_of_week.length / 7),
        0
    );

/** Jours couverts par le stock restant, null quand le calcul n'aurait pas de sens. */
const stockDaysLeft = (med: Medication): number | null => {
    const remaining = stockNumber(med.stock_quantity);
    if (remaining === null || remaining <= 0 || med.prn || med.schedules.length === 0) return null;
    const perDay = dailyDoseTotal(med);
    if (perDay <= 0) return null;
    return Math.floor(remaining / perDay);
};

/** Wie im Server (stockAlerts.ts): Erinnerung, sobald der Vorrat laut Plan nur noch so viele Tage reicht. */
const STOCK_REMINDER_DAYS = 7;

/** Vorrat geht zur Neige: leer, oder reicht laut Plan hoechstens STOCK_REMINDER_DAYS Tage. */
const isStockLow = (med: Medication): boolean => {
    const remaining = stockNumber(med.stock_quantity);
    if (remaining === null) return false;
    if (remaining <= 0) return true;
    if (med.prn) return false;
    const perDay = dailyDoseTotal(med);
    return perDay > 0 && remaining <= STOCK_REMINDER_DAYS * perDay;
};

// Same limit as the server: the raw data URL string must stay under 1.5 MB.
const MAX_PHOTO_CHARS = 1.5 * 1024 * 1024;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const momentOf = (hour: number): Moment => {
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 17) return 'noon';
    if (hour >= 17 && hour < 22) return 'evening';
    return 'night';
};

/** Resize and re-encode an image on a canvas until the data URL fits the server limit. */
const compressImageToDataUrl = async (file: File): Promise<string> => {
    const sourceUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('read-failed'));
        reader.readAsDataURL(file);
    });

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('decode-failed'));
        img.src = sourceUrl;
    });

    let maxDimension = 1024;
    let quality = 0.85;
    for (let attempt = 0; attempt < 6; attempt++) {
        const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('canvas-unavailable');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const output = canvas.toDataURL('image/jpeg', quality);
        if (output.length <= MAX_PHOTO_CHARS) return output;
        quality = Math.max(0.4, quality - 0.15);
        maxDimension = Math.round(maxDimension * 0.75);
    }
    throw new Error('photo-too-large');
};

const emptyScheduleRow = (): ScheduleRow => ({
    time_of_day: '08:00',
    days_of_week: [...ISO_DAYS],
    label: '',
    quantity: '1',
    unit: '',
    time_fixed: false,
});

const emptyMedForm = () => ({
    name: '',
    dosage: '',
    form: '',
    instructions: '',
    prescriber: '',
    start_date: '',
    end_date: '',
    photo_url: '',
    prn: false,
    with_food: '' as '' | WithFood,
    reason: '',
    appearance: '',
    active_ingredient: '',
    schedules: [emptyScheduleRow()],
});

const emptyRxForm = () => ({
    title: '',
    prescribed_by: '',
    issued_date: '',
    renewal_date: '',
    reminder_days: '7',
    notes: '',
});

// ─── Page ─────────────────────────────────────────────────────────────────────

const Medications: React.FC = () => {
    const { t } = useTranslation(['medications', 'common']);
    const { activeCircle, canWriteContent, canWriteJournal, myRole } = useCircle();

    const [intakes, setIntakes] = useState<Intake[]>([]);
    const [medications, setMedications] = useState<Medication[]>([]);
    const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
    const [showArchived, setShowArchived] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Medication dialog
    const [medDialogOpen, setMedDialogOpen] = useState(false);
    const [editingMed, setEditingMed] = useState<Medication | null>(null);
    const [medForm, setMedForm] = useState(emptyMedForm());
    const [medFormError, setMedFormError] = useState('');
    const [photoBusy, setPhotoBusy] = useState(false);
    const [savingMed, setSavingMed] = useState(false);
    const photoInputRef = useRef<HTMLInputElement>(null);

    // Stock dialog
    const [stockMed, setStockMed] = useState<Medication | null>(null);
    const [stockForm, setStockForm] = useState({ quantity: '' });
    const [stockFormError, setStockFormError] = useState('');
    const [savingStock, setSavingStock] = useState(false);

    // Prescription dialog
    const [rxDialogOpen, setRxDialogOpen] = useState(false);
    const [editingRx, setEditingRx] = useState<Prescription | null>(null);
    const [rxForm, setRxForm] = useState(emptyRxForm());
    const [rxFormError, setRxFormError] = useState('');
    const [savingRx, setSavingRx] = useState(false);

    // Kontakte als Vorschläge für "Verordnet von" (freie Eingabe bleibt möglich)
    const [contacts, setContacts] = useState<ContactOption[]>([]);

    const dayLetters = t('medications:dayLetters', { returnObjects: true }) as unknown as string[];
    const dayNames = t('common:days', { returnObjects: true }) as unknown as string[];
    const daysShort = t('common:daysShort', { returnObjects: true }) as unknown as string[];
    // Ordre d'affichage des jours (reglage du cercle) ; les jours restent stockes en ISO.
    const weekStart = circleWeekStart(activeCircle);

    const formOptions = FORM_VALUES.map((value) => ({
        value,
        label: t(`medications:forms.${value}`),
    }));
    const formLabel = (value: string) =>
        t(`medications:forms.${value}`, { defaultValue: value });

    const unitOptions = UNIT_VALUES.map((value) => ({
        value,
        label: t(`medications:units.${value}`, { count: 2 }),
    }));
    const withFoodOptions = WITH_FOOD_VALUES.map((value) => ({
        value,
        label: t(`medications:withFood.${value}`),
    }));

    /** "2 comprimés", "5 ml", "1 gélule" : la quantite a prendre, en mots. */
    const amountLabel = (quantity: number | string | null | undefined, unit: string | null | undefined, form: string | null | undefined) =>
        formatAmount(t, quantity, unit, form);

    const sourceLabel = (source: IntakeSource | null) =>
        source ? t(`medications:today.source.${source}`) : null;

    const fmtDate = (value: string) =>
        format(parseISO(value.slice(0, 10)), 'PP', { locale: dateLocale() });

    // ─── Loading ──────────────────────────────────────────────────────────────

    const loadIntakes = async () => {
        try {
            const response = await api.get<{ success: boolean; data: Intake[] }>(
                '/api/medications/intakes'
            );
            if (response.success) {
                const loadedAt = Date.now();
                setIntakes(response.data.map((intake) => ({
                    ...intake,
                    undo_until: intake.undo_ms_left && intake.undo_ms_left > 0 ? loadedAt + intake.undo_ms_left : undefined,
                })));
            }
        } catch (err) {
            console.error('Failed to load intakes:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.loadIntakes'));
        }
    };

    // Betreute Person liest nur "Heute" wie in der Tablet-Ansicht; Plan, Vorrat und Rezepte sperrt der Server.
    const readsTodayOnly = myRole === 'recipient';

    const loadMedications = async () => {
        if (readsTodayOnly) return;
        try {
            const response = await api.get<{ success: boolean; data: Medication[] }>(
                `/api/medications?active=${showArchived ? 'all' : 'true'}`
            );
            if (response.success) setMedications(response.data);
        } catch (err) {
            console.error('Failed to load medications:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.load'));
        }
    };

    const loadPrescriptions = async () => {
        if (readsTodayOnly) return;
        try {
            const response = await api.get<{ success: boolean; data: Prescription[] }>(
                '/api/medications/prescriptions'
            );
            if (response.success) setPrescriptions(response.data);
        } catch (err) {
            console.error('Failed to load prescriptions:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.loadPrescriptions'));
        }
    };

    useEffect(() => {
        if (!activeCircle) {
            setLoading(false);
            return;
        }
        setLoading(true);
        setError('');
        void Promise.all([loadIntakes(), loadPrescriptions()]).finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    useEffect(() => {
        if (!activeCircle || readsTodayOnly) return;
        // Nur Vorschläge: Fehler hier stören die Seite nicht.
        api.get<{ success: boolean; data: ContactOption[] }>('/api/contacts')
            .then((response) => {
                if (response.success) setContacts(response.data);
            })
            .catch((err) => console.error('Failed to load contacts:', err));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    useEffect(() => {
        if (!activeCircle) return;
        void loadMedications();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id, showArchived]);

    useWebSocketUpdates('medications', () => {
        void loadMedications();
        void loadPrescriptions();
        void loadIntakes();
    });
    useWebSocketUpdates('intakes', () => {
        void loadIntakes();
    });

    // ─── Today ────────────────────────────────────────────────────────────────

    const intakesByMoment = useMemo(() => {
        const groups: Record<Moment, Intake[]> = { morning: [], noon: [], evening: [], night: [] };
        for (const intake of intakes) {
            groups[momentOf(parseISO(intake.due_at).getHours())].push(intake);
        }
        return groups;
    }, [intakes]);

    const setIntakeStatus = async (intake: Intake, status: 'taken' | 'skipped' | 'pending') => {
        setError('');
        try {
            await api.put(`/api/medications/intakes/${intake.id}`, { status });
            await loadIntakes();
        } catch (err) {
            console.error('Failed to update intake:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.saveIntake'));
        }
    };

    // "Si besoin" medications have no schedule: a dose is logged when it happens.
    const [prnBusy, setPrnBusy] = useState<string | null>(null);
    const logPrnIntake = async (med: Medication) => {
        setError('');
        setPrnBusy(med.id);
        try {
            await api.post(`/api/medications/${med.id}/intakes`, {});
            await loadIntakes();
        } catch (err) {
            console.error('Failed to log intake:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.logPrn'));
        } finally {
            setPrnBusy(null);
        }
    };
    const prnMedications = medications.filter((m) => m.active && m.prn);
    const prnIntakesToday = (medId: string) =>
        intakes.filter((i) => i.medication_id === medId && i.status === 'taken').length;

    const isDone = (intake: Intake) => intake.status === 'taken' || intake.status === 'skipped';

    // Bestaetigen duerfen alle mit Schreibrecht im Tagebuch und die betreute Person
    // selbst (nur "Genommen", kein Auslassen oder Zuruecksetzen, siehe server/src/middleware/circle.ts).
    const isRecipient = myRole === 'recipient';
    const canConfirmIntakes = canWriteJournal || isRecipient;

    // Rueckgaengig fuer die betreute Person: die Taste verschwindet, sobald die
    // vom Server genannte Zeit um ist (der Server prueft beim Zuruecksetzen erneut).
    const [clock, setClock] = useState(() => Date.now());
    useEffect(() => {
        const next = intakes.reduce(
            (min, intake) => (intake.undo_until && intake.undo_until > clock ? Math.min(min, intake.undo_until) : min),
            Infinity
        );
        if (next === Infinity) return;
        const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, next - Date.now()) + 50);
        return () => window.clearTimeout(timer);
    }, [intakes, clock]);
    const canUndoOwn = (intake: Intake) =>
        isRecipient && intake.status === 'taken' && Boolean(intake.undo_until && intake.undo_until > clock);

    // "Morgens alle genommen": Rueckfrage, dann alle offenen Einnahmen des Blocks bestaetigen.
    const [confirmAllMoment, setConfirmAllMoment] = useState<Moment | null>(null);
    const [confirmAllBusy, setConfirmAllBusy] = useState(false);
    const openIntakesOf = (moment: Moment) => intakesByMoment[moment].filter((i) => !isDone(i));
    const confirmAllIntakes = async () => {
        if (!confirmAllMoment) return;
        const ids = openIntakesOf(confirmAllMoment).map((i) => i.id);
        setError('');
        setConfirmAllBusy(true);
        try {
            if (ids.length > 0) await api.post('/api/medications/intakes/confirm', { intake_ids: ids });
            setConfirmAllMoment(null);
            await loadIntakes();
        } catch (err) {
            console.error('Failed to confirm intakes:', err);
            setConfirmAllMoment(null);
            setError(err instanceof Error ? err.message : t('medications:errors.confirmAll'));
        } finally {
            setConfirmAllBusy(false);
        }
    };

    // Offene Einnahmen zuerst, erledigte blass darunter; jeweils nach Uhrzeit.
    const sortForToday = (group: Intake[]) =>
        [...group].sort((x, y) => {
            const doneDiff = Number(isDone(x)) - Number(isDone(y));
            return doneDiff !== 0 ? doneDiff : x.due_at.localeCompare(y.due_at);
        });

    /** Hinweise in einfachen Worten: Mahlzeiten, Aussehen, Hinweis. */
    const intakeDetails = (intake: Intake) =>
        [
            intake.with_food && intake.with_food !== 'any' ? t(`medications:withFood.${intake.with_food}`) : null,
            intake.appearance,
            intake.instructions,
        ].filter(Boolean) as string[];

    const renderIntakeState = (intake: Intake) => {
        if (intake.status === 'taken') {
            return (
                <p className="flex items-center gap-2 text-body font-semibold text-success">
                    <Check className="h-6 w-6 flex-shrink-0" aria-hidden="true" />
                    {intake.confirmed_at
                        ? t('medications:today.status.takenAt', { time: formatClock(intake.confirmed_at) })
                        : t('medications:today.status.taken')}
                </p>
            );
        }
        if (intake.status === 'skipped') {
            return <p className="text-body font-semibold text-foreground">{t('medications:today.status.skipped')}</p>;
        }
        if (intake.status === 'missed') {
            return <p className="text-body font-semibold text-danger">{t('medications:today.status.missed')}</p>;
        }
        return null;
    };

    const renderIntakeActions = (intake: Intake) => {
        if (!canConfirmIntakes) return null;
        if (isRecipient) {
            if (canUndoOwn(intake)) {
                return (
                    <Button variant="secondary" size="lg" onClick={() => void setIntakeStatus(intake, 'pending')}>
                        <RotateCcw className="mr-2 h-5 w-5" aria-hidden="true" />
                        {t('medications:today.undo')}
                    </Button>
                );
            }
            if (isDone(intake)) return null;
            return (
                <Button size="lg" className="sm:min-w-[12rem]" onClick={() => void setIntakeStatus(intake, 'taken')}>
                    <Check className="mr-2 h-5 w-5" aria-hidden="true" />
                    {t('medications:today.markTaken')}
                </Button>
            );
        }
        if (isDone(intake)) {
            return (
                <Button variant="ghost" size="lg" onClick={() => void setIntakeStatus(intake, 'pending')}>
                    <RotateCcw className="mr-2 h-5 w-5" aria-hidden="true" />
                    {t('medications:today.undo')}
                </Button>
            );
        }
        return (
            <div className="flex flex-col gap-3 sm:flex-row">
                <Button size="lg" className="sm:min-w-[12rem]" onClick={() => void setIntakeStatus(intake, 'taken')}>
                    <Check className="mr-2 h-5 w-5" aria-hidden="true" />
                    {t('medications:today.markTaken')}
                </Button>
                <Button variant="secondary" size="lg" onClick={() => void setIntakeStatus(intake, 'skipped')}>
                    {t('medications:today.markSkipped')}
                </Button>
            </div>
        );
    };

    const lowStockMeds = medications.filter((med) => med.active && isStockLow(med));

    const todaySection = (
        <div className="space-y-8">
            <p className="text-h2 text-foreground first-letter:uppercase">
                {new Date().toLocaleDateString(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
            {lowStockMeds.length > 0 && (
                <div role="status" className="rounded-input border border-warning/40 bg-warning/10 px-4 py-3">
                    <p className="flex items-center gap-2 text-body font-semibold text-foreground">
                        <Package className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
                        {t('medications:today.lowStockTitle')}
                    </p>
                    <ul className="mt-1 space-y-0.5 text-body text-foreground">
                        {lowStockMeds.map((med) => {
                            const remaining = stockNumber(med.stock_quantity) ?? 0;
                            return (
                                <li key={med.id}>
                                    {med.name}:{' '}
                                    {remaining <= 0
                                        ? t('medications:stock.empty')
                                        : amountLabel(remaining, stockUnitOf(med), med.form)}
                                </li>
                            );
                        })}
                    </ul>
                    <p className="mt-1 text-body text-foreground">{t('medications:today.lowStockHint')}</p>
                </div>
            )}
            {intakes.length === 0 ? (
                <Card>
                    <CardContent className="p-8 text-center">
                        <Pill className="mx-auto mb-3 h-12 w-12 text-muted-foreground opacity-50" aria-hidden="true" />
                        <p className="text-body text-foreground">{t('medications:today.empty')}</p>
                        <p className="mt-1 text-body text-muted-foreground">{t('medications:today.emptyHint')}</p>
                    </CardContent>
                </Card>
            ) : (
                MOMENTS.map((moment) => {
                    const group = intakesByMoment[moment];
                    if (group.length === 0) return null;
                    const openCount = openIntakesOf(moment).length;
                    return (
                        <section key={moment} aria-labelledby={`moment-${moment}`}>
                            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                                <h2 id={`moment-${moment}`} className="text-h1 text-foreground">
                                    {t(`medications:moments.${moment}`)}
                                </h2>
                                {canConfirmIntakes && openCount > 0 && (
                                    <Button size="lg" onClick={() => setConfirmAllMoment(moment)}>
                                        <CheckCheck className="mr-2 h-5 w-5" aria-hidden="true" />
                                        {t(`medications:today.allTaken.${moment}`)}
                                    </Button>
                                )}
                            </div>
                            <ul className="space-y-3">
                                {sortForToday(group).map((intake) => {
                                    const details = intakeDetails(intake);
                                    return (
                                        <li key={intake.id}>
                                            <Card className={cn(isDone(intake) && 'opacity-70')}>
                                                <CardContent className="space-y-4 p-4 sm:p-5">
                                                    <div className="flex items-start gap-4">
                                                        {intake.photo_url ? (
                                                            <img
                                                                src={intake.photo_url}
                                                                alt={t('medications:treatments.photoAlt', { name: intake.medication_name })}
                                                                className="h-20 w-20 flex-shrink-0 rounded-input border border-border object-cover"
                                                            />
                                                        ) : (
                                                            <Pill className="mt-1 h-8 w-8 flex-shrink-0 text-primary" aria-hidden="true" />
                                                        )}
                                                        <div className="min-w-0 flex-1 space-y-1">
                                                            <h3 className="text-h1 text-foreground">
                                                                {intake.medication_name}
                                                                {intake.active_ingredient ? ` – ${intake.active_ingredient}` : ''}
                                                                {intake.medication_dosage ? (
                                                                    <span className="ml-2 text-body font-normal text-muted-foreground">
                                                                        {intake.medication_dosage}
                                                                    </span>
                                                                ) : null}
                                                            </h3>
                                                            <p className="text-h2 text-foreground">
                                                                {intake.time_fixed === false
                                                                    ? amountLabel(intake.quantity, intake.unit, intake.form)
                                                                    : t('medications:today.takeAt', {
                                                                          amount: amountLabel(intake.quantity, intake.unit, intake.form),
                                                                          time: formatClock(intake.due_at),
                                                                      })}
                                                            </p>
                                                            {details.map((line, index) => (
                                                                <p key={index} className="text-body text-foreground">
                                                                    {line}
                                                                </p>
                                                            ))}
                                                            {intake.status === 'taken' && intake.confirmed_source ? (
                                                                <p className="text-caption text-muted-foreground">
                                                                    {sourceLabel(intake.confirmed_source)}
                                                                </p>
                                                            ) : null}
                                                        </div>
                                                    </div>
                                                    {renderIntakeState(intake)}
                                                    {renderIntakeActions(intake)}
                                                </CardContent>
                                            </Card>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    );
                })
            )}

            <Dialog
                open={confirmAllMoment !== null}
                onOpenChange={(open) => {
                    if (!open && !confirmAllBusy) setConfirmAllMoment(null);
                }}
                title={confirmAllMoment ? t(`medications:today.allTaken.${confirmAllMoment}`) : ''}
                description={t('medications:today.allTakenQuestion')}
            >
                <ul className="mb-6 space-y-2">
                    {confirmAllMoment &&
                        openIntakesOf(confirmAllMoment).map((intake) => (
                            <li key={intake.id} className="flex items-start gap-2 text-body text-foreground">
                                <Pill className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" aria-hidden="true" />
                                <span>
                                    {intake.medication_name}
                                    {intake.medication_dosage ? ` ${intake.medication_dosage}` : ''}
                                    {': '}
                                    {amountLabel(intake.quantity, intake.unit, intake.form)}
                                </span>
                            </li>
                        ))}
                </ul>
                <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                    <Button
                        variant="secondary"
                        size="lg"
                        disabled={confirmAllBusy}
                        onClick={() => setConfirmAllMoment(null)}
                    >
                        {t('medications:today.allTakenNo')}
                    </Button>
                    <Button size="lg" disabled={confirmAllBusy} onClick={() => void confirmAllIntakes()}>
                        <Check className="mr-2 h-5 w-5" aria-hidden="true" />
                        {t('medications:today.allTakenYes')}
                    </Button>
                </div>
            </Dialog>

            {prnMedications.length > 0 && (
                <section aria-labelledby="moment-prn">
                    <h2 id="moment-prn" className="mb-1 text-h1 text-foreground">
                        {t('medications:today.prnTitle')}
                    </h2>
                    <p className="mb-3 text-body text-muted-foreground">{t('medications:today.prnHint')}</p>
                    <ul className="space-y-3">
                        {prnMedications.map((med) => {
                            const count = prnIntakesToday(med.id);
                            return (
                                <li key={med.id}>
                                    <Card>
                                        <CardContent className="space-y-4 p-4 sm:p-5">
                                            <div className="flex items-start gap-4">
                                                {med.photo_url ? (
                                                    <img
                                                        src={med.photo_url}
                                                        alt={t('medications:treatments.photoAlt', { name: med.name })}
                                                        className="h-20 w-20 flex-shrink-0 rounded-input border border-border object-cover"
                                                    />
                                                ) : (
                                                    <Clock className="mt-1 h-8 w-8 flex-shrink-0 text-primary" aria-hidden="true" />
                                                )}
                                                <div className="min-w-0 flex-1 space-y-1">
                                                    <h3 className="text-h1 text-foreground">
                                                        {med.name}
                                                        {med.active_ingredient ? ` – ${med.active_ingredient}` : ''}
                                                        {med.dosage ? (
                                                            <span className="ml-2 text-body font-normal text-muted-foreground">{med.dosage}</span>
                                                        ) : null}
                                                    </h3>
                                                    {[med.reason, med.instructions].filter(Boolean).map((line, index) => (
                                                        <p key={index} className="text-body text-foreground">
                                                            {line}
                                                        </p>
                                                    ))}
                                                    {count > 0 && (
                                                        <p className="flex items-center gap-2 text-body font-semibold text-success">
                                                            <Check className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
                                                            {t('medications:today.prnToday', { count })}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                            {canWriteJournal && (
                                                <Button
                                                    size="lg"
                                                    className="sm:min-w-[12rem]"
                                                    disabled={prnBusy === med.id}
                                                    onClick={() => void logPrnIntake(med)}
                                                >
                                                    <PlusCircle className="mr-2 h-5 w-5" aria-hidden="true" />
                                                    {t('medications:today.logPrn')}
                                                </Button>
                                            )}
                                        </CardContent>
                                    </Card>
                                </li>
                            );
                        })}
                    </ul>
                </section>
            )}
        </div>
    );

    // ─── Treatments ───────────────────────────────────────────────────────────

    const openCreateMed = () => {
        setEditingMed(null);
        setMedForm(emptyMedForm());
        setMedFormError('');
        setMedDialogOpen(true);
    };

    const openEditMed = (med: Medication) => {
        setEditingMed(med);
        setMedForm({
            name: med.name,
            dosage: med.dosage || '',
            form: med.form || '',
            instructions: med.instructions || '',
            prescriber: med.prescriber || '',
            start_date: med.start_date ? med.start_date.slice(0, 10) : '',
            end_date: med.end_date ? med.end_date.slice(0, 10) : '',
            photo_url: med.photo_url || '',
            prn: Boolean(med.prn),
            with_food: med.with_food || '',
            reason: med.reason || '',
            appearance: med.appearance || '',
            active_ingredient: med.active_ingredient || '',
            schedules: med.schedules.map((s) => ({
                time_of_day: s.time_of_day,
                days_of_week: [...s.days_of_week],
                label: s.label || '',
                quantity: String(Number(s.quantity) || 1),
                unit: s.unit || '',
                time_fixed: s.time_fixed !== false,
            })),
        });
        setMedFormError('');
        setMedDialogOpen(true);
    };

    const updateScheduleRow = (index: number, patch: Partial<ScheduleRow>) => {
        setMedForm((prev) => ({
            ...prev,
            schedules: prev.schedules.map((row, i) => (i === index ? { ...row, ...patch } : row)),
        }));
    };

    const toggleScheduleDay = (index: number, day: number) => {
        setMedForm((prev) => ({
            ...prev,
            schedules: prev.schedules.map((row, i) => {
                if (i !== index) return row;
                const selected = row.days_of_week.includes(day);
                return {
                    ...row,
                    days_of_week: selected
                        ? row.days_of_week.filter((d) => d !== day)
                        : [...row.days_of_week, day].sort((a, b) => a - b),
                };
            }),
        }));
    };

    const handlePhotoChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setMedFormError('');
        setPhotoBusy(true);
        try {
            const dataUrl = await compressImageToDataUrl(file);
            setMedForm((prev) => ({ ...prev, photo_url: dataUrl }));
        } catch (err) {
            setMedFormError(
                err instanceof Error && err.message === 'photo-too-large'
                    ? t('medications:errors.photoTooLarge')
                    : t('medications:errors.photo')
            );
        } finally {
            setPhotoBusy(false);
        }
    };

    const handleMedSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setMedFormError('');

        const missing = [
            !medForm.name.trim() ? t('medications:form.name') : null,
            !medForm.dosage.trim() ? t('medications:form.dosage') : null,
            !medForm.form ? t('medications:form.form') : null,
        ].filter(Boolean);
        if (missing.length > 0) {
            setMedFormError(t('medications:form.requiredError', { fields: missing.join(', ') }));
            return;
        }

        const rows = medForm.prn ? [] : medForm.schedules;
        if (!medForm.prn && rows.length === 0) {
            setMedFormError(t('medications:form.schedulesRequiredError'));
            return;
        }
        for (const row of rows) {
            if (!TIME_RE.test(row.time_of_day)) {
                setMedFormError(t('medications:form.scheduleTimeError'));
                return;
            }
            if (row.days_of_week.length === 0) {
                setMedFormError(t('medications:form.scheduleDaysError'));
                return;
            }
            if (parseQuantity(row.quantity) === null) {
                setMedFormError(t('medications:form.quantityError'));
                return;
            }
        }

        const payload = {
            name: medForm.name.trim(),
            dosage: medForm.dosage,
            form: medForm.form,
            instructions: medForm.instructions,
            prescriber: medForm.prescriber,
            start_date: medForm.start_date || null,
            end_date: medForm.end_date || null,
            photo_url: medForm.photo_url || null,
            prn: medForm.prn,
            with_food: medForm.with_food || null,
            reason: medForm.reason.trim() || null,
            appearance: medForm.appearance.trim() || null,
            active_ingredient: medForm.active_ingredient.trim() || null,
            schedules: rows.map((row) => ({
                time_of_day: row.time_of_day,
                days_of_week: row.days_of_week,
                label: row.label.trim() || null,
                quantity: parseQuantity(row.quantity) ?? 1,
                unit: row.unit || null,
                time_fixed: row.time_fixed,
            })),
        };

        setSavingMed(true);
        try {
            if (editingMed) {
                await api.put(`/api/medications/${editingMed.id}`, payload);
            } else {
                await api.post('/api/medications', payload);
            }
            setMedDialogOpen(false);
            await Promise.all([loadMedications(), loadIntakes()]);
        } catch (err) {
            console.error('Failed to save medication:', err);
            setMedFormError(err instanceof Error ? err.message : t('medications:errors.save'));
        } finally {
            setSavingMed(false);
        }
    };

    const toggleMedActive = async (med: Medication) => {
        setError('');
        try {
            await api.put(`/api/medications/${med.id}`, { active: !med.active });
            await Promise.all([loadMedications(), loadIntakes()]);
        } catch (err) {
            console.error('Failed to archive medication:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.archive'));
        }
    };

    const openStockDialog = (med: Medication) => {
        setStockMed(med);
        setStockForm({
            quantity: med.stock_quantity === null ? '' : String(stockNumber(med.stock_quantity) ?? ''),
        });
        setStockFormError('');
    };

    const saveStock = async (med: Medication, quantity: number | null) => {
        setSavingStock(true);
        try {
            await api.put(`/api/medications/${med.id}/stock`, { stock_quantity: quantity });
            setStockMed(null);
            await loadMedications();
        } catch (err) {
            console.error('Failed to save stock:', err);
            setStockFormError(err instanceof Error ? err.message : t('medications:errors.saveStock'));
        } finally {
            setSavingStock(false);
        }
    };

    const handleStockSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!stockMed) return;
        setStockFormError('');
        const quantity = parseStockValue(stockForm.quantity);
        if (quantity === undefined) {
            setStockFormError(t('medications:stock.invalid'));
            return;
        }
        await saveStock(stockMed, quantity);
    };

    const stockActionLabel = (med: Medication) =>
        stockNumber(med.stock_quantity) === null
            ? t('medications:stock.start')
            : t('medications:stock.manage');

    /** Bloc stock d'un traitement : rien du tout tant que le stock n'est pas suivi. */
    /** Zelle einer Tageszeit: "1 – 08:00", bei einzelnen Tagen mit Wochentagen. */
    const momentCell = (med: Medication, moment: Moment) => {
        if (med.prn) return null;
        const rows = med.schedules
            .filter((s) => momentOf(parseInt(s.time_of_day.slice(0, 2), 10)) === moment)
            .sort((a, b) => a.time_of_day.localeCompare(b.time_of_day));
        return rows.map((schedule, index) => {
            const amount = safeQuantity(schedule.quantity).toLocaleString(intlLocale(), {
                maximumFractionDigits: 2,
            });
            const days =
                schedule.days_of_week.length === 7
                    ? ''
                    : sortIsoDays(schedule.days_of_week, weekStart).map((d) => daysShort[d - 1]).join(', ');
            return (
                <span key={schedule.id || index} className="block">
                    <span className="block text-h2 text-foreground">
                        {schedule.time_fixed === false
                            ? amount
                            : t('medications:treatments.amountAt', { amount, time: formatClock(schedule.time_of_day) })}
                    </span>
                    {days && <span className="block text-caption text-muted-foreground">{days}</span>}
                </span>
            );
        });
    };

    /** Einheit nur, wenn sie nicht schon aus der Form folgt (z. B. Saft in ml). */
    const unitCell = (med: Medication) => {
        const formUnit = DEFAULT_UNIT_BY_FORM[med.form ?? ''];
        const units = Array.from(new Set(med.schedules.map((s) => unitFor(s.unit, med.form)))).filter(
            (unit) => unit !== formUnit
        );
        return units
            .map((unit) => t(`medications:units.${unit}`, { count: 2, defaultValue: unit }))
            .join(', ');
    };

    const treatmentsSection = (
        <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-caption text-muted-foreground">
                    <input
                        type="checkbox"
                        checked={showArchived}
                        onChange={(e) => setShowArchived(e.target.checked)}
                        className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                    />
                    {t('medications:treatments.showArchived')}
                </label>
                {canWriteContent && (
                    <Button onClick={openCreateMed}>
                        <Plus className="mr-2 h-4 w-4" />
                        {t('medications:treatments.add')}
                    </Button>
                )}
            </div>

            {medications.length === 0 ? (
                <Card>
                    <CardContent className="p-8 text-center">
                        <Pill className="mx-auto mb-3 h-12 w-12 text-muted-foreground opacity-50" />
                        <p className="text-body text-foreground">{t('medications:treatments.empty')}</p>
                        <p className="mt-1 text-caption text-muted-foreground">
                            {t('medications:treatments.emptyHint')}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <ul className="space-y-3">
                    {medications.map((med) => {
                        const details = [
                            med.with_food ? t(`medications:withFood.${med.with_food}`) : null,
                            med.instructions,
                        ].filter(Boolean) as string[];
                        const subline = [
                            [med.active_ingredient, med.dosage].filter(Boolean).join(' '),
                            med.form ? formLabel(med.form) : '',
                            unitCell(med),
                        ].filter(Boolean);
                        return (
                            <li key={med.id}>
                                <Card className={cn(!med.active && 'opacity-70')}>
                                    <CardContent className="space-y-4 p-4 sm:p-5">
                                        <div className="flex items-start gap-3">
                                            <div className="min-w-0 flex-1">
                                                <h3 className="text-h1 text-foreground">{med.name}</h3>
                                                {subline.length > 0 && (
                                                    <p className="text-body text-muted-foreground">{subline.join(' · ')}</p>
                                                )}
                                                {(med.prn || !med.active) && (
                                                    <p className="mt-1 flex flex-wrap gap-1">
                                                        {med.prn && (
                                                            <Badge variant="default">{t('medications:treatments.prn')}</Badge>
                                                        )}
                                                        {!med.active && (
                                                            <Badge variant="default">{t('medications:treatments.archived')}</Badge>
                                                        )}
                                                    </p>
                                                )}
                                            </div>
                                            {canWriteContent && (
                                                <div className="flex flex-shrink-0 items-center gap-1">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-12 w-12"
                                                onClick={() => openEditMed(med)}
                                                aria-label={t('medications:treatments.edit')}
                                                title={t('medications:treatments.edit')}
                                            >
                                                <Edit2 className="h-5 w-5" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-12 w-12"
                                                onClick={() => void toggleMedActive(med)}
                                                aria-label={
                                                    med.active
                                                        ? t('medications:treatments.archive')
                                                        : t('medications:treatments.unarchive')
                                                }
                                                title={
                                                    med.active
                                                        ? t('medications:treatments.archive')
                                                        : t('medications:treatments.unarchive')
                                                }
                                            >
                                                {med.active ? (
                                                    <Archive className="h-5 w-5" />
                                                ) : (
                                                    <ArchiveRestore className="h-5 w-5" />
                                                )}
                                            </Button>
                                        </div>
                                            )}
                                        </div>
                                        {med.prn ? (
                                            <p className="text-body text-foreground">{t('medications:treatments.prnHint')}</p>
                                        ) : (
                                            <dl className="grid grid-cols-4 gap-px overflow-hidden rounded-input border border-border bg-border text-center">
                                                {MOMENTS.map((moment) => {
                                                    const cell = momentCell(med, moment);
                                                    return (
                                                        <div key={moment} className="bg-surface px-1 py-2">
                                                            <dt className="text-caption font-medium text-muted-foreground">
                                                                {t(`medications:moments.${moment}`)}
                                                            </dt>
                                                            <dd className="mt-1 text-body text-foreground">
                                                                {cell && cell.length > 0 ? cell : <span aria-label={t('medications:treatments.none')}>–</span>}
                                                            </dd>
                                                        </div>
                                                    );
                                                })}
                                            </dl>
                                        )}
                                        {details.length > 0 && (
                                            <p className="text-body text-foreground">
                                                <span className="font-semibold">{t('medications:treatments.notes')}</span>{' '}
                                                {details.join(' · ')}
                                            </p>
                                        )}
                                    </CardContent>
                                </Card>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );

    // ─── Vorrat ───────────────────────────────────────────────────────────────

    const stockMeds = medications.filter((med) => med.active);

    const stockSection = (
        <div className="space-y-4">
            {stockMeds.length === 0 ? (
                <Card>
                    <CardContent className="p-8 text-center">
                        <Package className="mx-auto mb-3 h-12 w-12 text-muted-foreground opacity-50" />
                        <p className="text-body text-foreground">{t('medications:stock.emptyList')}</p>
                    </CardContent>
                </Card>
            ) : (
                <Card>
                    <CardContent className="overflow-x-auto p-0">
                        <table className="w-full min-w-[36rem] border-collapse text-left text-body [overflow-wrap:normal] [word-break:normal]">
                            <caption className="sr-only">{t('medications:tabs.stock')}</caption>
                            <thead>
                                <tr className="border-b border-border bg-muted/50">
                                    {['medication', 'strength', 'stock', 'coverage'].map((key) => (
                                        <th
                                            key={key}
                                            scope="col"
                                            className="whitespace-nowrap px-3 py-3 align-bottom font-semibold text-foreground"
                                        >
                                            {t(`medications:stock.table.${key}`)}
                                        </th>
                                    ))}
                                    {canWriteContent && (
                                        <th scope="col" className="whitespace-nowrap px-3 py-3 align-bottom font-semibold text-foreground">
                                            {t('medications:stock.table.actions')}
                                        </th>
                                    )}
                                </tr>
                            </thead>
                            <tbody>
                                {stockMeds.map((med) => {
                                    const remaining = stockNumber(med.stock_quantity);
                                    const daysLeft = stockDaysLeft(med);
                                    const low = isStockLow(med);
                                    return (
                                        <tr key={med.id} className="border-b border-border align-top last:border-b-0">
                                            <th scope="row" className="px-3 py-3 text-left text-body font-semibold text-foreground">
                                                {med.name}
                                            </th>
                                            <td className="px-3 py-3 text-foreground">{med.dosage || ''}</td>
                                            <td className="px-3 py-3">
                                                {remaining === null ? (
                                                    <span className="text-muted-foreground">
                                                        {t('medications:stock.notTracked')}
                                                    </span>
                                                ) : (
                                                    <span className="flex flex-wrap items-center gap-2">
                                                        <span className={low ? 'text-warning' : 'text-foreground'}>
                                                            {remaining <= 0
                                                                ? t('medications:stock.empty')
                                                                : amountLabel(remaining, stockUnitOf(med), med.form)}
                                                        </span>
                                                        {low && <Badge variant="warning">{t('medications:stock.low')}</Badge>}
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-3 py-3 text-foreground">
                                                {daysLeft !== null ? t('medications:stock.coverage', { count: daysLeft }) : ''}
                                            </td>
                                            {canWriteContent && (
                                                <td className="px-3 py-3">
                                                    <Button variant="secondary" onClick={() => openStockDialog(med)}>
                                                        <Package className="mr-2 h-4 w-4" />
                                                        {stockActionLabel(med)}
                                                    </Button>
                                                </td>
                                            )}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </CardContent>
                </Card>
            )}
        </div>
    );

    // ─── Prescriptions ────────────────────────────────────────────────────────

    const openCreateRx = () => {
        setEditingRx(null);
        setRxForm(emptyRxForm());
        setRxFormError('');
        setRxDialogOpen(true);
    };

    const openEditRx = (rx: Prescription) => {
        setEditingRx(rx);
        setRxForm({
            title: rx.title,
            prescribed_by: rx.prescribed_by || '',
            issued_date: rx.issued_date ? rx.issued_date.slice(0, 10) : '',
            renewal_date: rx.renewal_date ? rx.renewal_date.slice(0, 10) : '',
            reminder_days: String(rx.reminder_days ?? 7),
            notes: rx.notes || '',
        });
        setRxFormError('');
        setRxDialogOpen(true);
    };

    const handleRxSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setRxFormError('');

        const reminderDays = parseInt(rxForm.reminder_days, 10);
        const payload = {
            title: rxForm.title.trim(),
            prescribed_by: rxForm.prescribed_by,
            issued_date: rxForm.issued_date || null,
            renewal_date: rxForm.renewal_date || null,
            reminder_days: Number.isInteger(reminderDays) && reminderDays >= 0 ? reminderDays : 7,
            notes: rxForm.notes,
        };

        setSavingRx(true);
        try {
            if (editingRx) {
                await api.put(`/api/medications/prescriptions/${editingRx.id}`, payload);
            } else {
                await api.post('/api/medications/prescriptions', payload);
            }
            setRxDialogOpen(false);
            await loadPrescriptions();
        } catch (err) {
            console.error('Failed to save prescription:', err);
            setRxFormError(
                err instanceof Error ? err.message : t('medications:errors.savePrescription')
            );
        } finally {
            setSavingRx(false);
        }
    };

    const handleRxDelete = async (rx: Prescription) => {
        if (!confirm(t('medications:prescriptions.confirmDelete'))) return;
        setError('');
        try {
            await api.delete(`/api/medications/prescriptions/${rx.id}`);
            await loadPrescriptions();
        } catch (err) {
            console.error('Failed to delete prescription:', err);
            setError(err instanceof Error ? err.message : t('medications:errors.deletePrescription'));
        }
    };

    const renewalStatus = (rx: Prescription): 'overdue' | 'dueSoon' | null => {
        if (!rx.renewal_date) return null;
        const days = differenceInCalendarDays(
            parseISO(rx.renewal_date.slice(0, 10)),
            startOfDay(new Date())
        );
        if (days < 0) return 'overdue';
        if (days <= (rx.reminder_days ?? 7)) return 'dueSoon';
        return null;
    };

    const prescriptionsSection = (
        <div className="space-y-4">
            {canWriteContent && (
                <div className="flex justify-end">
                    <Button onClick={openCreateRx}>
                        <Plus className="mr-2 h-4 w-4" />
                        {t('medications:prescriptions.add')}
                    </Button>
                </div>
            )}

            {prescriptions.length === 0 ? (
                <Card>
                    <CardContent className="p-8 text-center">
                        <FileText className="mx-auto mb-3 h-12 w-12 text-muted-foreground opacity-50" />
                        <p className="text-body text-foreground">
                            {t('medications:prescriptions.empty')}
                        </p>
                        <p className="mt-1 text-caption text-muted-foreground">
                            {t('medications:prescriptions.emptyHint')}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <Card>
                    <CardContent className="divide-y divide-border p-0">
                        {prescriptions.map((rx) => {
                            const status = renewalStatus(rx);
                            return (
                                <div
                                    key={rx.id}
                                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="text-body font-medium text-foreground">
                                            {rx.title}
                                        </p>
                                        <p className="text-caption text-muted-foreground">
                                            {[
                                                rx.prescribed_by,
                                                rx.issued_date
                                                    ? t('medications:prescriptions.issuedOn', {
                                                          date: fmtDate(rx.issued_date),
                                                      })
                                                    : null,
                                                rx.renewal_date
                                                    ? t('medications:prescriptions.renewalOn', {
                                                          date: fmtDate(rx.renewal_date),
                                                      })
                                                    : t('medications:prescriptions.noRenewal'),
                                            ]
                                                .filter(Boolean)
                                                .join(' · ')}
                                        </p>
                                        {rx.notes && (
                                            <p className="mt-1 text-caption text-muted-foreground">
                                                {rx.notes}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {status === 'overdue' && (
                                            <Badge variant="danger">
                                                {t('medications:prescriptions.overdue')}
                                            </Badge>
                                        )}
                                        {status === 'dueSoon' && (
                                            <Badge variant="warning">
                                                {t('medications:prescriptions.dueSoon')}
                                            </Badge>
                                        )}
                                        {canWriteContent && (
                                            <div className="flex items-center gap-1">
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => openEditRx(rx)}
                                                    aria-label={t('common:actions.edit')}
                                                    title={t('common:actions.edit')}
                                                >
                                                    <Edit2 className="h-4 w-4" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => void handleRxDelete(rx)}
                                                    aria-label={t('common:actions.delete')}
                                                    title={t('common:actions.delete')}
                                                >
                                                    <Trash2 className="h-4 w-4 text-danger" />
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </CardContent>
                </Card>
            )}
        </div>
    );

    // ─── Render ───────────────────────────────────────────────────────────────

    // Données médicales: accès refusé au rôle voisin (matrice de la SPEC).
    if (myRole === 'neighbor') {
        return (
            <div className="card-nexus mx-auto flex max-w-3xl flex-col items-center gap-3 px-6 py-16 text-center">
                <Pill className="h-10 w-10 text-muted-foreground" />
                <h1 className="text-h1 text-foreground">{t('medications:restricted.title')}</h1>
                <p className="text-body text-muted-foreground">{t('medications:restricted.description')}</p>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="flex h-full min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="animate-pulse font-medium text-muted-foreground">
                        {t('medications:loading')}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-4xl space-y-6">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <div>
                <h1 className="mb-1 text-h1">{t('medications:title')}</h1>
                <p className="text-body text-muted-foreground">{t('medications:subtitle')}</p>
            </div>

            <Tabs
                defaultValue="today"
                tabs={readsTodayOnly ? [
                    { value: 'today', label: t('medications:tabs.today'), content: todaySection },
                ] : [
                    { value: 'today', label: t('medications:tabs.today'), content: todaySection },
                    {
                        value: 'treatments',
                        label: t('medications:tabs.treatments'),
                        content: treatmentsSection,
                    },
                    { value: 'stock', label: t('medications:tabs.stock'), content: stockSection },
                    // Reiter Rezepte vorerst ausgeblendet (Code und Daten bleiben)
                    ...(SHOW_PRESCRIPTIONS
                        ? [
                              {
                                  value: 'prescriptions',
                                  label: t('medications:tabs.prescriptions'),
                                  content: prescriptionsSection,
                              },
                          ]
                        : []),
                ]}
            />

            <datalist id="prescriber-contacts">
                {contacts.map((contact) => (
                    <option key={contact.id} value={contact.name}>
                        {contact.organization || ''}
                    </option>
                ))}
            </datalist>

            {/* Medication dialog */}
            <Dialog
                open={medDialogOpen}
                onOpenChange={setMedDialogOpen}
                title={editingMed ? t('medications:form.editTitle') : t('medications:form.createTitle')}
                description={t('medications:form.description')}
                className="sm:max-w-2xl"
            >
                <form onSubmit={handleMedSubmit} className="space-y-4">
                    {medFormError ? (
                        <div id="med-form-error" role="alert" className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                            {medFormError}
                        </div>
                    ) : null}

                    <Input
                        label={t('medications:form.name')}
                        value={medForm.name}
                        onChange={(e) => setMedForm({ ...medForm, name: e.target.value })}
                        required
                        aria-invalid={medFormError && !medForm.name.trim() ? true : undefined}
                        aria-describedby={medFormError && !medForm.name.trim() ? 'med-form-error' : undefined}
                        placeholder={t('medications:form.namePlaceholder')}
                    />
                    <Input
                        label={t('medications:form.activeIngredient')}
                        value={medForm.active_ingredient}
                        onChange={(e) => setMedForm({ ...medForm, active_ingredient: e.target.value })}
                        placeholder={t('medications:form.activeIngredientPlaceholder')}
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Input
                            label={t('medications:form.dosage')}
                            value={medForm.dosage}
                            aria-required="true"
                            aria-invalid={medFormError && !medForm.dosage.trim() ? true : undefined}
                            aria-describedby={medFormError && !medForm.dosage.trim() ? 'med-form-error' : undefined}
                            onChange={(e) => setMedForm({ ...medForm, dosage: e.target.value })}
                            placeholder={t('medications:form.dosagePlaceholder')}
                        />
                        <div>
                            <label className="mb-1.5 block text-caption font-medium text-foreground">
                                {t('medications:form.form')}
                            </label>
                            <Select
                                value={medForm.form}
                                onValueChange={(value) => setMedForm({ ...medForm, form: value })}
                                placeholder={t('medications:form.formPlaceholder')}
                                options={formOptions}
                                invalid={!!medFormError && !medForm.form}
                                describedBy={medFormError && !medForm.form ? 'med-form-error' : undefined}
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Input
                            label={t('medications:form.reason')}
                            value={medForm.reason}
                            onChange={(e) => setMedForm({ ...medForm, reason: e.target.value })}
                            placeholder={t('medications:form.reasonPlaceholder')}
                        />
                        <Input
                            label={t('medications:form.appearance')}
                            value={medForm.appearance}
                            onChange={(e) => setMedForm({ ...medForm, appearance: e.target.value })}
                            placeholder={t('medications:form.appearancePlaceholder')}
                        />
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                            <label className="mb-1.5 block text-caption font-medium text-foreground">
                                {t('medications:form.withFood')}
                            </label>
                            <Select
                                value={medForm.with_food}
                                onValueChange={(value) => setMedForm({ ...medForm, with_food: value as '' | WithFood })}
                                placeholder={t('medications:form.withFoodPlaceholder')}
                                options={[
                                    { value: '', label: t('medications:form.withFoodPlaceholder') },
                                    ...withFoodOptions,
                                ]}
                            />
                        </div>
                    </div>
                    <Textarea
                        label={t('medications:form.instructions')}
                        value={medForm.instructions}
                        onChange={(e) => setMedForm({ ...medForm, instructions: e.target.value })}
                        placeholder={t('medications:form.instructionsPlaceholder')}
                        rows={2}
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <Input
                            label={t('medications:form.prescriber')}
                            value={medForm.prescriber}
                            onChange={(e) => setMedForm({ ...medForm, prescriber: e.target.value })}
                            placeholder={t('medications:form.prescriberPlaceholder')}
                            list="prescriber-contacts"
                            autoComplete="off"
                        />
                        <DatePicker
                            label={t('medications:form.startDate')}
                            value={medForm.start_date}
                            onChange={(value) => setMedForm({ ...medForm, start_date: value })}
                        />
                        <DatePicker
                            label={t('medications:form.endDate')}
                            value={medForm.end_date}
                            onChange={(value) => setMedForm({ ...medForm, end_date: value })}
                        />
                    </div>

                    {/* Photo */}
                    <div>
                        <span className="mb-1.5 block text-caption font-medium text-foreground">
                            {t('medications:form.photo')}
                        </span>
                        <div className="flex items-center gap-3">
                            {medForm.photo_url ? (
                                <img
                                    src={medForm.photo_url}
                                    alt=""
                                    className="h-16 w-16 rounded-input border border-border object-cover"
                                />
                            ) : null}
                            <input
                                ref={photoInputRef}
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => void handlePhotoChange(e)}
                            />
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={photoBusy}
                                onClick={() => photoInputRef.current?.click()}
                            >
                                {photoBusy
                                    ? t('medications:form.photoProcessing')
                                    : medForm.photo_url
                                      ? t('medications:form.photoChange')
                                      : t('medications:form.photoAdd')}
                            </Button>
                            {medForm.photo_url && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setMedForm({ ...medForm, photo_url: '' })}
                                >
                                    {t('medications:form.photoRemove')}
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Einnahme: feste Zeiten oder bei Bedarf */}
                    <fieldset>
                        <legend className="mb-1.5 block text-caption font-medium text-foreground">
                            {t('medications:form.intakeType')}
                        </legend>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {([false, true] as const).map((prn) => (
                                <label
                                    key={String(prn)}
                                    className={cn(
                                        'flex min-h-[48px] cursor-pointer items-start gap-3 rounded-input border px-3 py-3',
                                        medForm.prn === prn ? 'border-primary bg-primary/10' : 'border-border'
                                    )}
                                >
                                    <input
                                        type="radio"
                                        name="intake-type"
                                        checked={medForm.prn === prn}
                                        onChange={() => setMedForm({ ...medForm, prn })}
                                        className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary focus:ring-primary"
                                    />
                                    <span>
                                        <span className="block text-body font-medium text-foreground">
                                            {prn ? t('medications:form.prn') : t('medications:form.fixedTimes')}
                                        </span>
                                        <span className="block text-caption text-muted-foreground">
                                            {prn ? t('medications:form.prnHint') : t('medications:form.fixedTimesHint')}
                                        </span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>

                    {/* Schedule editor (hidden for "as needed" medications) */}
                    {medForm.prn ? (
                        <p className="rounded-input border border-dashed border-border px-3 py-4 text-center text-caption text-muted-foreground">
                            {t('medications:form.prnNoSchedule')}
                        </p>
                    ) : (
                    <div>
                        <span className="mb-1 block text-caption font-medium text-foreground">
                            {t('medications:form.schedules')}
                        </span>
                        <p className="mb-2 text-micro text-muted-foreground">
                            {t('medications:form.schedulesHint')}
                        </p>
                        <div className="space-y-3">
                            {medForm.schedules.length === 0 ? (
                                <p className="rounded-input border border-dashed border-border px-3 py-4 text-center text-caption text-muted-foreground">
                                    {t('medications:form.noSchedules')}
                                </p>
                            ) : (
                                medForm.schedules.map((row, index) => (
                                    <div
                                        key={index}
                                        className="space-y-3 rounded-input border border-border bg-surface-2/40 p-3"
                                    >
                                        <fieldset>
                                            <legend className="mb-1.5 block text-caption font-medium text-foreground">
                                                {t('medications:form.timeKind')}
                                            </legend>
                                            <div className="flex flex-wrap gap-2">
                                                {([false, true] as const).map((fixed) => (
                                                    <label
                                                        key={String(fixed)}
                                                        className={cn(
                                                            'flex min-h-[48px] cursor-pointer items-center gap-2 rounded-input border px-4',
                                                            row.time_fixed === fixed ? 'border-primary bg-primary/10' : 'border-border'
                                                        )}
                                                    >
                                                        <input
                                                            type="radio"
                                                            name={`time-kind-${index}`}
                                                            checked={row.time_fixed === fixed}
                                                            onChange={() =>
                                                                updateScheduleRow(index, {
                                                                    time_fixed: fixed,
                                                                    // Beim Wechsel zur Tageszeit die Standarduhrzeit setzen
                                                                    ...(fixed
                                                                        ? {}
                                                                        : {
                                                                              time_of_day:
                                                                                  MOMENT_TIMES[
                                                                                      TIME_RE.test(row.time_of_day)
                                                                                          ? momentOf(parseInt(row.time_of_day.slice(0, 2), 10))
                                                                                          : 'morning'
                                                                                  ],
                                                                          }),
                                                                })
                                                            }
                                                            className="h-5 w-5 text-primary focus:ring-primary"
                                                        />
                                                        <span className="text-body text-foreground">
                                                            {fixed ? t('medications:form.fixedTime') : t('medications:form.moment')}
                                                        </span>
                                                    </label>
                                                ))}
                                            </div>
                                        </fieldset>
                                        {!row.time_fixed && (
                                            <div role="group" aria-label={t('medications:form.moment')} className="flex flex-wrap gap-2">
                                                {MOMENTS.map((moment) => {
                                                    const selected =
                                                        TIME_RE.test(row.time_of_day) &&
                                                        momentOf(parseInt(row.time_of_day.slice(0, 2), 10)) === moment;
                                                    return (
                                                        <button
                                                            key={moment}
                                                            type="button"
                                                            aria-pressed={selected}
                                                            onClick={() =>
                                                                updateScheduleRow(index, { time_of_day: MOMENT_TIMES[moment] })
                                                            }
                                                            className={cn(
                                                                'min-h-[48px] rounded-input border px-4 text-body font-medium',
                                                                selected
                                                                    ? 'border-primary bg-primary text-primary-foreground'
                                                                    : 'border-border bg-surface text-foreground hover:bg-surface-2'
                                                            )}
                                                        >
                                                            {t(`medications:moments.${moment}`)}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                        <div className="flex flex-wrap items-end gap-3">
                                            {row.time_fixed && (
                                                <div className="w-32 flex-shrink-0">
                                                    <DatePicker
                                                        type="time"
                                                        label={t('medications:form.time')}
                                                        value={row.time_of_day}
                                                        onChange={(value) =>
                                                            updateScheduleRow(index, { time_of_day: value })
                                                        }
                                                    />
                                                </div>
                                            )}
                                            <div className="w-24 flex-shrink-0">
                                                <Input
                                                    label={t('medications:form.quantity')}
                                                    type="number"
                                                    inputMode="decimal"
                                                    min={0.25}
                                                    max={99}
                                                    step={0.25}
                                                    value={row.quantity}
                                                    onChange={(e) =>
                                                        updateScheduleRow(index, { quantity: e.target.value })
                                                    }
                                                    aria-invalid={medFormError && parseQuantity(row.quantity) === null ? true : undefined}
                                                    aria-describedby={medFormError && parseQuantity(row.quantity) === null ? 'med-form-error' : undefined}
                                                />
                                            </div>
                                            <div className="w-40 flex-shrink-0">
                                                <label className="mb-1.5 block text-caption font-medium text-foreground">
                                                    {t('medications:form.unit')}
                                                </label>
                                                <Select
                                                    value={row.unit}
                                                    onValueChange={(value) => updateScheduleRow(index, { unit: value })}
                                                    placeholder={t('medications:form.unitAuto')}
                                                    options={[
                                                        { value: '', label: t('medications:form.unitAuto') },
                                                        ...unitOptions,
                                                    ]}
                                                />
                                            </div>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="flex-shrink-0"
                                                onClick={() =>
                                                    setMedForm((prev) => ({
                                                        ...prev,
                                                        schedules: prev.schedules.filter(
                                                            (_, i) => i !== index
                                                        ),
                                                    }))
                                                }
                                                aria-label={t('medications:form.removeSchedule')}
                                                title={t('medications:form.removeSchedule')}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                        <div className="flex flex-wrap gap-1.5">
                                            {orderedIsoDays(weekStart).map((day) => {
                                                const selected = row.days_of_week.includes(day);
                                                return (
                                                    <button
                                                        key={day}
                                                        type="button"
                                                        aria-pressed={selected}
                                                        aria-label={dayNames[day - 1]}
                                                        title={dayNames[day - 1]}
                                                        onClick={() => toggleScheduleDay(index, day)}
                                                        className={cn(
                                                            'flex h-11 w-11 items-center justify-center rounded-pill border text-caption font-medium transition-colors sm:h-10 sm:w-10',
                                                            selected
                                                                ? 'border-primary bg-primary text-primary-foreground'
                                                                : 'border-border bg-card text-muted-foreground hover:bg-surface-2'
                                                        )}
                                                    >
                                                        {dayLetters[day - 1]}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))
                            )}
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={() =>
                                    setMedForm((prev) => ({
                                        ...prev,
                                        schedules: [...prev.schedules, emptyScheduleRow()],
                                    }))
                                }
                            >
                                <Plus className="mr-1.5 h-4 w-4" />
                                {t('medications:form.addSchedule')}
                            </Button>
                        </div>
                    </div>
                    )}

                    <div className="flex justify-end gap-3 pt-4">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setMedDialogOpen(false)}
                        >
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={savingMed || photoBusy}>
                            {savingMed
                                ? t('common:states.saving')
                                : editingMed
                                  ? t('common:actions.save')
                                  : t('common:actions.create')}
                        </Button>
                    </div>
                </form>
            </Dialog>

            {/* Stock dialog */}
            <Dialog
                open={stockMed !== null}
                onOpenChange={(open) => {
                    if (!open) setStockMed(null);
                }}
                title={t('medications:stock.dialogTitle', { name: stockMed?.name ?? '' })}
                description={t('medications:stock.dialogDescription')}
            >
                <form onSubmit={handleStockSubmit} className="space-y-4">
                    {stockFormError ? (
                        <div id="stock-form-error" role="alert" className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                            {stockFormError}
                        </div>
                    ) : null}

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Input
                            label={t('medications:stock.quantity')}
                            type="number"
                            inputMode="decimal"
                            min={0}
                            max={MAX_STOCK}
                            step={1}
                            value={stockForm.quantity}
                            onChange={(e) => setStockForm({ ...stockForm, quantity: e.target.value })}
                            aria-invalid={stockFormError && parseStockValue(stockForm.quantity) === undefined ? true : undefined}
                            aria-describedby={stockFormError && parseStockValue(stockForm.quantity) === undefined ? 'stock-form-error' : undefined}
                            placeholder={t('medications:stock.quantityPlaceholder')}
                        />
                    </div>

                    <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
                        <Button
                            type="button"
                            variant="secondary"
                            disabled={savingStock || stockMed?.stock_quantity === null}
                            onClick={() => {
                                if (stockMed) void saveStock(stockMed, null);
                            }}
                        >
                            {t('medications:stock.stopTracking')}
                        </Button>
                        <div className="flex justify-end gap-3">
                            <Button type="button" variant="secondary" onClick={() => setStockMed(null)}>
                                {t('common:actions.cancel')}
                            </Button>
                            <Button type="submit" disabled={savingStock}>
                                {savingStock ? t('common:states.saving') : t('common:actions.save')}
                            </Button>
                        </div>
                    </div>
                </form>
            </Dialog>

            {/* Prescription dialog */}
            <Dialog
                open={rxDialogOpen}
                onOpenChange={setRxDialogOpen}
                title={
                    editingRx
                        ? t('medications:prescriptions.form.editTitle')
                        : t('medications:prescriptions.form.createTitle')
                }
                description={t('medications:prescriptions.form.description')}
            >
                <form onSubmit={handleRxSubmit} className="space-y-4">
                    {rxFormError ? (
                        <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                            {rxFormError}
                        </div>
                    ) : null}

                    <Input
                        label={t('medications:prescriptions.form.title')}
                        value={rxForm.title}
                        onChange={(e) => setRxForm({ ...rxForm, title: e.target.value })}
                        required
                        placeholder={t('medications:prescriptions.form.titlePlaceholder')}
                    />
                    <Input
                        label={t('medications:prescriptions.form.prescriber')}
                        value={rxForm.prescribed_by}
                        onChange={(e) => setRxForm({ ...rxForm, prescribed_by: e.target.value })}
                        placeholder={t('medications:prescriptions.form.prescriberPlaceholder')}
                        list="prescriber-contacts"
                        autoComplete="off"
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <DatePicker
                            label={t('medications:prescriptions.form.issuedDate')}
                            value={rxForm.issued_date}
                            onChange={(value) => setRxForm({ ...rxForm, issued_date: value })}
                        />
                        <DatePicker
                            label={t('medications:prescriptions.form.renewalDate')}
                            value={rxForm.renewal_date}
                            onChange={(value) => setRxForm({ ...rxForm, renewal_date: value })}
                        />
                    </div>
                    <Input
                        label={t('medications:prescriptions.form.reminderDays')}
                        type="number"
                        min={0}
                        step={1}
                        value={rxForm.reminder_days}
                        onChange={(e) => setRxForm({ ...rxForm, reminder_days: e.target.value })}
                    />
                    <Textarea
                        label={t('medications:prescriptions.form.notes')}
                        value={rxForm.notes}
                        onChange={(e) => setRxForm({ ...rxForm, notes: e.target.value })}
                        placeholder={t('medications:prescriptions.form.notesPlaceholder')}
                        rows={2}
                    />

                    <div className="flex justify-end gap-3 pt-4">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setRxDialogOpen(false)}
                        >
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={savingRx}>
                            {savingRx
                                ? t('common:states.saving')
                                : editingRx
                                  ? t('common:actions.save')
                                  : t('common:actions.create')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Medications;
