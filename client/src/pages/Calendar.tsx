import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Plus, ChevronLeft, ChevronRight, MapPin, Clock, Users, Repeat,
    Trash2, Edit2, Copy, Check, CalendarPlus, RefreshCw, CalendarDays, List, Bell,
    CalendarClock, CalendarOff, Undo2, Car, Minus, X, CalendarRange, CalendarCheck,
} from 'lucide-react';
import {
    format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
    eachDayOfInterval, isSameMonth, isToday, addMonths, subMonths, parseISO,
    addDays, subDays, addMinutes, differenceInMinutes, addWeeks,
} from 'date-fns';
import { Card, CardContent, Button, Dialog, Input, Textarea, Select, DatePicker } from '../components/ui';
import { api, API_BASE_URL } from '../lib/api';
import { serverUrl } from '../lib/serverUrl';
import { cn } from '../lib/utils';
import { useCircle } from '../contexts/CircleContext';
import { circleWeekStart, weekStartsOn, orderedIsoDays, inWeekOrder } from '../lib/weekStart';
import { useAuth } from '../contexts/AuthContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { dateLocale, formatClock } from '../i18n/format';
import {
    NEW_EVENT_DEFAULTS, NEW_EVENT_TRAVEL_MINUTES, TRAVEL_MAX_MINUTES, TRAVEL_MIN_MINUTES,
    addParticipant, hasExtraDetails, longDatePattern, shiftClock, stepTravel,
} from '../lib/calendarForm';

// ─── Domain types ─────────────────────────────────────────────────────────────

type EventCategory = 'visit' | 'medical' | 'nurse' | 'aide' | 'other';

const CATEGORIES: EventCategory[] = ['visit', 'medical', 'nurse', 'aide', 'other'];
/** Categories a professional can create and manage (their own care visits). */
const PRO_CATEGORIES: EventCategory[] = ['visit', 'nurse', 'aide'];

/** Soft semantic palette: dot color + muted chip background per category. */
const CATEGORY_DOT: Record<EventCategory, string> = {
    visit: 'bg-primary',
    medical: 'bg-info',
    nurse: 'bg-peach',
    aide: 'bg-warning',
    other: 'bg-muted-foreground',
};
const CATEGORY_CHIP: Record<EventCategory, string> = {
    visit: 'bg-primary-soft',
    medical: 'bg-info/10',
    nurse: 'bg-peach/10',
    aide: 'bg-warning/10',
    other: 'bg-surface-2',
};

interface MemberData {
    id: string;
    name: string;
    color: string;
    role?: string;
}

/** One occurrence as returned by GET /api/events (recurrences already expanded). */
interface EventOccurrence {
    id: string;
    title: string;
    description?: string | null;
    category: EventCategory;
    start_time: string; // naive local "YYYY-MM-DDTHH:mm:ss"
    end_time: string | null;
    location?: string | null;
    rrule?: string | null;
    member_ids: string[];
    members_data?: MemberData[];
    /** Fork: Teilnehmende ohne Konto (nur Namen). */
    guests?: string[];
    /** Fork: Fahrt in Minuten vor Beginn / nach Ende, null = keine Fahrt. */
    travel_to_minutes?: number | null;
    travel_back_minutes?: number | null;
    driver_to?: string | null;
    driver_back?: string | null;
    reminder_30min: boolean;
    reminder_1hour: boolean;
    notes?: string | null;
    created_by?: string | null;
    occurrence_date: string; // local "YYYY-MM-DD"
    is_recurring: boolean;
    moved?: boolean;
}

interface ContactOption {
    id: string;
    name: string;
    organization: string | null;
}

interface CircleMember {
    id: string;
    user_id: string;
    name: string;
    color: string;
    role: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** "YYYY-MM-DDTHH:mm:ss" -> "HH:mm" without any Date round-trip, for the form inputs. */
const timeOf = (value: string | null | undefined): string => (value ? value.slice(11, 16) : '');

/** Ecart maximal accepte par le serveur pour deplacer une occurrence. */
const MOVE_MAX_DAYS = 7;

// Le serveur pose un drapeau sur les occurrences deplacees ; on retombe sur la
// comparaison des jours pour que le reperage tienne meme sans ce drapeau.
const isMovedOccurrence = (occ: EventOccurrence): boolean =>
    occ.moved === true || (occ.is_recurring && occ.start_time.slice(0, 10) !== occ.occurrence_date);

/** Date locale naive attendue par l'API, sans detour par UTC. */
const toNaiveLocal = (value: Date): string => format(value, "yyyy-MM-dd'T'HH:mm:ss");

const RRULE_DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

interface RecurrenceForm {
    freq: '' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
    byDays: string[];
    until: string; // "yyyy-MM-dd" or ''
}

/** Build the simple RRULE string understood by the server parser. */
const buildRRule = (rec: RecurrenceForm): string | null => {
    if (!rec.freq) return null;
    let rule = `FREQ=${rec.freq};INTERVAL=1`;
    if (rec.freq === 'WEEKLY' && rec.byDays.length > 0) {
        const ordered = RRULE_DAY_CODES.filter((code) => rec.byDays.includes(code));
        rule += `;BYDAY=${ordered.join(',')}`;
    }
    if (rec.until) rule += `;UNTIL=${rec.until.replace(/-/g, '')}`;
    return rule;
};

/** Read an existing RRULE back into the form (same subset as the server). */
const parseRRuleToForm = (text: string | null | undefined): RecurrenceForm => {
    const out: RecurrenceForm = { freq: '', byDays: [], until: '' };
    if (!text) return out;
    for (const part of text.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const key = part.slice(0, eq).trim().toUpperCase();
        const value = part.slice(eq + 1).trim().toUpperCase();
        if (key === 'FREQ' && (value === 'DAILY' || value === 'WEEKLY' || value === 'MONTHLY')) {
            out.freq = value;
        } else if (key === 'BYDAY') {
            out.byDays = value.split(',').filter((code) => (RRULE_DAY_CODES as readonly string[]).includes(code));
        } else if (key === 'UNTIL' && /^\d{8}/.test(value)) {
            out.until = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
        }
    }
    return out;
};

// ─── Small UI pieces ──────────────────────────────────────────────────────────

const Switch: React.FC<{ checked: boolean; onChange: (value: boolean) => void; label: string }> = ({
    checked, onChange, label,
}) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="flex min-h-[44px] items-center gap-3 rounded-input px-1 text-left"
    >
        <span
            className={cn(
                'relative inline-flex h-6 w-10 shrink-0 items-center rounded-pill border transition-colors duration-fast ease-soft',
                checked ? 'border-primary bg-primary' : 'border-border-strong bg-surface-2'
            )}
        >
            <span
                className={cn(
                    'absolute h-4 w-4 rounded-full bg-surface shadow-surface transition-transform duration-fast ease-soft',
                    checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
                )}
            />
        </span>
        <span className="text-caption text-foreground">{label}</span>
    </button>
);

const CategoryDot: React.FC<{ category: EventCategory; className?: string }> = ({ category, className }) => (
    <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', CATEGORY_DOT[category], className)} aria-hidden="true" />
);

// ─── Form state ───────────────────────────────────────────────────────────────

interface EventForm {
    title: string;
    category: EventCategory;
    date: string;       // yyyy-MM-dd
    startTime: string;  // HH:mm
    endTime: string;    // HH:mm or ''
    location: string;
    member_ids: string[];
    guests: string[];
    travelTo: number | null;    // Minuten vor Beginn, null = keine Hinfahrt
    travelBack: number | null;  // Minuten nach Ende, null = keine Rückfahrt
    driverTo: string;
    driverBack: string;
    /** true, sobald der Fahrer der Rückfahrt von Hand geändert wurde. */
    driverBackEdited: boolean;
    notes: string;
    reminder_30min: boolean;
    reminder_1hour: boolean;
    recurrence: RecurrenceForm;
}

const emptyForm = (): EventForm => ({
    title: '',
    category: 'visit',
    date: format(new Date(), 'yyyy-MM-dd'),
    startTime: '09:00',
    location: '',
    member_ids: [],
    guests: [],
    travelTo: NEW_EVENT_TRAVEL_MINUTES,
    travelBack: NEW_EVENT_TRAVEL_MINUTES,
    driverTo: '',
    driverBack: '',
    driverBackEdited: false,
    notes: '',
    ...NEW_EVENT_DEFAULTS,
    recurrence: { freq: '', byDays: [], until: '' },
});

// ─── Page ─────────────────────────────────────────────────────────────────────


// ─── Tages- und Wochenansicht (Fork) ──────────────────────────────────────────

type CalendarView = 'day' | 'week' | 'month' | 'list';

/** Höhe einer Stunde in der Tagesansicht. 15 Minuten Fahrt = 24 px, genug für eine Textzeile. */
const DAY_HOUR_PX = 96;
/** Sichtbarer Bereich mindestens 8 bis 18 Uhr, er wächst mit frühen oder späten Terminen. */
const DAY_FIRST_HOUR = 8;
const DAY_LAST_HOUR = 18;
/** Termin ohne Ende oder sehr kurzer Termin: mindestens 30 Minuten hoch (48 px, gut antippbar). */
const DAY_MIN_EVENT_MINUTES = 30;

/** "YYYY-MM-DDTHH:mm:ss" -> Minuten seit Mitternacht. */
const minutesOf = (value: string): number => Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));

interface DayBlock {
    occ: EventOccurrence;
    /** Minuten seit Mitternacht: Beginn der Hinfahrt bzw. Ende der Rückfahrt. */
    from: number;
    to: number;
    travelTo: number;
    eventMinutes: number;
    travelBack: number;
    lane: number;
    lanes: number;
}

/** Termine eines Tages mit Fahrzeit untereinander legen; Überschneidungen kommen nebeneinander. */
const layoutDay = (list: EventOccurrence[]): DayBlock[] => {
    const blocks: DayBlock[] = [...list]
        .sort((a, b) => a.start_time.localeCompare(b.start_time))
        .map((occ) => {
            const start = minutesOf(occ.start_time);
            let end = start;
            if (occ.end_time) {
                end = occ.end_time.slice(0, 10) === occ.start_time.slice(0, 10) ? minutesOf(occ.end_time) : 24 * 60;
            }
            const travelTo = Math.min(occ.travel_to_minutes ?? 0, start);
            const eventMinutes = Math.min(Math.max(end - start, DAY_MIN_EVENT_MINUTES), 24 * 60 - start);
            const travelBack = Math.min(occ.travel_back_minutes ?? 0, 24 * 60 - start - eventMinutes);
            return {
                occ,
                from: start - travelTo,
                to: start + eventMinutes + travelBack,
                travelTo,
                eventMinutes,
                travelBack,
                lane: 0,
                lanes: 1,
            };
        })
        .sort((a, b) => a.from - b.from || a.to - b.to);

    let cluster: DayBlock[] = [];
    let laneEnds: number[] = [];
    let clusterEnd = -1;
    const closeCluster = () => {
        for (const block of cluster) block.lanes = laneEnds.length;
        cluster = [];
        laneEnds = [];
    };
    for (const block of blocks) {
        if (cluster.length > 0 && block.from >= clusterEnd) closeCluster();
        let lane = laneEnds.findIndex((laneEnd) => laneEnd <= block.from);
        if (lane === -1) {
            lane = laneEnds.length;
            laneEnds.push(block.to);
        } else {
            laneEnds[lane] = block.to;
        }
        block.lane = lane;
        cluster.push(block);
        clusterEnd = Math.max(clusterEnd, block.to);
    }
    closeCluster();
    return blocks;
};

/** Überschrift der Wochenansicht, z. B. "9. – 15. Nov. 2026". */
const weekRangeLabel = (start: Date, end: Date, lang: string): string => {
    const l = (lang || '').slice(0, 2).toLowerCase();
    const [short, long] = l === 'de'
        ? ['d. MMM', 'd. MMM yyyy']
        : l === 'en' ? ['MMM d', 'MMM d, yyyy'] : ['d MMM', 'd MMM yyyy'];
    return `${format(start, short, { locale: dateLocale() })} – ${format(end, long, { locale: dateLocale() })}`;
};

const Calendar: React.FC = () => {
    const { t, i18n } = useTranslation(['calendar', 'common']);
    const longDate = (withYear: boolean) => longDatePattern(i18n.language, withYear);
    const { activeCircle, myRole, canWriteContent } = useCircle();
    const { user } = useAuth();

    const [currentDate, setCurrentDate] = useState(new Date());
    // Fork: Der Kalender öffnet immer in der Wochenansicht.
    const [view, setView] = useState<CalendarView>('week');
    const [occurrences, setOccurrences] = useState<EventOccurrence[]>([]);
    const [members, setMembers] = useState<CircleMember[]>([]);
    const [contacts, setContacts] = useState<ContactOption[]>([]);
    // Eingabefeld für eine neue teilnehmende Person (noch nicht hinzugefügt).
    const [personInput, setPersonInput] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [selected, setSelected] = useState<EventOccurrence | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingRecurring, setEditingRecurring] = useState(false);
    const [formData, setFormData] = useState<EventForm>(emptyForm());
    // "Weitere Angaben" im Formular: neu zugeklappt, beim Bearbeiten offen, wenn etwas drin steht.
    const [showMore, setShowMore] = useState(false);
    const [saving, setSaving] = useState(false);

    // Occurrence isolee d'une serie : deplacement ponctuel, sans toucher a la regle.
    const [moveTarget, setMoveTarget] = useState<EventOccurrence | null>(null);
    const [moveDate, setMoveDate] = useState('');
    const [moveTime, setMoveTime] = useState('');
    const [occurrenceBusy, setOccurrenceBusy] = useState(false);

    const [feedToken, setFeedToken] = useState<string | null>(null);
    const [feedBusy, setFeedBusy] = useState(false);
    const [feedCopied, setFeedCopied] = useState(false);

    const canCreate = canWriteContent || myRole === 'professional';
    const categoryChoices = canWriteContent ? CATEGORIES : PRO_CATEGORIES;

    const canManage = (occ: EventOccurrence): boolean => {
        if (canWriteContent) return true;
        if (myRole === 'professional') {
            return occ.created_by === user?.id && PRO_CATEGORIES.includes(occ.category);
        }
        return false;
    };

    // ── Data loading (refetched on month change, circle change, WS push) ──────
    const monthStart = startOfMonth(currentDate);
    // Premier jour de la semaine : reglage du cercle (lundi par defaut).
    const weekStart = circleWeekStart(activeCircle);
    const gridStart = startOfWeek(monthStart, { weekStartsOn: weekStartsOn(weekStart) });
    const gridEnd = endOfWeek(endOfMonth(currentDate), { weekStartsOn: weekStartsOn(weekStart) });

    const loadEvents = async () => {
        if (!activeCircle) return;
        try {
            const from = format(gridStart, 'yyyy-MM-dd');
            const to = format(gridEnd, 'yyyy-MM-dd');
            const response = await api.get<{ success: boolean; data: EventOccurrence[] }>(
                `/api/events?from=${from}&to=${to}`
            );
            if (response.success) {
                setOccurrences(response.data);
                setError('');
            }
        } catch (err) {
            console.error('Failed to load events:', err);
            setError(err instanceof Error ? err.message : t('calendar:errors.load'));
        } finally {
            setLoading(false);
        }
    };

    const loadMembers = async () => {
        if (!activeCircle) return;
        try {
            const response = await api.get<{ success: boolean; data: { members: CircleMember[] } }>(
                `/api/circles/${activeCircle.id}`
            );
            if (response.success) setMembers(response.data.members ?? []);
        } catch (err) {
            console.error('Failed to load circle members:', err);
        }
    };

    const loadFeedToken = async () => {
        try {
            const response = await api.get<{ success: boolean; data: { token: string | null } }>('/api/calendar/token');
            if (response.success) setFeedToken(response.data.token);
        } catch (err) {
            console.error('Failed to load calendar token:', err);
        }
    };

    useEffect(() => {
        setLoading(true);
        void loadEvents();
        // weekStart deplace les bords de la grille : le dimanche ajoute doit etre charge.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentDate, activeCircle?.id, weekStart]);

    useEffect(() => {
        void loadMembers();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    useEffect(() => { void loadFeedToken(); }, []);

    // Kontakte nur als Vorschläge für Teilnehmende und Fahrer: Fehler stören die Seite nicht.
    useEffect(() => {
        if (!activeCircle) return;
        api.get<{ success: boolean; data: ContactOption[] }>('/api/contacts')
            .then((response) => {
                if (response.success) setContacts(response.data);
            })
            .catch((err) => console.error('Failed to load contacts:', err));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    // Vorschlagsliste: Mitglieder des Kreises, dann Kontakte, ohne doppelte Namen.
    const personSuggestions = useMemo(() => {
        const seen = new Set<string>();
        const list: { key: string; name: string; hint: string }[] = [];
        for (const member of members) {
            const k = member.name.trim().toLocaleLowerCase('de');
            if (!k || seen.has(k)) continue;
            seen.add(k);
            list.push({ key: `m-${member.id}`, name: member.name, hint: '' });
        }
        for (const contact of contacts) {
            const k = contact.name.trim().toLocaleLowerCase('de');
            if (!k || seen.has(k)) continue;
            seen.add(k);
            list.push({ key: `c-${contact.id}`, name: contact.name, hint: contact.organization || '' });
        }
        return list;
    }, [members, contacts]);

    useWebSocketUpdates('events', () => { void loadEvents(); });

    // ── Derived ───────────────────────────────────────────────────────────────
    const occurrencesByDay = useMemo(() => {
        const map = new Map<string, EventOccurrence[]>();
        for (const occ of occurrences) {
            const list = map.get(occ.occurrence_date);
            if (list) list.push(occ);
            else map.set(occ.occurrence_date, [occ]);
        }
        return map;
    }, [occurrences]);

    const monthPrefix = format(currentDate, 'yyyy-MM');
    const listDays = useMemo(
        () => [...occurrencesByDay.keys()].filter((d) => d.startsWith(monthPrefix)).sort(),
        [occurrencesByDay, monthPrefix]
    );

    const calendarDays = eachDayOfInterval({ start: gridStart, end: gridEnd });
    // Die Woche des gewählten Tages liegt immer im geladenen Monatsraster.
    const weekStartDate = startOfWeek(currentDate, { weekStartsOn: weekStartsOn(weekStart) });
    const weekEndDate = endOfWeek(currentDate, { weekStartsOn: weekStartsOn(weekStart) });
    const weekDates = eachDayOfInterval({ start: weekStartDate, end: weekEndDate });
    // Les traductions restent rangees du lundi au dimanche ; seul l'affichage tourne.
    const weekDays = inWeekOrder(t('common:daysShort', { returnObjects: true }) as string[], weekStart);
    const dayLetters = t('calendar:form.dayLetters', { returnObjects: true }) as string[];

    // ── Create / edit ─────────────────────────────────────────────────────────
    const openCreate = (date?: Date) => {
        setEditingId(null);
        setEditingRecurring(false);
        setFormData({ ...emptyForm(), date: format(date ?? new Date(), 'yyyy-MM-dd') });
        setPersonInput('');
        setShowMore(false);
        setError('');
        setDialogOpen(true);
    };

    const openEdit = (occ: EventOccurrence) => {
        setSelected(null);
        setEditingId(occ.id);
        setEditingRecurring(occ.is_recurring);
        const form: EventForm = {
            title: occ.title,
            category: occ.category,
            date: occ.start_time.slice(0, 10),
            startTime: timeOf(occ.start_time),
            endTime: timeOf(occ.end_time),
            location: occ.location || '',
            member_ids: occ.member_ids || [],
            guests: occ.guests || [],
            travelTo: occ.travel_to_minutes ?? null,
            travelBack: occ.travel_back_minutes ?? null,
            driverTo: occ.driver_to || '',
            driverBack: occ.driver_back || '',
            driverBackEdited: (occ.driver_back || '') !== (occ.driver_to || ''),
            notes: occ.notes || '',
            reminder_30min: occ.reminder_30min,
            reminder_1hour: occ.reminder_1hour,
            recurrence: parseRRuleToForm(occ.rrule),
        };
        setFormData(form);
        setPersonInput('');
        // Ort und Teilnehmende stehen jetzt außerhalb von „Weitere Angaben“.
        setShowMore(hasExtraDetails({ ...form, location: '', member_ids: [] }));
        setError('');
        setDialogOpen(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (!formData.title.trim()) {
            setError(t('calendar:errors.titleRequired'));
            return;
        }
        if (!formData.date || !formData.startTime) {
            setError(t('calendar:errors.startRequired'));
            return;
        }
        if (formData.endTime && formData.endTime < formData.startTime) {
            setError(t('calendar:errors.endAfterStart'));
            return;
        }

        // Ein eingetippter, aber nicht hinzugefügter Name geht nicht verloren.
        const people = addParticipant(formData, personInput, members);

        const payload = {
            title: formData.title.trim(),
            category: formData.category,
            start_time: `${formData.date}T${formData.startTime}:00`,
            end_time: formData.endTime ? `${formData.date}T${formData.endTime}:00` : null,
            location: formData.location,
            notes: formData.notes,
            member_ids: people.member_ids,
            guests: people.guests,
            travel_to_minutes: formData.travelTo,
            travel_back_minutes: formData.travelBack,
            driver_to: formData.travelTo === null ? null : formData.driverTo,
            driver_back: formData.travelBack === null ? null : formData.driverBack,
            reminder_30min: formData.reminder_30min,
            reminder_1hour: formData.reminder_1hour,
            rrule: buildRRule(formData.recurrence),
        };

        setSaving(true);
        try {
            if (editingId) {
                await api.put(`/api/events/${editingId}`, payload);
            } else {
                await api.post('/api/events', payload);
            }
            setDialogOpen(false);
            setPersonInput('');
            void loadEvents();
        } catch (err) {
            console.error('Failed to save event:', err);
            setError(err instanceof Error ? err.message : t('calendar:errors.save'));
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (occ: EventOccurrence) => {
        const message = occ.is_recurring
            ? `${t('calendar:confirmDelete')} ${t('calendar:deleteRecurringHint')}`
            : t('calendar:confirmDelete');
        if (!window.confirm(message)) return;
        try {
            await api.delete(`/api/events/${occ.id}`);
            setSelected(null);
            setDialogOpen(false);
            void loadEvents();
        } catch (err) {
            console.error('Failed to delete event:', err);
            setError(err instanceof Error ? err.message : t('calendar:errors.delete'));
        }
    };

    // ── Occurrence unique d'une serie ─────────────────────────────────────────
    // L'occurrence est identifiee par son jour d'origine : c'est la cle sous
    // laquelle le serveur range l'exception, meme apres un deplacement.
    const skipOccurrence = async (occ: EventOccurrence) => {
        if (!window.confirm(t('calendar:occurrence.confirmSkip'))) return;
        setOccurrenceBusy(true);
        try {
            await api.put(`/api/events/${occ.id}/occurrences/${occ.occurrence_date}`, { action: 'skip' });
            setSelected(null);
            setError('');
            void loadEvents();
        } catch (err) {
            console.error('Failed to skip occurrence:', err);
            setError(err instanceof Error ? err.message : t('calendar:errors.skipOccurrence'));
        } finally {
            setOccurrenceBusy(false);
        }
    };

    const restoreOccurrence = async (occ: EventOccurrence) => {
        setOccurrenceBusy(true);
        try {
            await api.delete(`/api/events/${occ.id}/occurrences/${occ.occurrence_date}`);
            setSelected(null);
            setError('');
            void loadEvents();
        } catch (err) {
            console.error('Failed to restore occurrence:', err);
            setError(err instanceof Error ? err.message : t('calendar:errors.restoreOccurrence'));
        } finally {
            setOccurrenceBusy(false);
        }
    };

    const openMove = (occ: EventOccurrence) => {
        setSelected(null);
        setMoveTarget(occ);
        setMoveDate(occ.start_time.slice(0, 10));
        setMoveTime(timeOf(occ.start_time));
        setError('');
    };

    const submitMove = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!moveTarget) return;
        if (!moveDate || !moveTime) {
            setError(t('calendar:errors.startRequired'));
            return;
        }

        const start = parseISO(`${moveDate}T${moveTime}:00`);
        // On reporte la duree de l'occurrence pour que le creneau reste le meme
        // une fois deplace ; sans heure de fin, l'evenement reste ponctuel.
        const duration = moveTarget.end_time
            ? differenceInMinutes(parseISO(moveTarget.end_time), parseISO(moveTarget.start_time))
            : 0;

        setOccurrenceBusy(true);
        try {
            await api.put(`/api/events/${moveTarget.id}/occurrences/${moveTarget.occurrence_date}`, {
                action: 'move',
                start_time: toNaiveLocal(start),
                end_time: duration > 0 ? toNaiveLocal(addMinutes(start, duration)) : null,
            });
            setMoveTarget(null);
            setError('');
            void loadEvents();
        } catch (err) {
            console.error('Failed to move occurrence:', err);
            setError(err instanceof Error ? err.message : t('calendar:errors.moveOccurrence'));
        } finally {
            setOccurrenceBusy(false);
        }
    };

    const addPerson = () => {
        setFormData((prev) => ({ ...prev, ...addParticipant(prev, personInput, members) }));
        setPersonInput('');
    };

    const removeMember = (memberId: string) => {
        setFormData((prev) => ({ ...prev, member_ids: prev.member_ids.filter((id) => id !== memberId) }));
    };

    const removeGuest = (name: string) => {
        setFormData((prev) => ({ ...prev, guests: prev.guests.filter((g) => g !== name) }));
    };

    // Der Fahrer der Hinfahrt gilt auch für die Rückfahrt, bis diese von Hand geändert wird.
    const setDriverTo = (value: string) => {
        setFormData((prev) => ({
            ...prev,
            driverTo: value,
            driverBack: prev.driverBackEdited ? prev.driverBack : value,
        }));
    };

    const toggleByDay = (code: string) => {
        setFormData((prev) => ({
            ...prev,
            recurrence: {
                ...prev.recurrence,
                byDays: prev.recurrence.byDays.includes(code)
                    ? prev.recurrence.byDays.filter((c) => c !== code)
                    : [...prev.recurrence.byDays, code],
            },
        }));
    };

    // ── iCal feed ─────────────────────────────────────────────────────────────
    // Le flux est servi par l'API, qui peut avoir son propre domaine (voir lib/serverUrl).
    const feedUrl = feedToken ? serverUrl(API_BASE_URL, window.location.origin, `/api/calendar/feed/${feedToken}.ics`) : '';
    const feedWebcalUrl = feedUrl.replace(/^https?:\/\//, 'webcal://');

    const generateFeedToken = async () => {
        if (feedToken && !window.confirm(t('calendar:feed.confirmRegen'))) return;
        setFeedBusy(true);
        try {
            const response = await api.post<{ success: boolean; data: { token: string } }>('/api/calendar/token', {});
            if (response.success) {
                setFeedToken(response.data.token);
                setFeedCopied(false);
            }
        } catch (err) {
            console.error('Failed to generate calendar token:', err);
            setError(err instanceof Error ? err.message : t('calendar:errors.feed'));
        } finally {
            setFeedBusy(false);
        }
    };

    const copyFeedUrl = async () => {
        try {
            await navigator.clipboard.writeText(feedUrl);
            setFeedCopied(true);
            setTimeout(() => setFeedCopied(false), 2000);
        } catch {
            /* clipboard unavailable */
        }
    };

    // ── Rendering helpers ─────────────────────────────────────────────────────
    const occurrenceTimeRange = (occ: EventOccurrence) =>
        occ.end_time ? `${formatClock(occ.start_time)} - ${formatClock(occ.end_time)}` : formatClock(occ.start_time);

    // Fork: Uhrzeit "HH:mm" eines Tages in der Schreibweise der Sprache.
    const clockAt = (day: string, clock: string) => formatClock(`${day}T${clock}:00`);

    /** Hin- und Rückfahrt eines Termins als lesbare Zeilen (leer, wenn keine Fahrt). */
    const travelLines = (occ: EventOccurrence): { key: string; text: string; driver: string }[] => {
        const lines: { key: string; text: string; driver: string }[] = [];
        const day = occ.start_time.slice(0, 10);
        if (occ.travel_to_minutes) {
            lines.push({
                key: 'to',
                text: t('calendar:card.travelTo', {
                    from: clockAt(day, shiftClock(timeOf(occ.start_time), -occ.travel_to_minutes)),
                    to: formatClock(occ.start_time),
                }),
                driver: occ.driver_to || '',
            });
        }
        if (occ.travel_back_minutes) {
            const base = occ.end_time || occ.start_time;
            lines.push({
                key: 'back',
                text: t('calendar:card.travelBack', {
                    from: formatClock(base),
                    to: clockAt(base.slice(0, 10), shiftClock(timeOf(base), occ.travel_back_minutes)),
                }),
                driver: occ.driver_back || '',
            });
        }
        return lines;
    };

    /** Namen aller Teilnehmenden: Mitglieder des Kreises und frei eingetragene. */
    const participantNames = (occ: EventOccurrence): string[] => [
        ...(occ.members_data ?? []).map((m) => m.name),
        ...(occ.guests ?? []),
    ];

    /** Fahrzeit heller hinterlegt, mit Auto-Symbol und Fahrer. */
    const renderTravel = (occ: EventOccurrence) => {
        const lines = travelLines(occ);
        if (lines.length === 0) return null;
        return (
            <span className="mt-1.5 block space-y-1">
                {lines.map((line) => (
                    <span
                        key={line.key}
                        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-input bg-surface-2 px-2.5 py-1.5 text-caption text-muted-foreground"
                    >
                        <Car className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{line.text}</span>
                        {line.driver && <span>· {t('calendar:card.driver', { name: line.driver })}</span>}
                    </span>
                ))}
            </span>
        );
    };

    /** Eine Fahrt im Formular: Dauer in 15-Minuten-Schritten, Fahrer, Entfernen. */
    const renderTravelRow = (kind: 'to' | 'back') => {
        const minutes = kind === 'to' ? formData.travelTo : formData.travelBack;
        const field = kind === 'to' ? 'travelTo' : 'travelBack';
        const label = kind === 'to' ? t('calendar:form.travelTo') : t('calendar:form.travelBack');

        if (minutes === null) {
            return (
                <Button
                    type="button"
                    variant="secondary"
                    size="lg"
                    className="w-full justify-start"
                    onClick={() => setFormData((prev) => ({ ...prev, [field]: NEW_EVENT_TRAVEL_MINUTES }))}
                >
                    <Plus className="mr-2 h-5 w-5" aria-hidden="true" />
                    {kind === 'to' ? t('calendar:form.addTravelTo') : t('calendar:form.addTravelBack')}
                </Button>
            );
        }

        const startClock = formData.startTime || '00:00';
        const endClock = formData.endTime || startClock;
        const timeText = kind === 'to'
            ? t('calendar:form.travelToTime', { time: clockAt(formData.date, shiftClock(startClock, -minutes)) })
            : t('calendar:form.travelBackTime', { time: clockAt(formData.date, shiftClock(endClock, minutes)) });
        const driverId = `event-driver-${kind}`;

        return (
            <div className="space-y-3 rounded-input border border-border bg-surface-2/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-body font-medium text-foreground">
                        {label}
                        <span className="block text-caption font-normal text-muted-foreground">{timeText}</span>
                    </p>
                    <Button
                        type="button"
                        variant="ghost"
                        size="lg"
                        onClick={() => setFormData((prev) => ({ ...prev, [field]: null }))}
                    >
                        <X className="mr-2 h-5 w-5" aria-hidden="true" />
                        {kind === 'to' ? t('calendar:form.removeTravelTo') : t('calendar:form.removeTravelBack')}
                    </Button>
                </div>
                <div className="flex items-center gap-3" role="group" aria-label={label}>
                    <Button
                        type="button"
                        variant="secondary"
                        size="lg"
                        className="w-12 px-0"
                        aria-label={t('calendar:form.travelLess')}
                        disabled={minutes <= TRAVEL_MIN_MINUTES}
                        onClick={() => setFormData((prev) => ({ ...prev, [field]: stepTravel(minutes, -1) }))}
                    >
                        <Minus className="h-5 w-5" aria-hidden="true" />
                    </Button>
                    <span className="min-w-[8rem] text-center text-body font-semibold tabular-nums text-foreground" aria-live="polite">
                        {t('calendar:form.travelMinutes', { count: minutes })}
                    </span>
                    <Button
                        type="button"
                        variant="secondary"
                        size="lg"
                        className="w-12 px-0"
                        aria-label={t('calendar:form.travelMore')}
                        disabled={minutes >= TRAVEL_MAX_MINUTES}
                        onClick={() => setFormData((prev) => ({ ...prev, [field]: stepTravel(minutes, 1) }))}
                    >
                        <Plus className="h-5 w-5" aria-hidden="true" />
                    </Button>
                </div>
                <Input
                    id={driverId}
                    label={t('calendar:form.driver')}
                    value={kind === 'to' ? formData.driverTo : formData.driverBack}
                    onChange={(e) => {
                        const value = e.target.value;
                        if (kind === 'to') setDriverTo(value);
                        else setFormData((prev) => ({ ...prev, driverBack: value, driverBackEdited: true }));
                    }}
                    placeholder={t('calendar:form.personPlaceholder')}
                    list="event-person-suggestions"
                    autoComplete="off"
                />
                {kind === 'back' && !formData.endTime && (
                    <p className="text-caption text-muted-foreground">{t('calendar:form.travelBackNoEnd')}</p>
                )}
            </div>
        );
    };

    // ── Fork: Ansichten Tag und Woche ─────────────────────────────────────────
    const viewChoices: { key: CalendarView; label: string; icon: typeof CalendarDays }[] = [
        { key: 'day', label: t('calendar:view.day'), icon: CalendarCheck },
        { key: 'week', label: t('calendar:view.week'), icon: CalendarRange },
        { key: 'month', label: t('calendar:view.month'), icon: CalendarDays },
        { key: 'list', label: t('calendar:view.list'), icon: List },
    ];

    const stepPeriod = (direction: 1 | -1) => {
        setCurrentDate((prev) => {
            if (view === 'day') return addDays(prev, direction);
            if (view === 'week') return addWeeks(prev, direction);
            return direction === 1 ? addMonths(prev, 1) : subMonths(prev, 1);
        });
    };

    const navLabels = view === 'day'
        ? { prev: t('calendar:prevDay'), next: t('calendar:nextDay') }
        : view === 'week'
            ? { prev: t('calendar:prevWeek'), next: t('calendar:nextWeek') }
            : { prev: t('calendar:prevMonth'), next: t('calendar:nextMonth') };

    const periodTitle = view === 'day'
        ? format(currentDate, longDate(true), { locale: dateLocale() })
        : view === 'week'
            ? weekRangeLabel(weekStartDate, weekEndDate, i18n.language)
            : format(currentDate, 'MMMM yyyy', { locale: dateLocale() });

    const openDay = (day: Date) => {
        setCurrentDate(day);
        setView('day');
    };

    /** Woche: ein Feld pro Tag (Handy untereinander, ab Tablet nebeneinander). Tipp auf den Tag öffnet die Tagesansicht. */
    const renderWeekView = () => (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-7 md:gap-2">
            {weekDates.map((day, index) => {
                const key = format(day, 'yyyy-MM-dd');
                const dayOccurrences = [...(occurrencesByDay.get(key) ?? [])]
                    .sort((a, b) => a.start_time.localeCompare(b.start_time));
                const today = isToday(day);
                return (
                    <section
                        key={key}
                        className={cn('flex flex-col rounded-input border bg-card', today ? 'border-primary' : 'border-border')}
                    >
                        <button
                            type="button"
                            onClick={() => openDay(day)}
                            className="flex min-h-[48px] w-full items-center gap-2 rounded-t-input px-3 py-2 text-left transition-colors duration-fast hover:bg-surface-2/60"
                        >
                            <span className={cn('text-body font-semibold', today ? 'text-primary' : 'text-foreground')}>
                                {weekDays[index]}
                            </span>
                            <span
                                className={cn(
                                    'flex h-8 min-w-[2rem] items-center justify-center rounded-full px-1 text-body font-semibold tabular-nums',
                                    today ? 'bg-primary text-primary-foreground' : 'text-foreground'
                                )}
                            >
                                {format(day, 'd')}
                            </span>
                            <span className="sr-only">
                                {format(day, longDate(false), { locale: dateLocale() })}, {t('calendar:week.openDay')}
                            </span>
                        </button>
                        <div className="flex-1 space-y-1.5 px-2 pb-2">
                            {dayOccurrences.length === 0 ? (
                                <p className="px-1 py-1 text-caption text-muted-foreground">{t('calendar:week.noEvents')}</p>
                            ) : (
                                dayOccurrences.map((occ) => (
                                    <button
                                        type="button"
                                        key={`${occ.id}-${occ.occurrence_date}-${occ.start_time}`}
                                        onClick={() => setSelected(occ)}
                                        className={cn(
                                            'block min-h-[48px] w-full rounded-input px-2 py-1.5 text-left transition-colors duration-fast hover:opacity-80',
                                            CATEGORY_CHIP[occ.category]
                                        )}
                                    >
                                        <span className="flex items-center gap-1.5 text-caption tabular-nums text-muted-foreground">
                                            <CategoryDot category={occ.category} />
                                            {occurrenceTimeRange(occ)}
                                        </span>
                                        <span className="block text-caption font-medium text-foreground">{occ.title}</span>
                                        {(occ.travel_to_minutes || occ.travel_back_minutes) ? (
                                            <span className="mt-0.5 flex items-center gap-1.5 text-caption text-muted-foreground">
                                                <Car className="h-4 w-4 shrink-0" aria-hidden="true" />
                                                {t('calendar:week.withTravel')}
                                            </span>
                                        ) : null}
                                    </button>
                                ))
                            )}
                        </div>
                    </section>
                );
            })}
        </div>
    );

    /** Tag: Zeitleiste mit Stunden. Fahrzeit als heller Block vor und nach dem Termin. */
    const renderDayView = () => {
        const key = format(currentDate, 'yyyy-MM-dd');
        const blocks = layoutDay(occurrencesByDay.get(key) ?? []);
        const firstHour = Math.min(DAY_FIRST_HOUR, ...blocks.map((b) => Math.floor(b.from / 60)));
        const lastHour = Math.min(24, Math.max(DAY_LAST_HOUR, ...blocks.map((b) => Math.ceil(b.to / 60))));
        const px = (minutes: number) => (minutes / 60) * DAY_HOUR_PX;
        const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, i) => firstHour + i);

        return (
            <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="lg" onClick={() => setView('week')}>
                        <CalendarRange className="mr-2 h-5 w-5" aria-hidden="true" />
                        {t('calendar:day.backToWeek')}
                    </Button>
                </div>
                {blocks.length === 0 && (
                    <div className="rounded-card border border-dashed border-border-strong px-6 py-6 text-center">
                        <p className="text-body text-muted-foreground">{t('calendar:day.empty')}</p>
                        {canCreate && (
                            <Button variant="secondary" size="lg" className="mt-4" onClick={() => openCreate(currentDate)}>
                                <Plus className="mr-2 h-5 w-5" aria-hidden="true" />
                                {t('calendar:newEvent')}
                            </Button>
                        )}
                    </div>
                )}
                <div className="flex" style={{ height: px((lastHour - firstHour) * 60) + 12 }}>
                    <div className="relative w-14 shrink-0" aria-hidden="true">
                        {hours.map((hour) => (
                            <span
                                key={hour}
                                className="absolute right-2 -translate-y-1/2 text-caption tabular-nums text-muted-foreground"
                                style={{ top: px((hour - firstHour) * 60) + 6 }}
                            >
                                {clockAt(key, `${String(hour % 24).padStart(2, '0')}:00`)}
                            </span>
                        ))}
                    </div>
                    <div className="relative flex-1 border-l border-border" style={{ marginTop: 6 }}>
                        {hours.map((hour) => (
                            <div
                                key={hour}
                                className="absolute inset-x-0 border-t border-border"
                                style={{ top: px((hour - firstHour) * 60) }}
                                aria-hidden="true"
                            />
                        ))}
                        {blocks.map((block) => {
                            const { occ } = block;
                            const travel = travelLines(occ);
                            const toLine = travel.find((line) => line.key === 'to');
                            const backLine = travel.find((line) => line.key === 'back');
                            return (
                                <button
                                    type="button"
                                    key={`${occ.id}-${occ.occurrence_date}-${occ.start_time}`}
                                    onClick={() => setSelected(occ)}
                                    className="absolute flex flex-col overflow-hidden rounded-input border border-border bg-card text-left shadow-sm transition-opacity duration-fast hover:opacity-90"
                                    style={{
                                        top: px(block.from - firstHour * 60),
                                        height: px(block.to - block.from),
                                        left: `calc(${(block.lane / block.lanes) * 100}% + 4px)`,
                                        width: `calc(${100 / block.lanes}% - 8px)`,
                                    }}
                                >
                                    {block.travelTo > 0 && toLine && (
                                        <span
                                            className="flex shrink-0 items-center gap-1.5 overflow-hidden border-b border-dashed border-border-strong bg-surface-2 px-2 text-caption text-muted-foreground"
                                            style={{ height: px(block.travelTo) }}
                                        >
                                            <Car className="h-4 w-4 shrink-0" aria-hidden="true" />
                                            <span className="truncate">
                                                {toLine.text}
                                                {toLine.driver ? ` · ${t('calendar:card.driver', { name: toLine.driver })}` : ''}
                                            </span>
                                        </span>
                                    )}
                                    <span
                                        className={cn('block shrink-0 overflow-hidden px-2 py-1', CATEGORY_CHIP[occ.category])}
                                        style={{ height: px(block.eventMinutes) }}
                                    >
                                        <span className="flex items-center gap-1.5 text-caption tabular-nums text-muted-foreground">
                                            <CategoryDot category={occ.category} />
                                            {occurrenceTimeRange(occ)}
                                            {occ.is_recurring && (
                                                <Repeat className="h-4 w-4 shrink-0" aria-label={t('calendar:recurring')} />
                                            )}
                                        </span>
                                        <span className="block truncate text-body font-medium text-foreground">{occ.title}</span>
                                        {occ.location && (
                                            <span className="flex items-center gap-1.5 truncate text-caption text-muted-foreground">
                                                <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
                                                <span className="truncate">{occ.location}</span>
                                            </span>
                                        )}
                                    </span>
                                    {block.travelBack > 0 && backLine && (
                                        <span
                                            className="flex shrink-0 items-center gap-1.5 overflow-hidden border-t border-dashed border-border-strong bg-surface-2 px-2 text-caption text-muted-foreground"
                                            style={{ height: px(block.travelBack) }}
                                        >
                                            <Car className="h-4 w-4 shrink-0" aria-hidden="true" />
                                            <span className="truncate">
                                                {backLine.text}
                                                {backLine.driver ? ` · ${t('calendar:card.driver', { name: backLine.driver })}` : ''}
                                            </span>
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>
        );
    };

    if (loading && occurrences.length === 0) {
        return (
            <div className="flex h-full min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="font-medium text-muted-foreground animate-pulse">{t('calendar:loading')}</p>
                </div>
            </div>
        );
    }

    const recipientName = activeCircle?.recipient_first_name || activeCircle?.name || '';

    return (
        <div className="mx-auto max-w-6xl space-y-6">
            {error && !dialogOpen && !selected && !moveTarget ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            {/* Header */}
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                    <h1 className="mb-1 text-h1">{t('calendar:title')}</h1>
                    <p className="text-body text-muted-foreground">
                        {recipientName ? t('calendar:subtitle', { name: recipientName }) : t('calendar:subtitleNoName')}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <div className="flex overflow-hidden rounded-input border border-border" role="group" aria-label={t('calendar:view.label')}>
                        {viewChoices.map((choice, index) => {
                            const Icon = choice.icon;
                            return (
                                <button
                                    key={choice.key}
                                    type="button"
                                    onClick={() => setView(choice.key)}
                                    aria-pressed={view === choice.key}
                                    className={cn(
                                        'flex min-h-[48px] items-center gap-1.5 px-3 text-caption font-medium transition-colors duration-fast',
                                        index > 0 && 'border-l border-border',
                                        view === choice.key ? 'bg-primary-soft text-primary' : 'bg-surface text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    <Icon className="h-4 w-4" aria-hidden="true" />
                                    {choice.label}
                                </button>
                            );
                        })}
                    </div>
                    {canCreate && (
                        <Button onClick={() => openCreate(view === 'day' ? currentDate : undefined)}>
                            <Plus className="mr-2 h-4 w-4" />
                            {t('calendar:newEvent')}
                        </Button>
                    )}
                </div>
            </div>

            {/* Month navigation */}
            <Card>
                <CardContent className="p-4 md:p-6">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-h2 font-semibold capitalize">
                            {periodTitle}
                        </h2>
                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                size="icon"
                                aria-label={navLabels.prev}
                                onClick={() => stepPeriod(-1)}
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => setCurrentDate(new Date())}>
                                {t('common:actions.today')}
                            </Button>
                            <Button
                                variant="secondary"
                                size="icon"
                                aria-label={navLabels.next}
                                onClick={() => stepPeriod(1)}
                            >
                                <ChevronRight className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>

                    {view === 'day' ? renderDayView() : view === 'week' ? renderWeekView() : view === 'month' ? (
                        <div className="grid grid-cols-7 gap-1.5">
                            {weekDays.map((day) => (
                                <div key={day} className="py-2 text-center text-label font-semibold text-muted-foreground">
                                    {day}
                                </div>
                            ))}
                            {calendarDays.map((day) => {
                                const key = format(day, 'yyyy-MM-dd');
                                const dayOccurrences = occurrencesByDay.get(key) ?? [];
                                const inMonth = isSameMonth(day, currentDate);
                                const today = isToday(day);

                                return (
                                    <div
                                        key={key}
                                        onClick={() => canCreate && inMonth && openCreate(day)}
                                        className={cn(
                                            'min-h-[92px] rounded-input border p-1.5 transition-colors duration-fast',
                                            inMonth ? 'bg-card' : 'bg-surface-2/60 opacity-60',
                                            today ? 'border-primary' : 'border-border',
                                            canCreate && inMonth && 'cursor-pointer hover:bg-surface-2/60'
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                'mb-1 flex h-6 w-6 items-center justify-center rounded-full text-caption font-medium',
                                                today ? 'bg-primary text-primary-foreground' : inMonth ? 'text-foreground' : 'text-muted-foreground'
                                            )}
                                        >
                                            {format(day, 'd')}
                                        </span>
                                        <div className="space-y-1">
                                            {dayOccurrences.slice(0, 3).map((occ) => (
                                                <button
                                                    type="button"
                                                    key={`${occ.id}-${occ.occurrence_date}-${occ.start_time}`}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setSelected(occ);
                                                    }}
                                                    title={isMovedOccurrence(occ) ? t('calendar:occurrence.movedBadge') : undefined}
                                                    className={cn(
                                                        'flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-micro text-foreground transition-colors duration-fast hover:opacity-80',
                                                        CATEGORY_CHIP[occ.category]
                                                    )}
                                                >
                                                    <CategoryDot category={occ.category} className="h-1.5 w-1.5" />
                                                    {isMovedOccurrence(occ) && (
                                                        <CalendarClock className="h-2.5 w-2.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                                    )}
                                                    <span className="truncate">
                                                        <span className="font-medium tabular-nums">{formatClock(occ.start_time)}</span> {occ.title}
                                                    </span>
                                                </button>
                                            ))}
                                            {dayOccurrences.length > 3 && (
                                                <p className="text-center text-micro text-muted-foreground">
                                                    {t('calendar:moreCount', { count: dayOccurrences.length - 3 })}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="space-y-5">
                            {listDays.length === 0 ? (
                                <div className="rounded-card border border-dashed border-border-strong px-6 py-10 text-center">
                                    <p className="text-body text-muted-foreground">{t('calendar:emptyMonth')}</p>
                                    {canCreate && (
                                        <Button variant="secondary" size="sm" className="mt-4" onClick={() => openCreate()}>
                                            <Plus className="mr-2 h-4 w-4" />
                                            {t('calendar:newEvent')}
                                        </Button>
                                    )}
                                </div>
                            ) : (
                                listDays.map((dayKey) => {
                                    const day = parseISO(dayKey);
                                    return (
                                        <section key={dayKey}>
                                            <h3
                                                className={cn(
                                                    'mb-2 text-caption font-semibold capitalize',
                                                    isToday(day) ? 'text-primary' : 'text-muted-foreground'
                                                )}
                                            >
                                                {format(day, longDate(false), { locale: dateLocale() })}
                                                {isToday(day) ? ` (${t('common:actions.today').toLowerCase()})` : ''}
                                            </h3>
                                            <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
                                                {(occurrencesByDay.get(dayKey) ?? []).map((occ) => (
                                                    <button
                                                        type="button"
                                                        key={`${occ.id}-${occ.occurrence_date}-${occ.start_time}`}
                                                        onClick={() => setSelected(occ)}
                                                        className="flex w-full min-h-[56px] items-start gap-3 px-4 py-3 text-left transition-colors duration-fast hover:bg-surface-2/60"
                                                    >
                                                        <CategoryDot category={occ.category} />
                                                        <span className="w-[88px] shrink-0 pt-0.5 text-caption tabular-nums text-muted-foreground">
                                                            {occurrenceTimeRange(occ)}
                                                        </span>
                                                        <span className="min-w-0 flex-1">
                                                            <span className="block text-body font-medium text-foreground">{occ.title}</span>
                                                            <span className="block text-caption text-muted-foreground">
                                                                {t(`calendar:categories.${occ.category}`)}
                                                            </span>
                                                            {occ.location && (
                                                                <span className="mt-0.5 flex items-start gap-1.5 text-caption text-muted-foreground">
                                                                    <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                                                    <span>{occ.location}</span>
                                                                </span>
                                                            )}
                                                            {participantNames(occ).length > 0 && (
                                                                <span className="mt-0.5 flex items-start gap-1.5 text-caption text-muted-foreground">
                                                                    <Users className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                                                    <span>{participantNames(occ).join(', ')}</span>
                                                                </span>
                                                            )}
                                                            {renderTravel(occ)}
                                                            {occ.notes && (
                                                                <span className="mt-1 block whitespace-pre-wrap text-caption text-foreground">{occ.notes}</span>
                                                            )}
                                                        </span>
                                                        {isMovedOccurrence(occ) && (
                                                            <CalendarClock
                                                                className="h-4 w-4 shrink-0 text-muted-foreground"
                                                                aria-label={t('calendar:occurrence.movedBadge')}
                                                            />
                                                        )}
                                                        {occ.is_recurring && (
                                                            <Repeat className="h-4 w-4 shrink-0 text-muted-foreground" aria-label={t('calendar:recurring')} />
                                                        )}
                                                    </button>
                                                ))}
                                            </div>
                                        </section>
                                    );
                                })
                            )}
                        </div>
                    )}

                    {/* Legend */}
                    <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4">
                        {CATEGORIES.map((category) => (
                            <span key={category} className="flex items-center gap-1.5 text-micro text-muted-foreground">
                                <CategoryDot category={category} />
                                {t(`calendar:categories.${category}`)}
                            </span>
                        ))}
                    </div>
                </CardContent>
            </Card>

            {/* Discreet iCal feed section */}
            <section className="rounded-card border border-border bg-surface-2/40 p-4">
                <div className="flex items-start gap-3">
                    <CalendarPlus className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                        <h2 className="text-caption font-semibold text-foreground">{t('calendar:feed.title')}</h2>
                        <p className="mt-0.5 text-micro text-muted-foreground">{t('calendar:feed.description')}</p>

                        {feedToken ? (
                            <div className="mt-3 space-y-2">
                                <div className="flex items-center gap-2">
                                    <input
                                        readOnly
                                        value={feedUrl}
                                        onFocus={(e) => e.target.select()}
                                        aria-label={t('calendar:feed.linkLabel')}
                                        className="min-w-0 flex-1 rounded-input border border-input bg-surface px-3 py-2 text-micro text-foreground"
                                    />
                                    <Button variant="secondary" size="icon" onClick={copyFeedUrl} aria-label={t('calendar:feed.copy')}>
                                        {feedCopied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                                    </Button>
                                </div>
                                <div className="flex flex-wrap items-center gap-3">
                                    <a
                                        href={feedWebcalUrl}
                                        className="text-micro font-medium text-primary underline-offset-4 hover:underline"
                                    >
                                        {t('calendar:feed.subscribe')}
                                    </a>
                                    <button
                                        type="button"
                                        onClick={generateFeedToken}
                                        disabled={feedBusy}
                                        className="flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground disabled:opacity-50"
                                    >
                                        <RefreshCw className="h-3 w-3" />
                                        {t('calendar:feed.regenerate')}
                                    </button>
                                </div>
                                <p className="text-micro text-muted-foreground">{t('calendar:feed.privateNote')}</p>
                            </div>
                        ) : (
                            <Button variant="secondary" size="sm" className="mt-3" onClick={generateFeedToken} disabled={feedBusy}>
                                {t('calendar:feed.generate')}
                            </Button>
                        )}
                    </div>
                </div>
            </section>

            {/* Detail dialog (read-only view, actions when allowed) */}
            <Dialog
                open={selected !== null}
                onOpenChange={(open) => { if (!open) setSelected(null); }}
                title={selected?.title ?? ''}
                description={selected ? t(`calendar:categories.${selected.category}`) : undefined}
            >
                {selected && (
                    <div className="space-y-4">
                        {error && (
                            <div className="rounded-input border border-danger/30 bg-danger/10 px-3 py-2 text-caption text-danger">
                                {error}
                            </div>
                        )}
                        <div className="flex items-center gap-2 text-caption text-foreground">
                            <CategoryDot category={selected.category} />
                            <span className="capitalize">
                                {format(parseISO(selected.start_time), longDate(true), { locale: dateLocale() })}
                            </span>
                        </div>
                        <div className="flex items-center gap-2 text-caption text-muted-foreground">
                            <Clock className="h-4 w-4" />
                            {occurrenceTimeRange(selected)}
                            {selected.is_recurring && (
                                <span className="flex items-center gap-1">
                                    <Repeat className="h-3.5 w-3.5" />
                                    {t('calendar:recurring')}
                                </span>
                            )}
                        </div>
                        {isMovedOccurrence(selected) && (
                            <p className="rounded-input bg-info/10 px-3 py-2 text-micro text-foreground">
                                {t('calendar:occurrence.movedFrom', {
                                    date: format(parseISO(selected.occurrence_date), longDate(false), { locale: dateLocale() }),
                                })}
                            </p>
                        )}
                        {selected.location && (
                            <div className="flex items-center gap-2 text-caption text-muted-foreground">
                                <MapPin className="h-4 w-4" />
                                {selected.location}
                            </div>
                        )}
                        {participantNames(selected).length > 0 && (
                            <div className="flex items-start gap-2 text-caption text-muted-foreground">
                                <Users className="mt-0.5 h-4 w-4 shrink-0" />
                                <span className="flex flex-wrap gap-1.5">
                                    {(selected.members_data ?? []).map((member) => (
                                        <span
                                            key={member.id}
                                            className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface-2 px-2.5 py-0.5 text-micro text-foreground"
                                        >
                                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: member.color }} />
                                            {member.name}
                                        </span>
                                    ))}
                                    {(selected.guests ?? []).map((name) => (
                                        <span
                                            key={`g-${name}`}
                                            className="inline-flex items-center rounded-pill border border-border bg-surface-2 px-2.5 py-0.5 text-micro text-foreground"
                                        >
                                            {name}
                                        </span>
                                    ))}
                                </span>
                            </div>
                        )}
                        {renderTravel(selected)}
                        {(selected.reminder_30min || selected.reminder_1hour) && (
                            <div className="flex items-center gap-2 text-caption text-muted-foreground">
                                <Bell className="h-4 w-4" />
                                {[
                                    selected.reminder_30min
                                        ? t(selected.travel_to_minutes ? 'calendar:form.reminder30Departure' : 'calendar:form.reminder30')
                                        : null,
                                    selected.reminder_1hour
                                        ? t(selected.travel_to_minutes ? 'calendar:form.reminder1hDeparture' : 'calendar:form.reminder1h')
                                        : null,
                                ].filter(Boolean).join(' · ')}
                            </div>
                        )}
                        {selected.notes && (
                            <p className="whitespace-pre-wrap rounded-input bg-surface-2/60 p-3 text-caption text-foreground">
                                {selected.notes}
                            </p>
                        )}
                        {canManage(selected) && selected.is_recurring && (
                            <div className="border-t border-border pt-4">
                                <p className="mb-2 text-label font-medium text-foreground">
                                    {t('calendar:occurrence.sectionTitle')}
                                </p>
                                <p className="mb-2 text-micro text-muted-foreground">
                                    {t('calendar:occurrence.sectionHint')}
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={occurrenceBusy}
                                        onClick={() => openMove(selected)}
                                    >
                                        <CalendarClock className="mr-2 h-4 w-4" />
                                        {t('calendar:occurrence.move')}
                                    </Button>
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={occurrenceBusy}
                                        onClick={() => void skipOccurrence(selected)}
                                    >
                                        <CalendarOff className="mr-2 h-4 w-4" />
                                        {t('calendar:occurrence.skip')}
                                    </Button>
                                    {isMovedOccurrence(selected) && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={occurrenceBusy}
                                            onClick={() => void restoreOccurrence(selected)}
                                        >
                                            <Undo2 className="mr-2 h-4 w-4" />
                                            {t('calendar:occurrence.restore')}
                                        </Button>
                                    )}
                                </div>
                            </div>
                        )}
                        {canManage(selected) && (
                            <div className="border-t border-border pt-4">
                                {selected.is_recurring && (
                                    <p className="mb-2 text-label font-medium text-foreground">
                                        {t('calendar:occurrence.seriesTitle')}
                                    </p>
                                )}
                                <div className="flex justify-end gap-2">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                        onClick={() => void handleDelete(selected)}
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        {t('common:actions.delete')}
                                    </Button>
                                    <Button variant="secondary" size="sm" onClick={() => openEdit(selected)}>
                                        <Edit2 className="mr-2 h-4 w-4" />
                                        {t('common:actions.edit')}
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </Dialog>

            {/* Deplacement d'une seule occurrence */}
            <Dialog
                open={moveTarget !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setMoveTarget(null);
                        setError('');
                    }
                }}
                title={t('calendar:occurrence.moveTitle')}
                description={moveTarget?.title}
            >
                {moveTarget && (
                    <form onSubmit={submitMove} className="space-y-4">
                        {error && (
                            <div className="rounded-input border border-danger/30 bg-danger/10 px-3 py-2 text-caption text-danger">
                                {error}
                            </div>
                        )}
                        <p className="text-caption text-muted-foreground">
                            {t('calendar:occurrence.moveDescription')}
                        </p>
                        <div className="grid grid-cols-1 gap-3 rounded-input border border-border bg-surface-2/40 p-3 sm:grid-cols-2">
                            <DatePicker
                                label={t('calendar:form.date')}
                                value={moveDate}
                                min={format(subDays(parseISO(moveTarget.occurrence_date), MOVE_MAX_DAYS), 'yyyy-MM-dd')}
                                max={format(addDays(parseISO(moveTarget.occurrence_date), MOVE_MAX_DAYS), 'yyyy-MM-dd')}
                                onChange={setMoveDate}
                            />
                            <DatePicker
                                label={t('calendar:form.startTime')}
                                type="time"
                                value={moveTime}
                                onChange={setMoveTime}
                            />
                        </div>
                        <p className="text-micro text-muted-foreground">
                            {t('calendar:occurrence.moveLimit', { days: MOVE_MAX_DAYS })}
                            {moveTarget.end_time ? ` ${t('calendar:occurrence.keepsDuration')}` : ''}
                        </p>
                        <div className="flex justify-end gap-3 pt-2">
                            <Button type="button" variant="secondary" onClick={() => setMoveTarget(null)}>
                                {t('common:actions.cancel')}
                            </Button>
                            <Button type="submit" disabled={occurrenceBusy}>
                                {t('calendar:occurrence.moveConfirm')}
                            </Button>
                        </div>
                    </form>
                )}
            </Dialog>

            {/* Create / edit dialog */}
            <Dialog
                open={dialogOpen}
                onOpenChange={(open) => {
                    setDialogOpen(open);
                    if (!open) {
                        setEditingId(null);
                        setError('');
                    }
                }}
                title={editingId ? t('calendar:dialog.editTitle') : t('calendar:dialog.createTitle')}
                description={t('calendar:dialog.description')}
            >
                <form onSubmit={handleSubmit} className="space-y-5" noValidate>
                    <div role="alert" aria-live="assertive">
                        {error && (
                            <div className="rounded-input border border-danger/30 bg-danger/10 px-3 py-2 text-body text-danger">
                                {error}
                            </div>
                        )}
                    </div>
                    {editingId && editingRecurring && (
                        <p className="rounded-input bg-info/10 px-3 py-2 text-caption text-foreground">
                            {t('calendar:dialog.editRecurringHint')}
                        </p>
                    )}

                    {/* 1. Name */}
                    <Input
                        label={t('calendar:form.title')}
                        value={formData.title}
                        onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                        required
                        placeholder={t('calendar:form.titlePlaceholder')}
                    />

                    {/* Ort direkt unter dem Titel */}
                    <Input
                        id="event-location"
                        label={t('calendar:form.location')}
                        value={formData.location}
                        onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                        placeholder={t('calendar:form.locationPlaceholder')}
                    />

                    {/* 2. Beginn: Datum und Uhrzeit */}
                    <fieldset className="rounded-input border border-border bg-surface-2/40 p-3">
                        <legend className="px-1 text-label font-medium text-foreground">{t('calendar:form.start')}</legend>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <DatePicker
                                label={t('calendar:form.date')}
                                value={formData.date}
                                onChange={(value) => setFormData({ ...formData, date: value })}
                            />
                            <DatePicker
                                label={t('calendar:form.startTime')}
                                type="time"
                                value={formData.startTime}
                                onChange={(value) => setFormData({ ...formData, startTime: value })}
                            />
                        </div>
                        <p className="mt-3 flex items-center gap-2 text-caption text-muted-foreground">
                            <Bell className="h-4 w-4 shrink-0" aria-hidden="true" />
                            {!formData.reminder_1hour
                                ? t('calendar:form.reminderDefaultOff')
                                : formData.travelTo !== null
                                    ? t('calendar:form.reminderDepartureOn')
                                    : t('calendar:form.reminderDefaultOn')}
                        </p>
                    </fieldset>

                    {/* 3. Kategorie: grosse Auswahl mit Text */}
                    <fieldset>
                        <legend className="mb-2 text-label font-medium text-foreground">{t('calendar:form.category')}</legend>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {categoryChoices.map((category) => {
                                const active = formData.category === category;
                                return (
                                    <label
                                        key={category}
                                        className={cn(
                                            'flex min-h-[48px] cursor-pointer items-center gap-2.5 rounded-input border px-3 py-2 text-body transition-colors duration-fast',
                                            'focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2',
                                            active ? 'border-primary bg-primary-soft font-medium text-foreground' : 'border-border bg-surface text-foreground hover:border-border-strong'
                                        )}
                                    >
                                        <input
                                            type="radio"
                                            name="event-category"
                                            value={category}
                                            checked={active}
                                            onChange={() => setFormData({ ...formData, category })}
                                            className="sr-only"
                                        />
                                        <CategoryDot category={category} className="h-3 w-3" />
                                        <span>{t(`calendar:categories.${category}`)}</span>
                                        {active && <Check className="ml-auto h-4 w-4 text-primary" aria-hidden="true" />}
                                    </label>
                                );
                            })}
                        </div>
                    </fieldset>

                    {/* 4. Teilnehmende: Vorschläge aus Kreis und Kontakten, freie Namen erlaubt */}
                    <div>
                        <label htmlFor="event-person-input" className="mb-1.5 block text-label font-medium text-foreground">
                            {t('calendar:form.participants')}
                        </label>
                        <p id="event-person-hint" className="mb-2 text-caption text-muted-foreground">
                            {t('calendar:form.participantsHint')}
                        </p>
                        {(formData.member_ids.length > 0 || formData.guests.length > 0) && (
                            <ul className="mb-3 flex flex-wrap gap-2">
                                {formData.member_ids.map((id) => {
                                    const member = members.find((m) => m.id === id);
                                    if (!member) return null;
                                    return (
                                        <li key={`m-${id}`} className="inline-flex min-h-[48px] items-center gap-2 rounded-pill border border-border bg-surface-2 pl-3 pr-1 text-body text-foreground">
                                            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: member.color }} aria-hidden="true" />
                                            {member.name}
                                            <button
                                                type="button"
                                                onClick={() => removeMember(id)}
                                                aria-label={t('calendar:form.removePerson', { name: member.name })}
                                                className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-surface hover:text-foreground"
                                            >
                                                <X className="h-5 w-5" aria-hidden="true" />
                                            </button>
                                        </li>
                                    );
                                })}
                                {formData.guests.map((name) => (
                                    <li key={`g-${name}`} className="inline-flex min-h-[48px] items-center gap-2 rounded-pill border border-border bg-surface-2 pl-3 pr-1 text-body text-foreground">
                                        {name}
                                        <button
                                            type="button"
                                            onClick={() => removeGuest(name)}
                                            aria-label={t('calendar:form.removePerson', { name })}
                                            className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-surface hover:text-foreground"
                                        >
                                            <X className="h-5 w-5" aria-hidden="true" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div className="flex gap-2">
                            <input
                                id="event-person-input"
                                value={personInput}
                                onChange={(e) => setPersonInput(e.target.value)}
                                onKeyDown={(e) => {
                                    // Enter fügt hinzu, statt das Formular abzuschicken.
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        addPerson();
                                    }
                                }}
                                placeholder={t('calendar:form.personPlaceholder')}
                                list="event-person-suggestions"
                                autoComplete="off"
                                aria-describedby="event-person-hint"
                                className="input-nexus min-w-0 flex-1"
                            />
                            <Button type="button" variant="secondary" size="lg" onClick={addPerson} disabled={!personInput.trim()}>
                                <Plus className="mr-2 h-5 w-5" aria-hidden="true" />
                                {t('calendar:form.addPerson')}
                            </Button>
                        </div>
                    </div>

                    {/* 5. Fahrt: Hin- und Rückfahrt, je einzeln entfernbar */}
                    <fieldset className="space-y-3">
                        <legend className="mb-2 flex items-center gap-2 text-label font-medium text-foreground">
                            <Car className="h-5 w-5" aria-hidden="true" />
                            {t('calendar:form.travel')}
                        </legend>
                        {renderTravelRow('to')}
                        {renderTravelRow('back')}
                    </fieldset>

                    <datalist id="event-person-suggestions">
                        {personSuggestions.map((person) => (
                            <option key={person.key} value={person.name}>{person.hint}</option>
                        ))}
                    </datalist>

                    {/* Alles Weitere aufklappbar */}
                    <div>
                        <Button
                            type="button"
                            variant="secondary"
                            className="w-full justify-between"
                            aria-expanded={showMore}
                            aria-controls="event-more-details"
                            onClick={() => setShowMore((v) => !v)}
                        >
                            <span>{showMore ? t('calendar:form.lessDetails') : t('calendar:form.moreDetails')}</span>
                            <ChevronRight className={cn('h-5 w-5 transition-transform duration-fast', showMore && 'rotate-90')} aria-hidden="true" />
                        </Button>
                    </div>

                    {showMore && (
                    <div id="event-more-details" className="space-y-4">
                    <DatePicker
                        label={t('calendar:form.endTime')}
                        type="time"
                        value={formData.endTime}
                        onChange={(value) => setFormData({ ...formData, endTime: value })}
                    />

                    {/* Simple recurrence */}
                    <div className="rounded-input border border-border bg-surface-2/40 p-3">
                        <label className="mb-1.5 block text-caption font-medium text-foreground">
                            {t('calendar:form.repeat')}
                        </label>
                        <Select
                            value={formData.recurrence.freq}
                            onValueChange={(value) =>
                                setFormData({
                                    ...formData,
                                    recurrence: { ...formData.recurrence, freq: value as RecurrenceForm['freq'] },
                                })
                            }
                            options={[
                                { value: '', label: t('calendar:form.repeatNone') },
                                { value: 'DAILY', label: t('calendar:form.repeatDaily') },
                                { value: 'WEEKLY', label: t('calendar:form.repeatWeekly') },
                                { value: 'MONTHLY', label: t('calendar:form.repeatMonthly') },
                            ]}
                        />
                        {formData.recurrence.freq === 'WEEKLY' && (
                            <div className="mt-3">
                                <p className="mb-1.5 text-micro text-muted-foreground">{t('calendar:form.repeatDays')}</p>
                                <div className="flex flex-wrap gap-1.5">
                                    {orderedIsoDays(weekStart).map((isoDay) => {
                                        const index = isoDay - 1;
                                        const code = RRULE_DAY_CODES[index];
                                        const active = formData.recurrence.byDays.includes(code);
                                        return (
                                            <button
                                                type="button"
                                                key={code}
                                                onClick={() => toggleByDay(code)}
                                                aria-pressed={active}
                                                aria-label={(t('common:days', { returnObjects: true }) as string[])[index]}
                                                className={cn(
                                                    'h-11 w-11 rounded-input border text-caption font-medium transition-colors duration-fast',
                                                    active
                                                        ? 'border-primary bg-primary-soft text-primary'
                                                        : 'border-border bg-surface text-muted-foreground hover:border-border-strong'
                                                )}
                                            >
                                                {dayLetters[index]}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        {formData.recurrence.freq !== '' && (
                            <div className="mt-3">
                                <DatePicker
                                    label={t('calendar:form.repeatUntil')}
                                    value={formData.recurrence.until}
                                    min={formData.date}
                                    onChange={(value) =>
                                        setFormData({
                                            ...formData,
                                            recurrence: { ...formData.recurrence, until: value },
                                        })
                                    }
                                />
                            </div>
                        )}
                    </div>

                    <div>
                        <p className="mb-1 text-label font-medium text-foreground">{t('calendar:form.reminders')}</p>
                        <div className="flex flex-wrap gap-x-6">
                            <Switch
                                checked={formData.reminder_30min}
                                onChange={(value) => setFormData({ ...formData, reminder_30min: value })}
                                label={t('calendar:form.reminder30')}
                            />
                            <Switch
                                checked={formData.reminder_1hour}
                                onChange={(value) => setFormData({ ...formData, reminder_1hour: value })}
                                label={t('calendar:form.reminder1h')}
                            />
                        </div>
                    </div>

                    <Textarea
                        label={t('calendar:form.notes')}
                        value={formData.notes}
                        onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                        placeholder={t('calendar:form.notesPlaceholder')}
                        rows={2}
                    />
                    </div>
                    )}

                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {editingId ? t('common:actions.save') : t('common:actions.create')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Calendar;
