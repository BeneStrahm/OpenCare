import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    CalendarDays, Check, CheckCheck, LogOut, MapPin, MessageCircle, Phone, Pill, RotateCcw,
    Settings as SettingsIcon, ThermometerSun, Users, Backpack, Car, Volume2, Square, X,
    Stethoscope, CalendarRange, CalendarClock, Droplet, Scale, HeartPulse, Sun, Moon, ChevronRight,
    IdCard, ShoppingCart, CalendarPlus, Plus, Activity, SkipForward, Bell,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import type { CircleSummary } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { formatClock, formatNumber, intlLocale } from '../i18n/format';
import { clockDate } from '../lib/clock';
import { SUPPORTED_LANGUAGES, LANGUAGE_NAMES } from '../i18n';
import { changeAppLanguage } from '../lib/language';
import { formatAmount } from '../lib/medications';
import { enabledVitalTypes, isFeatureEnabled, isViewTileOn, type FeatureId, type ViewTileId } from '../lib/features';
import { displayUnit, formatVital, toStorageValue } from '../lib/units';
import { cn } from '../lib/utils';
import { VIEW_COLORS, medicationColorOf, viewColorOf } from '../lib/viewColors';
import {
    FONT_SCALES, RECIPIENT_QUESTIONS, RECIPIENT_VITAL_TYPES, groupIntakes, isCompanionActive, isTravelActive, loadFontScale,
    effectiveDue, isOverdue, maySnooze, showOnHome, snoozeTarget,
    localDay, parseRecipientEventForm, parseRecipientVital, saveFontScale, type IntakeGroup, type RecipientQuestion, type RecipientVitalType,
} from '../lib/recipientView';

// Einfache Ansicht der betreuten Person (Rolle recipient), Launch Block C.
// Ersetzt die fruehere Tablet-Ansicht (Kiosk): gleiche ruhige Gestaltung (helle
// Kacheln, grosse Schrift, Atkinson Hyperlegible), aber mit dem eigenen Konto und
// nur ueber die normalen API-Routen, die middleware/circle.ts fuer recipient
// freigibt. Schreiben kann sie nur: Einnahmen als genommen bestaetigen und
// Blutzucker und Gewicht eintragen (Block K), beides mit Rueckgaengig, 10 Minuten. Kein Menue, keine anderen Seiten (App.tsx).
// Block M (E23): Medikamenten-Kachel oben auf der Startseite (ab 30 Minuten vor der Zeit
// bis Tagesende), mit Genommen, Ueberspringen und Spaeter erinnern.
// Palette fest und hell, wie zuvor im Kiosk: das dunkle Thema der App gilt hier nicht.
// blue, blueDark und blueSoft ersetzt die gewaehlte Farbe (Block D, lib/viewColors.ts).
const BASE = {
    bg: '#f5f7fb',
    card: '#ffffff',
    // Rand von Kacheln: gleicher Farbton wie vorher (#d5dbe6), dunkler, mind. 3:1 auf Weiss, bg und den hellen Flaechen
    border: '#7286ab',
    // Rand von Bedienelementen: mind. 3:1 auf Weiss und auf bg (WCAG 1.4.11)
    control: '#6b7484',
    text: '#1d2433',
    muted: '#5b6472',
    blue: '#1f4fd1',
    blueDark: '#1a3a9e',
    blueSoft: '#e8eefc',
    green: '#1f7a3a',
    greenSoft: '#e6f4ea',
    red: '#b42318',
    redSoft: '#fdecec',
    purple: '#5b3fb8',
    purpleSoft: '#efe9fb',
    amber: '#8a5a12',
    amberSoft: '#fdf3e7',
};

const HERO_IMAGE = `${import.meta.env.BASE_URL}hero.jpg`;

// ── Daten der normalen API-Routen ──

interface Intake {
    id: string;
    due_at: string;
    status: 'pending' | 'taken' | 'skipped' | 'missed';
    confirmed_at: string | null;
    quantity: number | string | null;
    unit: string | null;
    medication_name: string;
    medication_dosage: string | null;
    form: string | null;
    photo_url: string | null;
    prn: boolean;
    time_fixed?: boolean;
    instructions: string | null;
    with_food: 'with' | 'without' | 'any' | null;
    appearance: string | null;
    /** Block L2: Farbe des Medikaments (medications.view_color), null = neutrale Karte */
    medication_color?: string | null;
    /** Block M: verschobene Faelligkeit nach "Spaeter erinnern", Anzahl der Verschiebungen */
    snoozed_until?: string | null;
    snooze_count?: number | null;
    /** Vom Server: Restzeit fuer Rueckgaengig in ms (nur eigene Bestaetigung). */
    undo_ms_left?: number;
    /** Lokal: bis wann Rueckgaengig angeboten wird (Date.now()-Zeit). */
    undo_until?: number;
}

interface EventMember { id: string; name: string }
interface CalendarEvent {
    id: string;
    title: string;
    category: string;
    location: string | null;
    description: string | null;
    start_time: string;
    end_time: string | null;
    member_ids?: string[];
    members_data?: EventMember[];
    guests?: string[];
    companion_needed?: boolean | null;
    travel_needed?: boolean | null;
    travel_to_minutes?: number | null;
    travel_back_minutes?: number | null;
    driver_to?: string | null;
    driver_back?: string | null;
    take_along?: string | null;
}

interface Contact { id: string; name: string; category: string; phone: string | null; organization: string | null }
interface Heatwave { enabled: boolean; active: boolean; level: string | null }
/** Block E: offene Messwert-Erinnerung von heute (GET /api/vitals/reminders/today) */
interface OpenVitalReminder { type: 'glucose' | 'weight'; remind_time: string; note: string | null }
/** Block K: eigener Eintrag, noch rueckgaengig zu machen (GET /api/vitals/mine/undoable) */
interface OwnVital { id: string; type: RecipientVitalType; value: number; undo_ms_left: number; undo_until?: number }
/** Block K: Eingabe eines Messwerts, erst Zahl, dann Rueckfrage */
type VitalForm = { type: RecipientVitalType; step: 'enter' | 'confirm'; text: string; error: 'empty' | 'invalid' | null };

type Notice = { kind: 'ok' | 'error' | 'queued'; text: string } | null;

/** Block L3: eigener neuer Termin, noch rueckgaengig zu machen (GET /api/events/mine/undoable) */
interface OwnEvent { id: string; title: string; start_time: string; undo_ms_left: number; undo_until?: number }
/** Block L4: Eintrag der Einkaufsliste; Restzeiten fuer Rueckgaengig vom Server (nur eigene) */
interface ShoppingItem {
    id: string;
    name: string;
    quantity?: number | string | null;
    unit?: string | null;
    is_checked: boolean;
    added_undo_ms_left?: number;
    checked_undo_ms_left?: number;
    added_undo_until?: number;
    checked_undo_until?: number;
}
type ShopConfirm = { kind: 'add'; name: string } | { kind: 'check'; item: ShoppingItem } | null;

/** Block L3: neuer Termin, erst Angaben, dann Rueckfrage */
type EventForm = { step: 'enter' | 'confirm'; title: string; day: string; time: string; error: 'title' | 'date' | 'time' | null };

/** Block L1: Fenster, die eine Kachel oeffnet (immer nur eines zugleich). */
type WindowId = 'emergency' | 'meds' | 'health' | 'visitors' | 'appointments' | 'contacts' | 'ask' | 'info' | 'shopping' | 'settings';

/** Block L1: Meine Informationen (GET /api/circles/:id/recipient, fuer recipient nur Name, Adresse, Telefon). */
interface OwnInfo { first_name: string; last_name: string | null; address?: string | null; phone?: string | null }

/** Block D: Notfallblatt, dieselben Angaben wie der QR-Code (GET /api/emergency/payload). */
interface EmergencySheet {
    recipient: {
        first_name: string;
        last_name: string | null;
        birth_date: string | null;
        blood_type: string | null;
        allergies: string | null;
        medical_history: string | null;
        advance_directives: string | null;
        gp_name: string | null;
        gp_phone: string | null;
        insurance_info: string | null;
    } | null;
    medications: Array<{ name: string; dosage: string | null; form: string | null; schedules: Array<{ time: string }> }>;
    contacts: Array<{ name: string; category: string; organization: string | null; phone: string | null }>;
    extra_notes: string | null;
}

/** Block D: Fotos der Familie wechseln ruhig alle 20 Sekunden. */
const PHOTO_INTERVAL_MS = 20_000;
/** Block D: Tagesrueckblick ab 18 Uhr. */
const REVIEW_FROM_HOUR = 18;

/** Frage -> Text der Taste (companion:quick.*) und Funktion, ohne die es keine Antwort gibt. */
const QUESTION_INFO: Record<RecipientQuestion, { label: string; feature: FeatureId | null; Icon: React.FC<{ className?: string }> }> = {
    medications: { label: 'meds', feature: 'medications', Icon: Pill },
    visitors: { label: 'visitors', feature: 'calendar', Icon: Users },
    appointments: { label: 'appointments', feature: 'calendar', Icon: CalendarClock },
    week: { label: 'week', feature: 'calendar', Icon: CalendarRange },
    date: { label: 'date', feature: null, Icon: CalendarDays },
    contacts: { label: 'call', feature: 'contacts', Icon: Phone },
};

/** Rundes Foto, sonst der Anfangsbuchstabe. */
const PersonPhoto: React.FC<{ name: string; url: string | null; size: number; soft: string; strong: string }> = ({ name, url, size, soft, strong }) =>
    url ? (
        <img src={url} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size, border: `3px solid ${BASE.border}` }} />
    ) : (
        <div
            className="flex shrink-0 items-center justify-center rounded-full font-bold"
            style={{ width: size, height: size, backgroundColor: soft, color: strong, fontSize: size * 0.42 }}
            aria-hidden="true"
        >
            {(name.trim().charAt(0) || '?').toUpperCase()}
        </div>
    );

/**
 * Block L1: grosses Fenster ueber der ganzen Ansicht. Die Leiste oben bleibt beim
 * Blaettern stehen, damit "Schliessen" (grosses X mit Text) immer oben rechts zu sehen ist.
 */
const ViewWindow: React.FC<{
    id: string;
    title: string;
    icon: React.ReactNode;
    closeLabel: string;
    onClose: () => void;
    style: React.CSSProperties;
    titleStyle: React.CSSProperties;
    closeStyle: React.CSSProperties;
    barColor: string;
    barBorder: string;
    children: React.ReactNode;
}> = ({ id, title, icon, closeLabel, onClose, style, titleStyle, closeStyle, barColor, barBorder, children }) => (
    <div className="fixed inset-0 z-[70] overflow-y-auto font-kiosk" style={style} role="dialog" aria-modal="true" aria-labelledby={id}>
        <div className="sticky top-0 z-10" style={{ backgroundColor: barColor, borderBottom: `2px solid ${barBorder}` }}>
            <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
                <h2 id={id} className="flex min-w-0 items-center gap-3 font-bold" style={titleStyle}>
                    {icon}
                    <span className="min-w-0">{title}</span>
                </h2>
                <button type="button" autoFocus onClick={onClose} className="flex min-h-[64px] shrink-0 items-center gap-2 rounded-2xl px-5 font-bold" style={closeStyle}>
                    <X className="h-9 w-9 shrink-0" strokeWidth={3} aria-hidden="true" />
                    {closeLabel}
                </button>
            </div>
        </div>
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pb-12 pt-5 sm:px-6">
            {children}
        </div>
    </div>
);

/**
 * Stimme zum Vorlesen, nur wenn sie auf dem Geraet selbst arbeitet (localService).
 * Online-Stimmen des Browsers schicken den Text an einen fremden Dienst, und die
 * Antworten enthalten Gesundheitsdaten (Medikamente). Ohne lokale Stimme kein Vorlesen.
 */
const useLocalVoice = (language: string): SpeechSynthesisVoice | null => {
    const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
    useEffect(() => {
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
        const synth = window.speechSynthesis;
        const prefix = language.slice(0, 2).toLowerCase();
        const pick = () => {
            setVoice(synth.getVoices().find((v) => v.localService && v.lang.toLowerCase().startsWith(prefix)) ?? null);
        };
        pick();
        synth.addEventListener('voiceschanged', pick);
        return () => synth.removeEventListener('voiceschanged', pick);
    }, [language]);
    return voice;
};

interface RecipientViewProps {
    /** Der Kreis, in dem das Konto betreute Person ist (lib/recipientView). */
    circle: CircleSummary;
}

const RecipientView: React.FC<RecipientViewProps> = ({ circle }) => {
    const { t, i18n } = useTranslation(['simpleView', 'medications', 'calendar', 'companion', 'emergency']);
    const { logout, user, updateViewColor } = useAuth();

    const [now, setNow] = useState(() => new Date());
    const [fontScale, setFontScale] = useState<number>(loadFontScale);

    const [intakes, setIntakes] = useState<Intake[]>([]);
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [heat, setHeat] = useState<Heatwave | null>(null);
    const [openVitals, setOpenVitals] = useState<OpenVitalReminder[]>([]);
    const [ownVitals, setOwnVitals] = useState<OwnVital[]>([]);
    const [vitalForm, setVitalForm] = useState<VitalForm | null>(null);
    const [vitalNotice, setVitalNotice] = useState<Notice>(null);
    // Block L3: Terminkarte, neuer Termin, Rueckgaengig
    const [eventCard, setEventCard] = useState<CalendarEvent | null>(null);
    const [eventForm, setEventForm] = useState<EventForm | null>(null);
    const [ownEvents, setOwnEvents] = useState<OwnEvent[]>([]);
    const [eventNotice, setEventNotice] = useState<Notice>(null);
    // Block L4: Einkaufsliste
    const [shopping, setShopping] = useState<ShoppingItem[]>([]);
    const [shopText, setShopText] = useState('');
    const [shopError, setShopError] = useState(false);
    const [shopConfirm, setShopConfirm] = useState<ShopConfirm>(null);
    const [shopNotice, setShopNotice] = useState<Notice>(null);
    const [loadError, setLoadError] = useState(false);

    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<Notice>(null);
    const [confirmGroup, setConfirmGroup] = useState<string | null>(null);
    // Block M: Rueckfragen der Kachel auf der Startseite
    const [homeTakeAll, setHomeTakeAll] = useState<Intake[] | null>(null);
    const [skipConfirm, setSkipConfirm] = useState<Intake[] | null>(null);

    const [win, setWin] = useState<WindowId | null>(null);
    const [logoutOpen, setLogoutOpen] = useState(false);
    const [reminderOpen, setReminderOpen] = useState(false);
    const [info, setInfo] = useState<{ state: 'loading' | 'done' | 'error'; data: OwnInfo | null }>({ state: 'loading', data: null });
    const [question, setQuestion] = useState<RecipientQuestion | null>(null);
    const [answer, setAnswer] = useState<{ state: 'loading' | 'done' | 'error'; text: string }>({ state: 'loading', text: '' });
    const [speaking, setSpeaking] = useState(false);

    // Block D: eigene Farbe (am Konto gespeichert), Fotos, Notfallblatt
    const [colorId, setColorId] = useState<string | null>(user?.view_color ?? null);
    const [colorError, setColorError] = useState(false);
    const [photoIds, setPhotoIds] = useState<string[]>([]);
    const [photoIndex, setPhotoIndex] = useState(0);
    const [photoData, setPhotoData] = useState<Record<string, string>>({});
    const [emergency, setEmergency] = useState<{ state: 'loading' | 'done' | 'error'; data: EmergencySheet | null }>({ state: 'loading', data: null });

    useEffect(() => { setColorId(user?.view_color ?? null); }, [user?.view_color]);
    const accent = viewColorOf(colorId);
    const C = { ...BASE, blue: accent.strong, blueDark: accent.dark, blueSoft: accent.soft };

    const settings = circle.settings;
    const on = (id: FeatureId) => isFeatureEnabled(settings, id);
    const medsOn = on('medications');
    const calendarOn = on('calendar');
    const contactsOn = on('contacts');
    const heatOn = on('heatwave');
    const healthOn = on('health');
    const shoppingOn = on('shopping');
    // Kacheln, die der Admin auf der Seite Betreute Person ausgeblendet hat (nur Anzeige)
    const tileOn = (id: ViewTileId) => isViewTileOn(settings, id);
    // Block K: nur die eingeschalteten von Blutzucker und Gewicht
    const vitalTypesOn = enabledVitalTypes(settings);
    const ownVitalTypes = healthOn ? RECIPIENT_VITAL_TYPES.filter((type) => vitalTypesOn.includes(type)) : [];
    const unitSystem = settings?.unit_system === 'imperial' ? 'imperial' : 'metric';

    const language = (i18n.resolvedLanguage || i18n.language || 'de').split('-')[0];
    const voice = useLocalVoice(language);
    const day = localDay(now);

    // Uhr: alle 15 s reicht fuer den Minutenwechsel.
    useEffect(() => {
        const id = window.setInterval(() => setNow(new Date()), 15_000);
        return () => window.clearInterval(id);
    }, []);

    // ── Laden ──

    const loadIntakes = useCallback(async () => {
        const res = await api.get<{ success: boolean; data: Intake[] }>('/api/medications/intakes');
        const loadedAt = Date.now();
        // "Bei Bedarf" bestaetigt die betreute Person nicht; geplante Einnahmen genuegen hier.
        setIntakes((res.data ?? []).filter((i) => !i.prn).map((i) => ({
            ...i,
            undo_until: i.undo_ms_left && i.undo_ms_left > 0 ? loadedAt + i.undo_ms_left : undefined,
        })));
    }, []);

    const loadOwnVitals = useCallback(async () => {
        const res = await api.get<{ success: boolean; data: OwnVital[] }>('/api/vitals/mine/undoable');
        const loadedAt = Date.now();
        setOwnVitals((Array.isArray(res.data) ? res.data : []).map((v) => ({
            ...v,
            undo_until: v.undo_ms_left > 0 ? loadedAt + v.undo_ms_left : undefined,
        })));
    }, []);

    const loadOwnEvents = useCallback(async () => {
        const res = await api.get<{ success: boolean; data: OwnEvent[] }>('/api/events/mine/undoable');
        const loadedAt = Date.now();
        setOwnEvents((Array.isArray(res.data) ? res.data : []).map((e) => ({
            ...e,
            undo_until: e.undo_ms_left > 0 ? loadedAt + e.undo_ms_left : undefined,
        })));
    }, []);

    const loadShopping = useCallback(async () => {
        const res = await api.get<{ success: boolean; data: ShoppingItem[] }>('/api/shopping');
        const loadedAt = Date.now();
        setShopping((Array.isArray(res.data) ? res.data : []).map((item) => ({
            ...item,
            added_undo_until: item.added_undo_ms_left && item.added_undo_ms_left > 0 ? loadedAt + item.added_undo_ms_left : undefined,
            checked_undo_until: item.checked_undo_ms_left && item.checked_undo_ms_left > 0 ? loadedAt + item.checked_undo_ms_left : undefined,
        })));
    }, []);

    const load = useCallback(async () => {
        const jobs: Promise<unknown>[] = [];
        if (shoppingOn) jobs.push(loadShopping());
        if (medsOn) jobs.push(loadIntakes());
        if (calendarOn) {
            jobs.push(api.get<{ success: boolean; data: CalendarEvent[] }>(`/api/events?from=${day}&to=${day}`)
                .then((res) => setEvents(res.data ?? [])));
            jobs.push(loadOwnEvents());
        }
        if (contactsOn) {
            jobs.push(api.get<{ success: boolean; data: Contact[] }>('/api/contacts')
                .then((res) => setContacts(res.data ?? [])));
        }
        if (heatOn) {
            jobs.push(api.get<{ success: boolean; data: Heatwave }>('/api/heatwave')
                .then((res) => setHeat(res.data ?? null)));
        }
        if (healthOn) {
            jobs.push(api.get<{ success: boolean; data: OpenVitalReminder[] }>('/api/vitals/reminders/today')
                .then((res) => setOpenVitals(Array.isArray(res.data) ? res.data : [])));
            jobs.push(loadOwnVitals());
        }
        const results = await Promise.allSettled(jobs);
        setLoadError(results.some((r) => r.status === 'rejected'));
    }, [medsOn, calendarOn, contactsOn, heatOn, healthOn, shoppingOn, day, loadIntakes, loadOwnVitals, loadOwnEvents, loadShopping]);

    // Beim Start, bei neuem Tag, alle 5 Minuten und bei Aenderungen im Kreis.
    useEffect(() => {
        void load();
        const id = window.setInterval(() => void load(), 5 * 60_000);
        return () => window.clearInterval(id);
    }, [load]);
    useWebSocketUpdates('intakes', () => void load());
    useWebSocketUpdates('medications', () => void load());
    useWebSocketUpdates('events', () => void load());
    useWebSocketUpdates('contacts', () => void load());
    useWebSocketUpdates('heatwave', () => void load());
    useWebSocketUpdates('vitals', () => void load());
    useWebSocketUpdates('shopping', () => void load());
    useWebSocketUpdates('reminder', () => {
        void load();
        setReminderOpen(true);
    });

    // ── Fotos der Familie (Block D) ──
    // Eigener Abruf: Fehlt ein Foto, ist das kein Grund fuer die Fehlermeldung oben.
    const loadPhotos = useCallback(async () => {
        try {
            const res = await api.get<{ success: boolean; data: Array<{ id: string }> }>('/api/view-photos');
            setPhotoIds(Array.isArray(res.data) ? res.data.map((p) => p.id) : []);
        } catch { /* ohne Fotos bleibt das Begruessungsbild */ }
    }, []);
    useEffect(() => {
        void loadPhotos();
        const id = window.setInterval(() => void loadPhotos(), 30 * 60_000);
        return () => window.clearInterval(id);
    }, [loadPhotos]);
    useWebSocketUpdates('view_photos', () => void loadPhotos());

    // Ruhiger Wechsel; bei nur einem Foto bleibt es stehen.
    useEffect(() => {
        if (photoIds.length < 2) return;
        const id = window.setInterval(() => setPhotoIndex((i) => (i + 1) % photoIds.length), PHOTO_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [photoIds.length]);
    const currentPhotoId = photoIds.length > 0 ? photoIds[photoIndex % photoIds.length] : null;
    const nextPhotoId = photoIds.length > 1 ? photoIds[(photoIndex + 1) % photoIds.length] : null;

    // Nur das aktuelle und das naechste Foto im Speicher halten, jedes nur einmal laden.
    const photoDataRef = useRef<Record<string, string>>({});
    useEffect(() => { photoDataRef.current = photoData; }, [photoData]);
    useEffect(() => {
        const keep = [currentPhotoId, nextPhotoId].filter((id): id is string => Boolean(id));
        setPhotoData((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => keep.includes(id))));
        let cancelled = false;
        for (const id of keep) {
            if (photoDataRef.current[id]) continue;
            api.get<{ success: boolean; data: { id: string; data_url: string } }>(`/api/view-photos/${id}`)
                .then((res) => {
                    if (!cancelled && res.data?.data_url) setPhotoData((prev) => ({ ...prev, [id]: res.data.data_url }));
                })
                .catch(() => undefined);
        }
        return () => { cancelled = true; };
    }, [currentPhotoId, nextPhotoId]);
    const currentPhoto = currentPhotoId ? photoData[currentPhotoId] ?? null : null;

    // ── Notfallblatt (Block D, nur lesen) ──
    const openEmergency = async () => {
        setWin('emergency');
        setEmergency({ state: 'loading', data: null });
        try {
            const res = await api.get<{ success: boolean; data: EmergencySheet }>('/api/emergency/payload');
            setEmergency({ state: 'done', data: res.data ?? null });
        } catch {
            setEmergency({ state: 'error', data: null });
        }
    };

    // ── Farbe (Block D): sofort zeigen, am Konto speichern, bei Fehler zurueck ──
    const chooseColor = async (id: string) => {
        const before = colorId;
        setColorId(id);
        setColorError(false);
        try {
            await updateViewColor(id);
        } catch {
            setColorId(before);
            setColorError(true);
        }
    };

    // Rueckgaengig verschwindet genau dann, wenn die vom Server genannte Zeit um ist.
    const [undoClock, setUndoClock] = useState(() => Date.now());
    useEffect(() => {
        const shoppingUndo = shopping.flatMap((s) => [{ undo_until: s.added_undo_until }, { undo_until: s.checked_undo_until }]);
        const next = [...intakes, ...ownVitals, ...ownEvents, ...shoppingUndo].reduce(
            (min, i) => (i.undo_until && i.undo_until > undoClock ? Math.min(min, i.undo_until) : min),
            Infinity
        );
        if (next === Infinity) return;
        const id = window.setTimeout(() => setUndoClock(Date.now()), Math.max(0, next - Date.now()) + 50);
        return () => window.clearTimeout(id);
    }, [intakes, ownVitals, ownEvents, shopping, undoClock]);
    const canUndo = (i: Intake) => (i.status === 'taken' || i.status === 'skipped') && Boolean(i.undo_until && i.undo_until > undoClock);

    // Erfolgsmeldungen bleiben 10 s stehen, Fehler bis zum Schliessen.
    useEffect(() => {
        if (!notice || notice.kind === 'error') return;
        const id = window.setTimeout(() => setNotice(null), 10_000);
        return () => window.clearTimeout(id);
    }, [notice]);
    useEffect(() => {
        if (!vitalNotice || vitalNotice.kind === 'error') return;
        const id = window.setTimeout(() => setVitalNotice(null), 10_000);
        return () => window.clearTimeout(id);
    }, [vitalNotice]);
    useEffect(() => {
        if (!shopNotice || shopNotice.kind === 'error') return;
        const id = window.setTimeout(() => setShopNotice(null), 10_000);
        return () => window.clearTimeout(id);
    }, [shopNotice]);
    useEffect(() => {
        if (!eventNotice || eventNotice.kind === 'error') return;
        const id = window.setTimeout(() => setEventNotice(null), 10_000);
        return () => window.clearTimeout(id);
    }, [eventNotice]);

    // ── Einkaufsliste (Block L4): hinzufuegen und abhaken mit Rueckfrage, 10 Minuten Rueckgaengig ──

    const openShopping = shopping.filter((i) => !i.is_checked);
    const doneShopping = shopping.filter((i) => i.is_checked);
    const canUndoAdd = (i: ShoppingItem) => Boolean(i.added_undo_until && i.added_undo_until > undoClock);
    const canUndoCheck = (i: ShoppingItem) => i.is_checked && Boolean(i.checked_undo_until && i.checked_undo_until > undoClock);
    const shopAmount = (i: ShoppingItem) => {
        const quantity = i.quantity === null || i.quantity === undefined || i.quantity === '' ? null : Number(i.quantity);
        if (quantity === null || !Number.isFinite(quantity)) return '';
        return ` (${formatNumber(quantity)}${i.unit ? ` ${i.unit}` : ''})`;
    };

    const requestAdd = () => {
        const name = shopText.trim().replace(/\s+/g, ' ');
        if (!name || name.length > 100) {
            setShopError(true);
            return;
        }
        setShopError(false);
        setShopConfirm({ kind: 'add', name });
    };

    /** Eine Aenderung der Einkaufsliste senden, Meldung zeigen, Liste neu laden. */
    const shoppingRequest = async (send: () => Promise<{ queued?: boolean }>, okText: string, failText: string) => {
        if (busy) return;
        setBusy(true);
        setShopNotice(null);
        try {
            const res = await send();
            setShopNotice(res.queued ? { kind: 'queued', text: t('simpleView:meds.queued') } : { kind: 'ok', text: okText });
            if (!res.queued) await loadShopping();
        } catch {
            setShopNotice({ kind: 'error', text: failText });
            void loadShopping().catch(() => undefined);
        } finally {
            setBusy(false);
        }
    };

    const confirmShopping = async () => {
        const action = shopConfirm;
        setShopConfirm(null);
        if (!action) return;
        if (action.kind === 'add') {
            setShopText('');
            await shoppingRequest(
                () => api.post<{ success: boolean; queued?: boolean }>('/api/shopping', { name: action.name }),
                t('simpleView:shopping.added'),
                t('simpleView:meds.error')
            );
        } else {
            await shoppingRequest(
                () => api.put<{ success: boolean; queued?: boolean }>(`/api/shopping/${action.item.id}`, { is_checked: true }),
                t('simpleView:shopping.checked'),
                t('simpleView:meds.error')
            );
        }
    };

    const undoShopping = (item: ShoppingItem) =>
        shoppingRequest(
            () => item.is_checked
                ? api.put<{ success: boolean; queued?: boolean }>(`/api/shopping/${item.id}`, { is_checked: false })
                : api.delete<{ success: boolean; queued?: boolean }>(`/api/shopping/${item.id}`),
            t('simpleView:meds.undone'),
            // Nach Ablauf der 10 Minuten lehnt der Server ab (routes/shopping.ts).
            t('simpleView:meds.undoExpired')
        );

    // ── Termin selbst anlegen (Block L3): Angaben, Rueckfrage, 10 Minuten Rueckgaengig ──

    const undoableEvents = ownEvents.filter((e) => e.undo_until && e.undo_until > undoClock);

    const openEventForm = () => {
        setEventNotice(null);
        setEventForm({ step: 'enter', title: '', day: localDay(new Date()), time: '', error: null });
    };

    const checkEvent = () => {
        if (!eventForm) return;
        const parsed = parseRecipientEventForm(eventForm.title, eventForm.day, eventForm.time);
        setEventForm({ ...eventForm, step: parsed.ok ? 'confirm' : 'enter', error: parsed.ok ? null : parsed.error });
    };

    const saveEvent = async () => {
        if (!eventForm || busy) return;
        const parsed = parseRecipientEventForm(eventForm.title, eventForm.day, eventForm.time);
        if (!parsed.ok) {
            setEventForm({ ...eventForm, step: 'enter', error: parsed.error });
            return;
        }
        setBusy(true);
        setEventNotice(null);
        try {
            const res = await api.post<{ success: boolean; queued?: boolean }>('/api/events', { title: parsed.title, start_time: parsed.start_time });
            setEventForm(null);
            if (res.queued) {
                setEventNotice({ kind: 'queued', text: t('simpleView:meds.queued') });
            } else {
                setEventNotice({ kind: 'ok', text: t('simpleView:event.saved') });
                await load();
            }
        } catch {
            setEventNotice({ kind: 'error', text: t('simpleView:meds.error') });
        } finally {
            setBusy(false);
        }
    };

    const undoEvent = async (own: OwnEvent) => {
        if (busy) return;
        setBusy(true);
        setEventNotice(null);
        try {
            const res = await api.delete<{ success: boolean; queued?: boolean }>(`/api/events/${own.id}`);
            setOwnEvents((prev) => prev.filter((e) => e.id !== own.id));
            setEventNotice({ kind: res.queued ? 'queued' : 'ok', text: res.queued ? t('simpleView:meds.queued') : t('simpleView:meds.undone') });
            await load();
        } catch {
            // Nach Ablauf der 10 Minuten lehnt der Server ab (routes/events.ts).
            setEventNotice({ kind: 'error', text: t('simpleView:meds.undoExpired') });
            void loadOwnEvents().catch(() => undefined);
        } finally {
            setBusy(false);
        }
    };

    /** "YYYY-MM-DD" und "HH:MM" als lesbarer Tag mit Uhrzeit. */
    const whenText = (start: string) => {
        const date = clockDate(start);
        if (!date) return start;
        const dayText = new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
        return t('simpleView:event.when', { day: dayText, time: clockOf(date) });
    };

    // ── Messwerte selbst eintragen (Block K) ──

    const undoableVitals = ownVitals.filter((v) => v.undo_until && v.undo_until > undoClock);
    const vitalUnit = (type: RecipientVitalType) => displayUnit(type, unitSystem);
    const vitalText = (type: RecipientVitalType, stored: number) =>
        formatVital(type, stored, null, unitSystem, intlLocale());

    const openVitalForm = (type: RecipientVitalType) => {
        // Block L5: das Fenster Gesundheitswert liegt darunter, dort steht danach das Rueckgaengig.
        setWin('health');
        setVitalNotice(null);
        setVitalForm({ type, step: 'enter', text: '', error: null });
    };

    /** Zahl pruefen; stimmt sie, kommt die Rueckfrage. */
    const checkVital = () => {
        if (!vitalForm) return;
        const parsed = parseRecipientVital(vitalForm.type, vitalForm.text, (shown) => toStorageValue(vitalForm.type, shown, unitSystem));
        setVitalForm({ ...vitalForm, step: parsed.ok ? 'confirm' : 'enter', error: parsed.ok ? null : parsed.error });
    };

    const saveVital = async () => {
        if (!vitalForm || busy) return;
        const parsed = parseRecipientVital(vitalForm.type, vitalForm.text, (shown) => toStorageValue(vitalForm.type, shown, unitSystem));
        if (!parsed.ok) {
            setVitalForm({ ...vitalForm, step: 'enter', error: parsed.error });
            return;
        }
        const type = vitalForm.type;
        setBusy(true);
        setVitalNotice(null);
        try {
            const res = await api.post<{ success: boolean; queued?: boolean }>('/api/vitals', { type, value: parsed.stored });
            setVitalForm(null);
            // Erinnerungszeile sofort weg; der Server sieht den Wert von heute ebenso.
            setOpenVitals((prev) => prev.filter((r) => r.type !== type));
            if (res.queued) {
                setVitalNotice({ kind: 'queued', text: t('simpleView:meds.queued') });
            } else {
                setVitalNotice({ kind: 'ok', text: t('simpleView:measure.saved') });
                await loadOwnVitals();
            }
        } catch {
            setVitalNotice({ kind: 'error', text: t('simpleView:meds.error') });
        } finally {
            setBusy(false);
        }
    };

    const undoVital = async (vital: OwnVital) => {
        if (busy) return;
        setBusy(true);
        setVitalNotice(null);
        try {
            const res = await api.delete<{ success: boolean; queued?: boolean }>(`/api/vitals/${vital.id}`);
            setOwnVitals((prev) => prev.filter((v) => v.id !== vital.id));
            setVitalNotice({ kind: res.queued ? 'queued' : 'ok', text: res.queued ? t('simpleView:meds.queued') : t('simpleView:meds.undone') });
            await load();
        } catch {
            // Nach Ablauf der 10 Minuten lehnt der Server ab (routes/vitals.ts).
            setVitalNotice({ kind: 'error', text: t('simpleView:meds.undoExpired') });
            void loadOwnVitals().catch(() => undefined);
        } finally {
            setBusy(false);
        }
    };

    // ── Einnahmen ──

    const isOpen = (i: Intake) => i.status === 'pending' || i.status === 'missed';
    // Block L2: eine Karte pro Tageszeit und pro fester Uhrzeit, ohne Bedarfsmedikamente.
    const intakeGroups = useMemo(() => groupIntakes(intakes, clockDate), [intakes]);
    const groupTitle = (group: IntakeGroup, items: Intake[]) =>
        group.kind === 'moment' ? t(`medications:moments.${group.moment}`) : t('simpleView:meds.at', { time: clockOf(items[0].due_at) });
    const allTakenLabel = (group: IntakeGroup, items: Intake[]) =>
        group.kind === 'moment' ? t(`medications:today.allTaken.${group.moment}`) : t('simpleView:meds.allTakenAt', { time: clockOf(items[0].due_at) });
    const confirmEntry = confirmGroup ? intakeGroups.find((g) => g.group.key === confirmGroup) ?? null : null;
    const closeTakeAll = () => { setConfirmGroup(null); setHomeTakeAll(null); };
    // Block M: nach "Spaeter erinnern" zaehlt die verschobene Zeit.
    const dueNow = intakes.filter((i) => isOpen(i) && (effectiveDue(i, clockDate)?.getTime() ?? Infinity) <= now.getTime());
    // Block M: Kachel auf der Startseite. Offene Einnahmen ab 30 Minuten vor der Zeit bis
    // Tagesende, dazu eigene Wahl, solange Rueckgaengig moeglich ist.
    const homeIntakes = intakes.filter((i) => showOnHome(i, now, clockDate) || canUndo(i));
    const homeGroups = groupIntakes(homeIntakes, clockDate);

    /** Offline in der Warteschlange: lokal als genommen bzw. uebersprungen zeigen, ohne Rueckgaengig. */
    const markLocally = (ids: string[], status: 'taken' | 'skipped' = 'taken') =>
        setIntakes((prev) => prev.map((i) => (ids.includes(i.id) ? { ...i, status, confirmed_at: null, undo_until: undefined } : i)));

    const setStatus = async (intake: Intake, status: 'taken' | 'pending') => {
        if (busy) return;
        setBusy(true);
        setNotice(null);
        try {
            const res = await api.put<{ success: boolean; queued?: boolean }>(`/api/medications/intakes/${intake.id}`, { status });
            if (res.queued) {
                if (status === 'taken') markLocally([intake.id]);
                setNotice({ kind: 'queued', text: t('simpleView:meds.queued') });
            } else {
                setNotice({ kind: 'ok', text: status === 'taken' ? t('simpleView:meds.saved') : t('simpleView:meds.undone') });
                await loadIntakes();
            }
        } catch {
            // Rueckgaengig nach Ablauf der 10 Minuten lehnt der Server ab (middleware/circle.ts).
            setNotice({ kind: 'error', text: status === 'pending' ? t('simpleView:meds.undoExpired') : t('simpleView:meds.error') });
            void loadIntakes().catch(() => undefined);
        } finally {
            setBusy(false);
        }
    };

    const confirmMany = async (ids: string[]) => {
        if (busy || ids.length === 0) return;
        setBusy(true);
        setNotice(null);
        try {
            const res = await api.post<{ success: boolean; queued?: boolean }>('/api/medications/intakes/confirm', { intake_ids: ids });
            if (res.queued) {
                markLocally(ids);
                setNotice({ kind: 'queued', text: t('simpleView:meds.queued') });
            } else {
                setNotice({ kind: 'ok', text: t('simpleView:meds.saved') });
                await loadIntakes();
            }
        } catch {
            setNotice({ kind: 'error', text: t('simpleView:meds.error') });
            void loadIntakes().catch(() => undefined);
        } finally {
            setBusy(false);
        }
    };

    // Block M: ueberspringen (nach der Rueckfrage), einzeln oder alle eines Zeitraums.
    const skipMany = async (ids: string[]) => {
        if (busy || ids.length === 0) return;
        setBusy(true);
        setNotice(null);
        try {
            const res = await api.post<{ success: boolean; queued?: boolean }>('/api/medications/intakes/skip', { intake_ids: ids });
            if (res.queued) {
                markLocally(ids, 'skipped');
                setNotice({ kind: 'queued', text: t('simpleView:meds.queued') });
            } else {
                setNotice({ kind: 'ok', text: t('simpleView:home.skipped') });
                await loadIntakes();
            }
        } catch {
            setNotice({ kind: 'error', text: t('simpleView:meds.error') });
            void loadIntakes().catch(() => undefined);
        } finally {
            setBusy(false);
        }
    };

    // Block M: spaeter erinnern, 30 Minuten, hoechstens zweimal, nicht bei fester Uhrzeit.
    const snoozeMany = async (items: Intake[]) => {
        const allowed = items.filter(maySnooze);
        if (busy || allowed.length === 0) return;
        const at = allowed.map((i) => snoozeTarget(i, new Date(), clockDate)).reduce((a, b) => (b > a ? b : a));
        setBusy(true);
        setNotice(null);
        try {
            const ids = allowed.map((i) => i.id);
            const res = await api.post<{ success: boolean; queued?: boolean }>('/api/medications/intakes/snooze', { intake_ids: ids });
            if (res.queued) {
                // Lokal verschieben, damit die Kachel gleich ruhig wird; der Server rechnet beim Senden neu.
                setIntakes((prev) => prev.map((i) => (ids.includes(i.id)
                    ? { ...i, snoozed_until: snoozeTarget(i, new Date(), clockDate).toISOString(), snooze_count: Number(i.snooze_count ?? 0) + 1 }
                    : i)));
                setNotice({ kind: 'queued', text: t('simpleView:meds.queued') });
            } else {
                setNotice({ kind: 'ok', text: t('simpleView:home.snoozed', { time: clockOf(at) }) });
                await loadIntakes();
            }
        } catch {
            setNotice({ kind: 'error', text: t('simpleView:meds.error') });
            void loadIntakes().catch(() => undefined);
        } finally {
            setBusy(false);
        }
    };

    // ── Fragen Sie mich (feste Fragen, Antwort vom Server ohne KI) ──

    const questions = RECIPIENT_QUESTIONS.filter((q) => {
        const feature = QUESTION_INFO[q].feature;
        return !feature || on(feature);
    });

    const stopSpeaking = () => {
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
        setSpeaking(false);
    };

    const ask = async (q: RecipientQuestion) => {
        stopSpeaking();
        setQuestion(q);
        setAnswer({ state: 'loading', text: '' });
        try {
            const res = await api.get<{ success: boolean; data: { reply: string } }>(`/api/companion/answer/${q}`);
            setAnswer({ state: 'done', text: res.data?.reply ?? '' });
        } catch {
            setAnswer({ state: 'error', text: t('simpleView:ask.error') });
        }
    };

    const readAloud = (text: string) => {
        if (!voice || !text) return;
        stopSpeaking();
        const utter = new SpeechSynthesisUtterance(text);
        utter.voice = voice;
        utter.lang = voice.lang;
        utter.rate = 0.95;
        utter.onend = () => setSpeaking(false);
        utter.onerror = () => setSpeaking(false);
        setSpeaking(true);
        window.speechSynthesis.speak(utter);
    };

    const closeAsk = () => {
        stopSpeaking();
        setWin(null);
        setQuestion(null);
    };

    // ── Meine Informationen (Block L1, nur lesen) ──
    const openInfo = async () => {
        setWin('info');
        setInfo({ state: 'loading', data: null });
        try {
            const res = await api.get<{ success: boolean; data: OwnInfo | null }>(`/api/circles/${circle.id}/recipient`);
            setInfo({ state: 'done', data: res.data ?? null });
        } catch {
            setInfo({ state: 'error', data: null });
        }
    };

    /** Kachel antippen: Fenster oeffnen, wo noetig mit frischen Daten. */
    const openWindow = (id: WindowId) => {
        if (id === 'emergency') { void openEmergency(); return; }
        if (id === 'info') { void openInfo(); return; }
        if (id === 'ask') setQuestion(null);
        setWin(id);
    };
    // Beim Verlassen der Ansicht nicht weiter vorlesen.
    useEffect(() => () => {
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    }, []);

    // ── Texte und Groessen ──

    const clockOf = (value: string | Date) => formatClock(value);
    const name = (circle.recipient_first_name || '').trim();
    const greeting = name
        ? t(now.getHours() >= 18 ? 'simpleView:greetingEvening' : 'simpleView:greeting', { name })
        : t('simpleView:greetingNoName');
    const dateLabel = new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(now);

    // Schrift in rem (mit dem Browser vergroesserbar), mal der eigenen Textgroesse.
    const fs = (px: number): React.CSSProperties => ({ fontSize: `calc(${px / 16}rem * var(--k, 1))` });
    const tile: React.CSSProperties = { backgroundColor: C.card, border: `1px solid ${C.border}`, color: C.text };
    const sectionTitle = (color: string): React.CSSProperties => ({ ...fs(26), color, fontWeight: 700, lineHeight: 1.3 });
    const secondaryButton: React.CSSProperties = { ...fs(20), backgroundColor: C.card, color: C.text, border: `2px solid ${C.control}` };
    const activeChoice: React.CSSProperties = { ...fs(20), backgroundColor: C.blue, color: '#ffffff', border: `2px solid ${C.blue}` };

    // Block L3: Besuche und Dienste unter "Wer heute kommt", Arzt und Sonstige unter "Termine heute"
    // (dort erscheinen auch die selbst angelegten Termine, Kategorie "Sonstige").
    const VISIT_CATEGORIES = ['visit', 'nurse', 'aide'];
    const visitorEvents = events.filter((e) => VISIT_CATEGORIES.includes(e.category));
    const appointmentEvents = events.filter((e) => !VISIT_CATEGORIES.includes(e.category));
    const heatActive = Boolean(heat?.enabled && heat?.active);
    // Block E: Messwert-Erinnerung zeigen, sobald die Uhrzeit erreicht ist und solange heute kein Wert da ist.
    const nowHm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dueVitals = openVitals.filter((r) => r.remind_time <= nowHm);
    // Block D: Tagesrueckblick ab 18 Uhr. Offen heisst: eine jetzt faellige Einnahme ist
    // nicht bestaetigt oder ein Messwert von heute fehlt. Nie aufzaehlen, nie vorwerfen.
    const showReview = now.getHours() >= REVIEW_FROM_HOUR;
    const somethingOpen = (medsOn && dueNow.length > 0) || (healthOn && dueVitals.length > 0);
    const praiseNumber = (Number(day.replace(/-/g, '')) % 3) + 1;
    const reviewText = somethingOpen ? t('simpleView:review.open') : t(`simpleView:review.praise${praiseNumber}`);
    const heatRed = heat?.level === 'red';

    const timeRange = (e: CalendarEvent) =>
        e.end_time ? `${clockOf(e.start_time)} – ${clockOf(e.end_time)}` : clockOf(e.start_time);
    /** Wer dabei ist: nur wenn "Jemand muss mitkommen" aktiv ist (eventExtras.ts). */
    const peopleOf = (e: CalendarEvent): string[] => isCompanionActive(e)
        ? [...(e.members_data ?? []).map((m) => m.name), ...(e.guests ?? [])]
        : [];

    const intakeDetails = (i: Intake): string[] =>
        [
            i.with_food && i.with_food !== 'any' ? t(`medications:withFood.${i.with_food}`) : null,
            i.appearance,
            i.instructions,
        ].filter(Boolean) as string[];

    const rootStyle: React.CSSProperties = {
        backgroundColor: C.bg,
        color: C.text,
        lineHeight: 1.5,
        ['--k' as string]: String(fontScale),
    };

    const overlayBox = 'relative max-h-[90vh] w-full overflow-y-auto rounded-3xl p-6 shadow-lg sm:p-8';
    // Rueckfragen liegen ueber den Fenstern (z-70), die Erinnerung ganz oben.
    const dialogLayer = 'fixed inset-0 z-[80] flex items-center justify-center p-4 font-kiosk';
    const windowProps = {
        style: rootStyle,
        titleStyle: { ...fs(32), color: C.text, lineHeight: 1.25 } as React.CSSProperties,
        closeStyle: { ...fs(22), ...secondaryButton, border: `3px solid ${C.control}` } as React.CSSProperties,
        barColor: C.bg,
        barBorder: C.border,
        closeLabel: t('simpleView:window.close'),
        onClose: () => { stopSpeaking(); setWin(null); },
    };

    // ── Karte einer Einnahme (Fenster Medikamente und Kachel auf der Startseite) ──
    // Farbe des Medikaments: helle Flaeche mit kraeftigem Rand; ohne Farbe neutral.
    const intakeCardStyle = (intake: Intake): React.CSSProperties => {
        const color = medicationColorOf(intake.medication_color);
        return color
            ? { backgroundColor: color.soft, border: `3px solid ${color.strong}`, color: C.text }
            : { backgroundColor: C.card, border: `2px solid ${C.border}`, color: C.text };
    };
    const renderIntakeInfo = (intake: Intake, group: IntakeGroup) => {
        const amount = formatAmount(t, intake.quantity, intake.unit, intake.form);
        const color = medicationColorOf(intake.medication_color);
        return (
            <div className="flex items-start gap-4">
                {intake.photo_url ? (
                    <img src={intake.photo_url} alt="" className="h-20 w-20 shrink-0 rounded-2xl object-cover" style={{ border: `1px solid ${C.border}` }} />
                ) : (
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl" style={{ backgroundColor: C.card, color: color ? color.strong : C.blue, border: `1px solid ${C.border}` }} aria-hidden="true">
                        <Pill className="h-10 w-10" />
                    </div>
                )}
                <div className="min-w-0">
                    <p className="font-bold" style={fs(23)}>
                        {intake.medication_name}
                        {intake.medication_dosage ? ` ${intake.medication_dosage}` : ''}
                    </p>
                    <p className="font-bold" style={fs(21)}>
                        {group.kind === 'moment' ? amount : t('medications:today.takeAt', { amount, time: clockOf(intake.due_at) })}
                    </p>
                    {intakeDetails(intake).map((line, idx) => (
                        <p key={idx} style={fs(19)}>{line}</p>
                    ))}
                </div>
            </div>
        );
    };
    const intakeLabel = (i: Intake) => `${i.medication_name}${i.medication_dosage ? ` ${i.medication_dosage}` : ''}`;
    /** Rueckgaengig-Zeile unter einer eigenen Wahl (genommen oder uebersprungen). */
    const renderUndo = (intake: Intake) => (
        <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void setStatus(intake, 'pending')} disabled={busy} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                <RotateCcw className="h-6 w-6 shrink-0" aria-hidden="true" />
                {t('medications:today.undo')}
            </button>
            <span style={fs(18)}>
                {t('simpleView:meds.undoHint', { time: clockOf(new Date(intake.undo_until ?? Date.now())) })}
            </span>
        </div>
    );
    const noticeBox = notice && (
        <div
            role={notice.kind === 'error' ? 'alert' : 'status'}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4"
            style={{ backgroundColor: C.card, border: `2px solid ${notice.kind === 'error' ? C.red : C.green}` }}
        >
            <p className="font-bold" style={{ ...fs(21), color: notice.kind === 'error' ? C.red : C.text }}>{notice.text}</p>
            <button type="button" onClick={() => setNotice(null)} className="min-h-[56px] min-w-[96px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                {t('simpleView:ok')}
            </button>
        </div>
    );
    // Rueckfrage "alle genommen": aus dem Fenster (pro Tageszeit) oder aus der Kachel (nur die gezeigten).
    // Erst hier, weil allTakenLabel clockOf braucht.
    const takeAllDialog = confirmEntry
        ? { title: allTakenLabel(confirmEntry.group, confirmEntry.items), items: confirmEntry.items.filter(isOpen) }
        : homeTakeAll ? { title: t('simpleView:home.allTaken'), items: homeTakeAll.filter(isOpen) } : null;
    // Block M: Tasten unter jeder Tablette nur mit Symbol (Ausnahme wie E20), 64 px, 12 px Abstand.
    const iconButton = 'flex h-16 min-w-[64px] flex-1 items-center justify-center rounded-2xl px-3 disabled:opacity-70';
    // Hellroter Rahmen bei offener Einnahme 30 Minuten nach der Zeit: mind. 3:1 auf Weiss und den hellen Flaechen.
    const OVERDUE_RING = '#d9534f';

    // ── Kacheln (Block L1): alle gleich, weiss mit gleichem Rand; Farbe nur mit Bedeutung ──
    const tileStyle: React.CSSProperties = { backgroundColor: C.card, border: `2px solid ${C.border}`, color: C.text };
    const renderTile = (id: WindowId, Icon: React.FC<{ className?: string; style?: React.CSSProperties }>, title: string, hint: string | null, iconColor: string = C.blue) => (
        <button
            key={id}
            type="button"
            onClick={() => openWindow(id)}
            className="flex min-h-[148px] flex-col items-start justify-between gap-3 rounded-3xl p-5 text-left shadow-sm"
            style={tileStyle}
        >
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl" style={{ backgroundColor: C.bg }} aria-hidden="true">
                <Icon className="h-10 w-10" style={{ color: iconColor }} />
            </span>
            <span className="block">
                <span className="block font-bold" style={{ ...fs(26), lineHeight: 1.25 }}>{title}</span>
                {hint && <span className="mt-1 block" style={{ ...fs(19), color: C.muted }}>{hint}</span>}
            </span>
        </button>
    );

    return (
        <div className="min-h-screen font-kiosk" style={rootStyle}>
            <div className="mx-auto flex min-h-screen w-full max-w-[1200px] flex-col gap-5 px-4 pb-12 pt-3 sm:px-6">
                {/* Kopfzeile: Datum, Uhr, Abmelden (immer mit Text). Notfallblatt und Einstellungen sind Kacheln (L1). */}
                <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3" style={tile}>
                    <div className="flex items-center gap-4">
                        <img src={`${import.meta.env.BASE_URL}OpenCare.png`} alt="" className="h-12 w-12 rounded-xl" />
                        <div>
                            <p className="font-bold first-letter:uppercase" style={{ ...fs(20), color: C.muted }}>{dateLabel}</p>
                            <p className="font-bold tabular-nums" style={{ ...fs(36), lineHeight: 1.2 }}>{clockOf(now)}</p>
                        </div>
                    </div>
                    <button type="button" onClick={() => setLogoutOpen(true)} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-4 font-bold" style={secondaryButton}>
                        <LogOut className="h-6 w-6 shrink-0" aria-hidden="true" />
                        {t('simpleView:header.logout')}
                    </button>
                </header>

                {/* Block M (E23): Medikamente direkt auf der Startseite, ohne Fenster */}
                {medsOn && win === null && notice && noticeBox}
                {medsOn && homeGroups.length > 0 && (
                    <section className="rounded-3xl p-5 sm:p-6" style={{ backgroundColor: C.blueSoft, border: `2px solid ${C.border}` }} aria-labelledby="rv-home-meds">
                        <h2 id="rv-home-meds" className="mb-4 flex items-center gap-4" style={sectionTitle(C.blueDark)}>
                            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white" style={{ backgroundColor: C.blue }} aria-hidden="true">
                                <Pill className="h-8 w-8" />
                            </span>
                            {t('simpleView:reminder.title')}
                        </h2>
                        <div className="flex flex-col gap-5">
                            {homeGroups.map(({ group, items }) => {
                                const open = items.filter(isOpen);
                                const snoozable = open.filter(maySnooze);
                                return (
                                    <div key={group.key} role="group" aria-labelledby={`rv-home-${group.key}`} className="rounded-2xl p-4 sm:p-5" style={tile}>
                                        <h3 id={`rv-home-${group.key}`} className="mb-3 font-bold" style={{ ...fs(26), lineHeight: 1.3 }}>{groupTitle(group, items)}</h3>
                                        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                            {items.map((intake) => {
                                                const overdue = isOverdue(intake, now, clockDate);
                                                const label = intakeLabel(intake);
                                                return (
                                                    <li
                                                        key={intake.id}
                                                        className="flex flex-col gap-3 rounded-2xl p-4"
                                                        style={{ ...intakeCardStyle(intake), ...(overdue ? { outline: `4px solid ${OVERDUE_RING}`, outlineOffset: 3 } : {}) }}
                                                    >
                                                        {renderIntakeInfo(intake, group)}

                                                        {/* Verpasst: nie zum Nachholen auffordern, nur sagen, was ist */}
                                                        {overdue && (
                                                            <div className="rounded-xl px-3 py-2" style={{ backgroundColor: C.redSoft, color: C.red }}>
                                                                <p className="font-bold" style={fs(21)}>{t('simpleView:home.overdue', { time: clockOf(intake.due_at) })}</p>
                                                                <p className="font-bold" style={fs(19)}>{t('simpleView:home.askFamily')}</p>
                                                            </div>
                                                        )}

                                                        {intake.status === 'taken' && (
                                                            <p className="flex items-center gap-2 rounded-xl px-3 py-2 font-bold text-white" style={{ ...fs(21), backgroundColor: C.green }}>
                                                                <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                                                                {intake.confirmed_at
                                                                    ? t('medications:today.status.takenAt', { time: clockOf(intake.confirmed_at) })
                                                                    : t('medications:today.status.taken')}
                                                            </p>
                                                        )}
                                                        {intake.status === 'skipped' && (
                                                            <p className="font-bold" style={fs(21)}>{t('simpleView:home.skippedStatus')}</p>
                                                        )}

                                                        {isOpen(intake) && (
                                                            <div className="flex gap-3">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => void setStatus(intake, 'taken')}
                                                                    disabled={busy}
                                                                    aria-label={t('simpleView:home.takeOne', { name: label })}
                                                                    title={t('simpleView:home.take')}
                                                                    className={cn(iconButton, 'text-white shadow-md')}
                                                                    style={{ backgroundColor: C.green }}
                                                                >
                                                                    <Check className="h-9 w-9" strokeWidth={3} aria-hidden="true" />
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setSkipConfirm([intake])}
                                                                    disabled={busy}
                                                                    aria-label={t('simpleView:home.skipOne', { name: label })}
                                                                    title={t('simpleView:home.skip')}
                                                                    className={iconButton}
                                                                    style={secondaryButton}
                                                                >
                                                                    <SkipForward className="h-9 w-9" aria-hidden="true" />
                                                                </button>
                                                                {maySnooze(intake) && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => void snoozeMany([intake])}
                                                                        disabled={busy}
                                                                        aria-label={t('simpleView:home.snoozeOne', { name: label })}
                                                                        title={t('simpleView:home.snooze')}
                                                                        className={iconButton}
                                                                        style={secondaryButton}
                                                                    >
                                                                        <Bell className="h-9 w-9" aria-hidden="true" />
                                                                    </button>
                                                                )}
                                                            </div>
                                                        )}
                                                        {canUndo(intake) && renderUndo(intake)}
                                                    </li>
                                                );
                                            })}
                                        </ul>

                                        {open.length > 1 && (
                                            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                                                <button
                                                    type="button"
                                                    onClick={() => setHomeTakeAll(open)}
                                                    disabled={busy}
                                                    className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white shadow-md disabled:opacity-70"
                                                    style={{ ...fs(21), backgroundColor: C.green }}
                                                >
                                                    <CheckCheck className="h-7 w-7 shrink-0" aria-hidden="true" />
                                                    {t('simpleView:home.allTaken')}
                                                </button>
                                                <button type="button" onClick={() => setSkipConfirm(open)} disabled={busy} className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-4 font-bold" style={secondaryButton}>
                                                    <SkipForward className="h-7 w-7 shrink-0" aria-hidden="true" />
                                                    {t('simpleView:home.allSkip')}
                                                </button>
                                                {snoozable.length > 0 && (
                                                    <button type="button" onClick={() => void snoozeMany(snoozable)} disabled={busy} className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-4 font-bold" style={secondaryButton}>
                                                        <Bell className="h-7 w-7 shrink-0" aria-hidden="true" />
                                                        {t('simpleView:home.snooze')}
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                )}

                {/* Begruessung mit Foto */}
                <section
                    className="relative overflow-hidden rounded-3xl"
                    style={{ minHeight: 180, backgroundImage: `url(${HERO_IMAGE})`, backgroundSize: 'cover', backgroundPosition: 'center right' }}
                >
                    <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.9) 50%, rgba(255,255,255,0.2) 80%, rgba(255,255,255,0) 100%)' }} />
                    <div className="relative flex min-h-[180px] items-center gap-5 p-5 sm:p-7">
                        <PersonPhoto name={name} url={circle.recipient_photo_url} size={88} soft={C.blueSoft} strong={C.blue} />
                        <div>
                            <h1 className="font-bold" style={{ ...fs(40), color: C.blueDark, lineHeight: 1.2 }}>{greeting}</h1>
                            <p className="mt-1 font-bold" style={{ ...fs(22), color: C.blueDark }}>{t('simpleView:tagline')}</p>
                        </div>
                    </div>
                </section>

                {/* Tagesrueckblick ab 18 Uhr: ein Satz, keine Aufzaehlung */}
                {showReview && (
                    <section className="flex items-center gap-4 rounded-3xl p-5 sm:p-6" style={{ backgroundColor: C.blueSoft, border: `1px solid ${C.border}` }} aria-labelledby="rv-review">
                        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white" style={{ backgroundColor: C.blue }}>
                            {somethingOpen
                                ? <Sun className="h-8 w-8" aria-hidden="true" />
                                : <Moon className="h-8 w-8" aria-hidden="true" />}
                        </span>
                        <div>
                            <h2 id="rv-review" style={sectionTitle(C.blueDark)}>{t('simpleView:review.title')}</h2>
                            <p className="font-bold" style={fs(22)}>{reviewText}</p>
                        </div>
                    </section>
                )}

                {loadError && (
                    <section role="alert" className="flex flex-wrap items-center justify-between gap-4 rounded-3xl p-5" style={{ backgroundColor: C.redSoft, border: `2px solid ${C.red}` }}>
                        <p className="font-bold" style={fs(21)}>{t('simpleView:loadError')}</p>
                        <button type="button" onClick={() => void load()} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                            <RotateCcw className="h-6 w-6 shrink-0" aria-hidden="true" />
                            {t('simpleView:reload')}
                        </button>
                    </section>
                )}

                {heatOn && heatActive && (
                    <section className="flex items-center gap-4 rounded-3xl p-5" style={{ backgroundColor: heatRed ? C.redSoft : C.amberSoft, border: `1px solid ${C.border}` }}>
                        <ThermometerSun className="h-12 w-12 shrink-0" style={{ color: heatRed ? C.red : C.amber }} aria-hidden="true" />
                        <p className="font-bold" style={fs(22)}>{t('simpleView:heat.banner')}</p>
                    </section>
                )}

                {/* Block E: freundliche Zeile, solange ein Messwert von heute fehlt; Block K: mit Taste zum Eintragen */}
                {healthOn && dueVitals.map((r) => {
                    const Icon = r.type === 'glucose' ? Droplet : Scale;
                    return (
                        <section key={r.type} className="flex flex-wrap items-center justify-between gap-4 rounded-3xl p-5" style={{ backgroundColor: C.blueSoft, border: `1px solid ${C.border}` }}>
                            <div className="flex items-center gap-4">
                                <Icon className="h-12 w-12 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
                                <p className="font-bold" style={fs(22)}>
                                    {t(`simpleView:vitals.${r.type}`)}
                                    {r.note ? ` (${r.note})` : ''}
                                </p>
                            </div>
                            {(ownVitalTypes as readonly string[]).includes(r.type) && (
                                <button
                                    type="button"
                                    onClick={() => openVitalForm(r.type)}
                                    className="flex min-h-[64px] items-center gap-2 rounded-2xl px-5 font-bold text-white shadow-md"
                                    style={{ ...fs(21), backgroundColor: C.blue }}
                                >
                                    <Icon className="h-7 w-7 shrink-0" aria-hidden="true" />
                                    {t('simpleView:measure.now')}
                                </button>
                            )}
                        </section>
                    );
                })}

                {/* Block L1: Kacheln, jede oeffnet ein grosses Fenster */}
                <nav aria-label={t('simpleView:tiles.label')} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {tileOn('emergency') && renderTile('emergency', HeartPulse, t('simpleView:emergency.button'), null, C.red)}
                    {medsOn && tileOn('meds') && renderTile('meds', Pill, t('simpleView:tiles.meds'),
                        dueNow.length > 0 ? t('simpleView:reminder.subtitle', { count: dueNow.length }) : null)}
                    {ownVitalTypes.length > 0 && tileOn('health') && renderTile('health', Activity, t('simpleView:measure.title'),
                        dueVitals.length > 0 ? t(`simpleView:vitals.${dueVitals[0].type}`) : null)}
                    {calendarOn && tileOn('visitors') && renderTile('visitors', Users, t('simpleView:visitors.title'),
                        visitorEvents.length === 0 ? t('simpleView:visitors.empty') : t('simpleView:tiles.visits', { count: visitorEvents.length }))}
                    {calendarOn && tileOn('appointments') && renderTile('appointments', CalendarDays, t('simpleView:appointments.title'),
                        appointmentEvents.length === 0 ? t('simpleView:appointments.empty') : t('simpleView:tiles.appointments', { count: appointmentEvents.length }))}
                    {contactsOn && tileOn('contacts') && renderTile('contacts', Phone, t('simpleView:contacts.title'), null)}
                    {questions.length > 0 && tileOn('ask') && renderTile('ask', MessageCircle, t('simpleView:ask.button'), t('simpleView:ask.hint'))}
                    {on('consultations') && tileOn('doctor') && (
                        <div
                            role="group"
                            aria-disabled="true"
                            aria-label={`${t('simpleView:tiles.doctor')}: ${t('simpleView:tiles.later')}`}
                            className="flex min-h-[148px] flex-col items-start justify-between gap-3 rounded-3xl p-5"
                            style={{ backgroundColor: C.bg, border: `2px dashed ${C.control}`, color: C.muted }}
                        >
                            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl" style={{ backgroundColor: C.card }} aria-hidden="true">
                                <Stethoscope className="h-10 w-10" />
                            </span>
                            <span className="block">
                                <span className="block font-bold" style={{ ...fs(26), lineHeight: 1.25 }}>{t('simpleView:tiles.doctor')}</span>
                                <span className="mt-1 block font-bold" style={fs(19)}>{t('simpleView:tiles.later')}</span>
                            </span>
                        </div>
                    )}
                    {tileOn('info') && renderTile('info', IdCard, t('simpleView:info.title'), null)}
                    {shoppingOn && tileOn('shopping') && renderTile('shopping', ShoppingCart, t('simpleView:tiles.shopping'),
                        openShopping.length === 0 ? t('simpleView:shopping.empty') : t('simpleView:tiles.shoppingOpen', { count: openShopping.length }))}
                    {renderTile('settings', SettingsIcon, t('simpleView:settings.title'), null)}
                </nav>

                {/* Fotos der Familie, ruhig im Wechsel (Block D) */}
                {currentPhoto && (
                    <section className="rounded-3xl p-4 sm:p-5" style={tile} aria-labelledby="rv-photos">
                        <h2 id="rv-photos" className="mb-3 flex items-center gap-3" style={sectionTitle(C.blueDark)}>
                            {t('simpleView:photos.title')}
                        </h2>
                        <img
                            key={currentPhotoId ?? ''}
                            src={currentPhoto}
                            alt={t('simpleView:photos.alt', { number: (photoIndex % Math.max(1, photoIds.length)) + 1, total: photoIds.length })}
                            className="mx-auto max-h-[60vh] w-full rounded-2xl object-contain motion-safe:animate-fade-in"
                            style={{ backgroundColor: C.bg }}
                        />
                        {photoIds.length > 1 && (
                            <div className="mt-3 flex justify-end">
                                <button
                                    type="button"
                                    onClick={() => setPhotoIndex((i) => (i + 1) % photoIds.length)}
                                    className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold"
                                    style={secondaryButton}
                                >
                                    {t('simpleView:photos.next')}
                                    <ChevronRight className="h-6 w-6 shrink-0" aria-hidden="true" />
                                </button>
                            </div>
                        )}
                    </section>
                )}
            </div>

            {win === 'emergency' && (
                <ViewWindow id="rv-win-emergency" title={t('emergency:title')} icon={<HeartPulse className="h-9 w-9 shrink-0" style={{ color: C.red }} aria-hidden="true" />} {...windowProps} onClose={windowProps.onClose}>
                        {emergency.state === 'loading' && <p style={fs(22)}>{t('simpleView:ask.loading')}</p>}
                        {(emergency.state === 'error' || (emergency.state === 'done' && !emergency.data?.recipient)) && (
                            <div role="alert" className="flex flex-wrap items-center justify-between gap-4 rounded-3xl p-5" style={{ backgroundColor: C.redSoft, border: `2px solid ${C.red}` }}>
                                <p className="font-bold" style={fs(21)}>{t('simpleView:emergency.error')}</p>
                                <button type="button" onClick={() => void openEmergency()} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                                    <RotateCcw className="h-6 w-6 shrink-0" aria-hidden="true" />
                                    {t('simpleView:reload')}
                                </button>
                            </div>
                        )}

                        {emergency.state === 'done' && emergency.data?.recipient && (() => {
                            const sheet = emergency.data as EmergencySheet;
                            const r = sheet.recipient as NonNullable<EmergencySheet['recipient']>;
                            const fullName = [r.first_name, r.last_name].filter(Boolean).join(' ');
                            const rows: Array<[string, string | null]> = [
                                [t('emergency:fields.birthDate'), r.birth_date ? new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(r.birth_date)) : null],
                                [t('emergency:fields.bloodType'), r.blood_type],
                                [t('emergency:sections.allergies'), r.allergies],
                                [t('emergency:sections.history'), r.medical_history],
                                [t('emergency:sections.directives'), r.advance_directives],
                                [t('emergency:fields.gp'), [r.gp_name, r.gp_phone].filter(Boolean).join(' · ') || null],
                                [t('emergency:fields.insurance'), r.insurance_info],
                                [t('emergency:sections.notes'), sheet.extra_notes],
                            ];
                            return (
                                <>
                                    <section className="rounded-3xl p-5 sm:p-6" style={tile}>
                                        <p className="font-bold" style={fs(28)}>{fullName}</p>
                                        <dl className="mt-3 space-y-3">
                                            {rows.filter(([, value]) => value && value.trim()).map(([label, value]) => (
                                                <div key={label}>
                                                    <dt className="font-bold" style={{ ...fs(20), color: C.muted }}>{label}</dt>
                                                    <dd className="whitespace-pre-wrap" style={fs(22)}>{value}</dd>
                                                </div>
                                            ))}
                                        </dl>
                                    </section>

                                    <section className="rounded-3xl p-5 sm:p-6" style={tile} aria-labelledby="rv-emergency-meds">
                                        <h3 id="rv-emergency-meds" className="mb-3 flex items-center gap-3" style={sectionTitle(C.text)}>
                                            <Pill className="h-7 w-7 shrink-0" style={{ color: C.green }} aria-hidden="true" />
                                            {t('emergency:sections.medications')}
                                        </h3>
                                        {sheet.medications.length === 0 ? (
                                            <p style={fs(21)}>{t('emergency:sections.noMedications')}</p>
                                        ) : (
                                            <ul className="space-y-2">
                                                {sheet.medications.map((m, idx) => (
                                                    <li key={idx} style={fs(22)}>
                                                        <span className="font-bold">{m.name}{m.dosage ? ` ${m.dosage}` : ''}</span>
                                                        {m.schedules.length > 0 && (
                                                            <span className="tabular-nums" style={{ color: C.muted }}>{' · '}{m.schedules.map((x) => x.time).join(', ')}</span>
                                                        )}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </section>

                                    {sheet.contacts.length > 0 && (
                                        <section className="rounded-3xl p-5 sm:p-6" style={tile} aria-labelledby="rv-emergency-contacts">
                                            <h3 id="rv-emergency-contacts" className="mb-3 flex items-center gap-3" style={sectionTitle(C.text)}>
                                                <Phone className="h-7 w-7 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
                                                {t('emergency:sections.contacts')}
                                            </h3>
                                            <ul className="space-y-3">
                                                {sheet.contacts.map((c, idx) => (
                                                    <li key={idx}>
                                                        <p className="font-bold" style={fs(22)}>{c.name}</p>
                                                        <p style={{ ...fs(20), color: C.muted }}>
                                                            {t(`emergency:categories.${c.category}`, { defaultValue: c.category })}
                                                            {c.organization ? ` · ${c.organization}` : ''}
                                                            {c.phone ? ` · ${c.phone}` : ''}
                                                        </p>
                                                    </li>
                                                ))}
                                            </ul>
                                        </section>
                                    )}
                                </>
                            );
                        })()}
                </ViewWindow>
            )}

            {win === 'meds' && (
                <ViewWindow id="rv-win-meds" title={t('simpleView:meds.title')} icon={<Pill className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={windowProps.onClose}>
                        {notice && (
                            <div
                                role={notice.kind === 'error' ? 'alert' : 'status'}
                                className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4"
                                style={{ backgroundColor: C.card, border: `2px solid ${notice.kind === 'error' ? C.red : C.green}` }}
                            >
                                <p className="font-bold" style={{ ...fs(21), color: notice.kind === 'error' ? C.red : C.text }}>{notice.text}</p>
                                <button type="button" onClick={() => setNotice(null)} className="min-h-[56px] min-w-[96px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                    {t('simpleView:ok')}
                                </button>
                            </div>
                        )}

                    {intakeGroups.length === 0 ? (
                        <section className="rounded-3xl p-5 sm:p-6" style={tile}>
                            <p style={fs(21)}>{t('simpleView:meds.empty')}</p>
                        </section>
                    ) : intakeGroups.map(({ group, items }) => {
                        const open = items.filter(isOpen);
                        return (
                            <section key={group.key} className="rounded-3xl p-5 sm:p-6" style={tile} aria-labelledby={`rv-meds-${group.key}`}>
                                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                                    <h3 id={`rv-meds-${group.key}`} className="font-bold" style={{ ...fs(26), lineHeight: 1.3 }}>{groupTitle(group, items)}</h3>
                                    {open.length > 1 && (
                                        <button type="button" onClick={() => setConfirmGroup(group.key)} disabled={busy} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                                            <CheckCheck className="h-6 w-6 shrink-0" aria-hidden="true" />
                                            {allTakenLabel(group, items)}
                                        </button>
                                    )}
                                </div>
                                <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                    {items.map((intake) => {
                                        return (
                                            <li key={intake.id} className="flex flex-col gap-3 rounded-2xl p-4" style={intakeCardStyle(intake)}>
                                                {renderIntakeInfo(intake, group)}

                                                {intake.status === 'taken' && (
                                                    <p className="flex items-center gap-2 rounded-xl px-3 py-2 font-bold text-white" style={{ ...fs(21), backgroundColor: C.green }}>
                                                        <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                                                        {intake.confirmed_at
                                                            ? t('medications:today.status.takenAt', { time: clockOf(intake.confirmed_at) })
                                                            : t('medications:today.status.taken')}
                                                    </p>
                                                )}
                                                {intake.status === 'skipped' && (
                                                    <p className="font-bold" style={fs(21)}>{t('medications:today.status.skipped')}</p>
                                                )}
                                                {intake.status === 'missed' && (
                                                    <p className="font-bold" style={fs(21)}>{t('medications:today.status.missed')}</p>
                                                )}

                                                {isOpen(intake) && (
                                                    <button
                                                        type="button"
                                                        onClick={() => void setStatus(intake, 'taken')}
                                                        disabled={busy}
                                                        className="flex min-h-[64px] w-full items-center justify-center gap-3 rounded-2xl font-bold text-white shadow-md disabled:opacity-70"
                                                        style={{ ...fs(24), backgroundColor: C.green }}
                                                    >
                                                        <Check className="h-8 w-8 shrink-0" strokeWidth={3} aria-hidden="true" />
                                                        {t('medications:today.markTaken')}
                                                    </button>
                                                )}
                                                {canUndo(intake) && renderUndo(intake)}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </section>
                        );
                    })}
</ViewWindow>
            )}

            {win === 'health' && (
                <ViewWindow id="rv-win-health" title={t('simpleView:measure.title')} icon={<Activity className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={windowProps.onClose}>
                    <section className="rounded-3xl p-5 sm:p-6" style={tile}>
                        {vitalNotice && (
                            <div
                                role={vitalNotice.kind === 'error' ? 'alert' : 'status'}
                                className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4"
                                style={{ backgroundColor: C.card, border: `2px solid ${vitalNotice.kind === 'error' ? C.red : C.green}` }}
                            >
                                <p className="font-bold" style={{ ...fs(21), color: vitalNotice.kind === 'error' ? C.red : C.text }}>{vitalNotice.text}</p>
                                <button type="button" onClick={() => setVitalNotice(null)} className="min-h-[56px] min-w-[96px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                    {t('simpleView:ok')}
                                </button>
                            </div>
                        )}

                        {/* Block L5: erst waehlen, was eingetragen wird */}
                        <p className="mb-4 font-bold" style={fs(22)}>{t('simpleView:measure.choose')}</p>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            {ownVitalTypes.map((type) => {
                                const Icon = type === 'glucose' ? Droplet : Scale;
                                return (
                                    <button
                                        key={type}
                                        type="button"
                                        onClick={() => openVitalForm(type)}
                                        disabled={busy}
                                        className="flex min-h-[112px] items-center justify-center gap-4 rounded-3xl px-4 font-bold disabled:opacity-70"
                                        style={{ ...secondaryButton, ...fs(24), border: `2px solid ${C.border}` }}
                                    >
                                        <Icon className="h-10 w-10 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
                                        {t(`simpleView:measure.button.${type}`)}
                                    </button>
                                );
                            })}
                        </div>

                        {undoableVitals.length > 0 && (
                            <ul className="mt-4 space-y-3">
                                {undoableVitals.map((v) => (
                                    <li key={v.id} className="space-y-3 rounded-2xl p-4" style={tile}>
                                        <p className="flex items-center gap-2 font-bold" style={{ ...fs(21), color: C.green }}>
                                            <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                                            {t(`simpleView:measure.entered.${v.type}`, { value: vitalText(v.type, v.value) })}
                                        </p>
                                        <div className="flex flex-wrap items-center gap-3">
                                            <button type="button" onClick={() => void undoVital(v)} disabled={busy} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                                                <RotateCcw className="h-6 w-6 shrink-0" aria-hidden="true" />
                                                {t('medications:today.undo')}
                                            </button>
                                            <span style={{ ...fs(18), color: C.muted }}>
                                                {t('simpleView:meds.undoHint', { time: clockOf(new Date(v.undo_until ?? Date.now())) })}
                                            </span>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                </ViewWindow>
            )}

            {win === 'visitors' && (
                <ViewWindow id="rv-win-visitors" title={t('simpleView:visitors.title')} icon={<Users className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={windowProps.onClose}>
                            {visitorEvents.length === 0 ? (
                                <p style={fs(21)}>{t('simpleView:visitors.empty')}</p>
                            ) : (
                                <ul className="space-y-3">
                                    {visitorEvents.map((e) => {
                                        const people = peopleOf(e);
                                        const who = people.length > 0
                                            ? people.join(', ')
                                            : e.category === 'nurse' ? t('simpleView:visitors.nurse')
                                                : e.category === 'aide' ? t('simpleView:visitors.aide')
                                                    : t('simpleView:visitors.someone');
                                        return (
                                            <li key={`${e.id}-${e.start_time}`}>
                                                <button type="button" onClick={() => setEventCard(e)} className="flex w-full items-center gap-4 rounded-2xl p-4 text-left" style={{ ...tile, border: `2px solid ${C.border}` }}>
                                                {people.length > 0 ? (
                                                    <PersonPhoto name={people[0]} url={null} size={64} soft={C.blueSoft} strong={C.blue} />
                                                ) : (
                                                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: C.blueSoft, color: C.blue }} aria-hidden="true">
                                                        <Stethoscope className="h-8 w-8" />
                                                    </div>
                                                )}
                                                <div className="min-w-0">
                                                    <p className="font-bold" style={fs(23)}>{who}</p>
                                                    <p className="font-bold tabular-nums" style={{ ...fs(21), color: C.blueDark }}>{timeRange(e)}</p>
                                                    <p style={{ ...fs(18), color: C.muted }}>{e.description || e.title}</p>
                                                </div>
                                                <ChevronRight className="ml-auto h-8 w-8 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                </ViewWindow>
            )}

            {win === 'appointments' && (
                <ViewWindow id="rv-win-appointments" title={t('simpleView:appointments.title')} icon={<CalendarDays className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={windowProps.onClose}>
                    {eventNotice && (
                        <div
                            role={eventNotice.kind === 'error' ? 'alert' : 'status'}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4"
                            style={{ backgroundColor: C.card, border: `2px solid ${eventNotice.kind === 'error' ? C.red : C.border}` }}
                        >
                            <p className="font-bold" style={{ ...fs(21), color: eventNotice.kind === 'error' ? C.red : C.text }}>{eventNotice.text}</p>
                            <button type="button" onClick={() => setEventNotice(null)} className="min-h-[56px] min-w-[96px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                {t('simpleView:ok')}
                            </button>
                        </div>
                    )}

                    {/* Block L3: Termin selbst anlegen */}
                    <button
                        type="button"
                        onClick={openEventForm}
                        disabled={busy}
                        className="flex min-h-[64px] items-center justify-center gap-3 rounded-2xl px-5 font-bold text-white shadow-md disabled:opacity-70 sm:self-start"
                        style={{ ...fs(22), backgroundColor: C.blue }}
                    >
                        <CalendarPlus className="h-8 w-8 shrink-0" aria-hidden="true" />
                        {t('simpleView:event.new')}
                    </button>

                    {undoableEvents.length > 0 && (
                        <ul className="space-y-3">
                            {undoableEvents.map((own) => (
                                <li key={own.id} className="space-y-3 rounded-2xl p-4" style={tile}>
                                    <p className="font-bold" style={fs(21)}>
                                        {t('simpleView:event.entered', { title: own.title, when: whenText(own.start_time) })}
                                    </p>
                                    <div className="flex flex-wrap items-center gap-3">
                                        <button type="button" onClick={() => void undoEvent(own)} disabled={busy} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                                            <RotateCcw className="h-6 w-6 shrink-0" aria-hidden="true" />
                                            {t('medications:today.undo')}
                                        </button>
                                        <span style={{ ...fs(18), color: C.muted }}>
                                            {t('simpleView:meds.undoHint', { time: clockOf(new Date(own.undo_until ?? Date.now())) })}
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}

                    <section className="rounded-3xl p-5 sm:p-6" style={tile}>
                        {appointmentEvents.length === 0 ? (
                            <p style={fs(21)}>{t('simpleView:appointments.empty')}</p>
                        ) : (
                            <ul className="space-y-3">
                                {appointmentEvents.map((e) => (
                                    <li key={`${e.id}-${e.start_time}`}>
                                        <button
                                            type="button"
                                            onClick={() => setEventCard(e)}
                                            className="flex w-full items-center gap-4 rounded-2xl p-4 text-left"
                                            style={{ backgroundColor: C.card, color: C.text, border: `2px solid ${C.border}` }}
                                        >
                                            <span className="shrink-0 font-bold tabular-nums" style={{ ...fs(24), color: C.blueDark }}>{clockOf(e.start_time)}</span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block font-bold" style={fs(23)}>{e.title}</span>
                                                {e.location && <span className="block" style={{ ...fs(19), color: C.muted }}>{e.location}</span>}
                                            </span>
                                            <ChevronRight className="h-8 w-8 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                </ViewWindow>
            )}

            {win === 'contacts' && (
                <ViewWindow id="rv-win-contacts" title={t('simpleView:contacts.title')} icon={<Phone className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={windowProps.onClose}>
                        {contacts.length === 0 ? (
                            <p style={fs(21)}>{t('simpleView:contacts.empty')}</p>
                        ) : (
                            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                {contacts.map((c) => (
                                    <li key={c.id} className="flex flex-col gap-3 rounded-2xl p-4" style={{ backgroundColor: C.bg, border: `1px solid ${C.border}` }}>
                                        <div>
                                            <p className="font-bold" style={fs(23)}>{c.name}</p>
                                            <p style={{ ...fs(18), color: C.muted }}>
                                                {t(`simpleView:contacts.categories.${c.category}`, { defaultValue: c.category })}
                                                {c.organization ? ` · ${c.organization}` : ''}
                                            </p>
                                        </div>
                                        {c.phone && (
                                            <a
                                                href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}
                                                className="flex min-h-[64px] flex-wrap items-center justify-center gap-x-3 rounded-2xl px-4 font-bold text-white"
                                                style={{ ...fs(22), backgroundColor: C.blue }}
                                            >
                                                <Phone className="h-7 w-7 shrink-0" aria-hidden="true" />
                                                <span>{t('simpleView:contacts.call')}</span>
                                                <span className="tabular-nums">{c.phone}</span>
                                            </a>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                </ViewWindow>
            )}

            {win === 'ask' && (
                <ViewWindow id="rv-win-ask" title={t('simpleView:ask.button')} icon={<MessageCircle className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={closeAsk}>
                        {question === null ? (
                            <>
                                <p style={fs(21)}>{t('simpleView:ask.choose')}</p>
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    {questions.map((q) => {
                                        const { Icon, label } = QUESTION_INFO[q];
                                        return (
                                            <button
                                                key={q}
                                                type="button"
                                                onClick={() => void ask(q)}
                                                className="flex min-h-[80px] items-center gap-4 rounded-2xl px-5 py-3 text-left font-bold"
                                                style={{ ...fs(22), backgroundColor: C.blueSoft, color: C.blueDark, border: `2px solid ${C.blue}` }}
                                            >
                                                <Icon className="h-8 w-8 shrink-0" />
                                                {t(`companion:quick.${label}`)}
                                            </button>
                                        );
                                    })}
                                </div>
                            </>
                        ) : (
                            <>
                                <p className="font-bold" style={fs(24)}>{t(`companion:quick.${QUESTION_INFO[question].label}`)}</p>
                                <div className="rounded-3xl p-6" style={tile} role="status" aria-live="polite">
                                    <p style={{ ...fs(24), color: answer.state === 'error' ? C.red : C.text }}>
                                        {answer.state === 'loading' ? t('simpleView:ask.loading') : answer.text}
                                    </p>
                                </div>
                                <div className="flex flex-wrap gap-3">
                                    {voice && answer.state === 'done' && answer.text && (
                                        <button
                                            type="button"
                                            onClick={() => (speaking ? stopSpeaking() : readAloud(answer.text))}
                                            className="flex min-h-[64px] items-center gap-3 rounded-2xl px-5 font-bold text-white"
                                            style={{ ...fs(21), backgroundColor: C.blue }}
                                        >
                                            {speaking
                                                ? <Square className="h-7 w-7 shrink-0" aria-hidden="true" />
                                                : <Volume2 className="h-7 w-7 shrink-0" aria-hidden="true" />}
                                            {speaking ? t('simpleView:ask.stop') : t('simpleView:ask.readAloud')}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => { stopSpeaking(); setQuestion(null); }}
                                        className="flex min-h-[64px] items-center gap-3 rounded-2xl px-5 font-bold"
                                        style={secondaryButton}
                                    >
                                        <MessageCircle className="h-7 w-7 shrink-0" aria-hidden="true" />
                                        {t('simpleView:ask.other')}
                                    </button>
                                </div>
                            </>
                        )}
                </ViewWindow>
            )}

            {win === 'info' && (
                <ViewWindow id="rv-win-info" title={t('simpleView:info.title')} icon={<IdCard className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={windowProps.onClose}>
                    {info.state === 'loading' && <p style={fs(22)}>{t('simpleView:ask.loading')}</p>}
                    {info.state === 'error' && (
                        <div role="alert" className="flex flex-wrap items-center justify-between gap-4 rounded-3xl p-5" style={{ backgroundColor: C.redSoft, border: `2px solid ${C.red}` }}>
                            <p className="font-bold" style={fs(21)}>{t('simpleView:loadError')}</p>
                            <button type="button" onClick={() => void openInfo()} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                                <RotateCcw className="h-6 w-6 shrink-0" aria-hidden="true" />
                                {t('simpleView:reload')}
                            </button>
                        </div>
                    )}
                    {info.state === 'done' && (
                        <section className="rounded-3xl p-5 sm:p-6" style={tile}>
                            {info.data ? (
                                <dl className="space-y-4">
                                    <div>
                                        <dt className="font-bold" style={{ ...fs(20), color: C.muted }}>{t('simpleView:info.name')}</dt>
                                        <dd className="font-bold" style={fs(26)}>{[info.data.first_name, info.data.last_name].filter(Boolean).join(' ')}</dd>
                                    </div>
                                    {info.data.address && (
                                        <div>
                                            <dt className="font-bold" style={{ ...fs(20), color: C.muted }}>{t('simpleView:info.address')}</dt>
                                            <dd className="whitespace-pre-wrap font-bold" style={fs(24)}>{info.data.address}</dd>
                                        </div>
                                    )}
                                    {info.data.phone && (
                                        <div>
                                            <dt className="font-bold" style={{ ...fs(20), color: C.muted }}>{t('simpleView:info.phone')}</dt>
                                            <dd className="font-bold tabular-nums" style={fs(24)}>{info.data.phone}</dd>
                                        </div>
                                    )}
                                </dl>
                            ) : (
                                <p style={fs(21)}>{t('simpleView:info.empty')}</p>
                            )}
                        </section>
                    )}
                    {info.state === 'done' && contactsOn && contacts.length > 0 && (
                        <section className="rounded-3xl p-5 sm:p-6" style={tile} aria-labelledby="rv-info-contacts">
                            <h3 id="rv-info-contacts" className="mb-3" style={sectionTitle(C.text)}>{t('simpleView:info.contacts')}</h3>
                            <ul className="space-y-3">
                                {contacts.map((c) => (
                                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4" style={{ backgroundColor: C.bg, border: `1px solid ${C.border}` }}>
                                        <span className="min-w-0">
                                            <span className="block font-bold" style={fs(22)}>{c.name}</span>
                                            <span className="block" style={{ ...fs(18), color: C.muted }}>
                                                {t(`simpleView:contacts.categories.${c.category}`, { defaultValue: c.category })}
                                                {c.organization ? ` · ${c.organization}` : ''}
                                            </span>
                                        </span>
                                        {c.phone && <span className="font-bold tabular-nums" style={fs(22)}>{c.phone}</span>}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                </ViewWindow>
            )}

            {win === 'shopping' && (
                <ViewWindow id="rv-win-shopping" title={t('simpleView:tiles.shopping')} icon={<ShoppingCart className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={windowProps.onClose}>
                    {shopNotice && (
                        <div
                            role={shopNotice.kind === 'error' ? 'alert' : 'status'}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4"
                            style={{ backgroundColor: C.card, border: `2px solid ${shopNotice.kind === 'error' ? C.red : C.border}` }}
                        >
                            <p className="font-bold" style={{ ...fs(21), color: shopNotice.kind === 'error' ? C.red : C.text }}>{shopNotice.text}</p>
                            <button type="button" onClick={() => setShopNotice(null)} className="min-h-[56px] min-w-[96px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                {t('simpleView:ok')}
                            </button>
                        </div>
                    )}

                    <form className="rounded-3xl p-5 sm:p-6" style={tile} onSubmit={(ev) => { ev.preventDefault(); requestAdd(); }} noValidate>
                        <label htmlFor="rv-shop-input" className="block font-bold" style={fs(22)}>{t('simpleView:shopping.label')}</label>
                        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                            <input
                                id="rv-shop-input"
                                type="text"
                                autoComplete="off"
                                maxLength={100}
                                value={shopText}
                                onChange={(ev) => { setShopText(ev.target.value); setShopError(false); }}
                                aria-invalid={shopError ? true : undefined}
                                aria-describedby={shopError ? 'rv-shop-error' : undefined}
                                className="min-h-[64px] w-full min-w-0 flex-1 rounded-2xl px-4 font-bold"
                                style={{ ...fs(24), backgroundColor: C.card, color: C.text, border: `2px solid ${shopError ? C.red : C.control}` }}
                            />
                            <button type="submit" disabled={busy} className="flex min-h-[64px] shrink-0 items-center justify-center gap-2 rounded-2xl px-5 font-bold text-white disabled:opacity-70" style={{ ...fs(21), backgroundColor: C.blue }}>
                                <Plus className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                                {t('simpleView:shopping.add')}
                            </button>
                        </div>
                        {shopError && (
                            <p id="rv-shop-error" role="alert" className="mt-2 font-bold" style={{ ...fs(20), color: C.red }}>{t('simpleView:shopping.error')}</p>
                        )}
                    </form>

                    <section className="rounded-3xl p-5 sm:p-6" style={tile} aria-labelledby="rv-shop-open">
                        <h3 id="rv-shop-open" className="mb-4" style={sectionTitle(C.text)}>{t('simpleView:shopping.open')}</h3>
                        {openShopping.length === 0 ? (
                            <p style={fs(21)}>{t('simpleView:shopping.empty')}</p>
                        ) : (
                            <ul className="space-y-3">
                                {openShopping.map((item) => (
                                    <li key={item.id} className="space-y-3 rounded-2xl p-4" style={{ backgroundColor: C.bg, border: `1px solid ${C.border}` }}>
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <p className="min-w-0 font-bold" style={fs(23)}>{item.name}{shopAmount(item)}</p>
                                            <button type="button" onClick={() => setShopConfirm({ kind: 'check', item })} disabled={busy} className="flex min-h-[64px] items-center gap-2 rounded-2xl px-5 font-bold" style={{ ...secondaryButton, border: `2px solid ${C.blue}` }}>
                                                <Check className="h-7 w-7 shrink-0" strokeWidth={3} style={{ color: C.blue }} aria-hidden="true" />
                                                {t('simpleView:shopping.check')}
                                            </button>
                                        </div>
                                        {canUndoAdd(item) && (
                                            <div className="flex flex-wrap items-center gap-3">
                                                <button type="button" onClick={() => void undoShopping(item)} disabled={busy} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                                                    <RotateCcw className="h-6 w-6 shrink-0" aria-hidden="true" />
                                                    {t('medications:today.undo')}
                                                </button>
                                                <span style={{ ...fs(18), color: C.muted }}>
                                                    {t('simpleView:meds.undoHint', { time: clockOf(new Date((item.added_undo_until) ?? Date.now())) })}
                                                </span>
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    {doneShopping.length > 0 && (
                        <section className="rounded-3xl p-5 sm:p-6" style={tile} aria-labelledby="rv-shop-done">
                            <h3 id="rv-shop-done" className="mb-4" style={sectionTitle(C.text)}>{t('simpleView:shopping.done')}</h3>
                            <ul className="space-y-3">
                                {doneShopping.map((item) => (
                                    <li key={item.id} className="space-y-3 rounded-2xl p-4" style={{ backgroundColor: C.bg, border: `1px solid ${C.border}` }}>
                                        <p className="flex items-center gap-2 font-bold" style={fs(21)}>
                                            <Check className="h-7 w-7 shrink-0" strokeWidth={3} style={{ color: C.blue }} aria-hidden="true" />
                                            {item.name}{shopAmount(item)}
                                        </p>
                                        {canUndoCheck(item) && (
                                            <div className="flex flex-wrap items-center gap-3">
                                                <button type="button" onClick={() => void undoShopping(item)} disabled={busy} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                                                    <RotateCcw className="h-6 w-6 shrink-0" aria-hidden="true" />
                                                    {t('medications:today.undo')}
                                                </button>
                                                <span style={{ ...fs(18), color: C.muted }}>
                                                    {t('simpleView:meds.undoHint', { time: clockOf(new Date((item.checked_undo_until) ?? Date.now())) })}
                                                </span>
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                </ViewWindow>
            )}

            {win === 'settings' && (
                <ViewWindow id="rv-win-settings" title={t('simpleView:settings.title')} icon={<SettingsIcon className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={windowProps.onClose}>
                    <section className="rounded-3xl p-5 sm:p-6" style={tile}>
                        <fieldset className="mt-6">
                            <legend className="mb-3 font-bold" style={fs(22)}>{t('simpleView:settings.fontSize')}</legend>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                {FONT_SCALES.map((scale, idx) => {
                                    const active = fontScale === scale;
                                    return (
                                        <button
                                            key={scale}
                                            type="button"
                                            aria-pressed={active}
                                            onClick={() => { setFontScale(scale); saveFontScale(scale); }}
                                            className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-3 font-bold"
                                            style={active ? activeChoice : secondaryButton}
                                        >
                                            {active && <Check className="h-6 w-6 shrink-0" strokeWidth={3} aria-hidden="true" />}
                                            {t(idx === 0 ? 'simpleView:settings.fontNormal' : idx === 1 ? 'simpleView:settings.fontLarge' : 'simpleView:settings.fontXL')}
                                        </button>
                                    );
                                })}
                            </div>
                        </fieldset>

                        <fieldset className="mt-6">
                            <legend className="mb-3 font-bold" style={fs(22)}>{t('simpleView:settings.color')}</legend>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                {VIEW_COLORS.map((color) => {
                                    const active = accent.id === color.id;
                                    return (
                                        <button
                                            key={color.id}
                                            type="button"
                                            aria-pressed={active}
                                            onClick={() => void chooseColor(color.id)}
                                            className="flex min-h-[64px] items-center gap-3 rounded-2xl px-4 text-left font-bold"
                                            style={{
                                                ...fs(20),
                                                backgroundColor: active ? color.soft : C.card,
                                                color: C.text,
                                                border: `${active ? 3 : 2}px solid ${active ? color.dark : C.control}`,
                                            }}
                                        >
                                            <span className="h-9 w-9 shrink-0 rounded-full" style={{ backgroundColor: color.strong }} aria-hidden="true" />
                                            <span className="flex-1">{t(`simpleView:colors.${color.id}`)}</span>
                                            {active && <Check className="h-6 w-6 shrink-0" strokeWidth={3} style={{ color: color.dark }} aria-hidden="true" />}
                                        </button>
                                    );
                                })}
                            </div>
                            {colorError && (
                                <p role="alert" className="mt-3 font-bold" style={{ ...fs(20), color: C.red }}>{t('simpleView:settings.colorError')}</p>
                            )}
                        </fieldset>

                        <fieldset className="mt-6">
                            <legend className="mb-3 font-bold" style={fs(22)}>{t('simpleView:settings.language')}</legend>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                {SUPPORTED_LANGUAGES.map((lng) => {
                                    const active = language === lng;
                                    return (
                                        <button
                                            key={lng}
                                            type="button"
                                            lang={lng}
                                            aria-pressed={active}
                                            onClick={() => void changeAppLanguage(lng)}
                                            className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-3 font-bold"
                                            style={active ? activeChoice : secondaryButton}
                                        >
                                            {active && <Check className="h-6 w-6 shrink-0" strokeWidth={3} aria-hidden="true" />}
                                            {LANGUAGE_NAMES[lng] ?? lng}
                                        </button>
                                    );
                                })}
                            </div>
                        </fieldset>
                    </section>
                </ViewWindow>
            )}

            {/* Block L3: grosse Terminkarte */}
            {eventCard && (() => {
                const e = eventCard;
                const people = peopleOf(e);
                const row = (Icon: React.FC<{ className?: string; style?: React.CSSProperties }>, label: string, value: React.ReactNode) => (
                    <div className="flex items-start gap-4">
                        <Icon className="mt-1 h-8 w-8 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
                        <div className="min-w-0">
                            <p className="font-bold" style={{ ...fs(20), color: C.muted }}>{label}</p>
                            <div style={fs(23)}>{value}</div>
                        </div>
                    </div>
                );
                const travel = isTravelActive(e);
                const start = clockDate(e.start_time);
                const leave = start && e.travel_to_minutes ? new Date(start.getTime() - e.travel_to_minutes * 60_000) : null;
                const driverText = (name: string | null | undefined) =>
                    (name || '').trim() ? t('calendar:card.driver', { name: (name || '').trim() }) : t('calendar:card.driverMissing');
                return (
                    <ViewWindow id="rv-win-event" title={e.title} icon={<CalendarDays className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={() => setEventCard(null)}>
                        <section className="space-y-5 rounded-3xl p-5 sm:p-6" style={tile}>
                            {row(CalendarClock, t('simpleView:event.time'), <span className="font-bold tabular-nums" style={fs(30)}>{timeRange(e)}</span>)}
                            {e.location && row(MapPin, t('simpleView:event.place'), <span className="font-bold">{e.location}</span>)}
                            {travel && e.travel_to_minutes != null && leave && row(Car, t('simpleView:event.travelTo'), (
                                <>
                                    <span className="block font-bold">{t('calendar:card.travelTo', { time: clockOf(leave) })}</span>
                                    <span className="block">{driverText(e.driver_to)}</span>
                                </>
                            ))}
                            {travel && e.travel_back_minutes != null && row(Car, t('simpleView:event.travelBack'), (
                                <>
                                    <span className="block font-bold">{t('calendar:card.travelBack', { time: clockOf(e.end_time || e.start_time) })}</span>
                                    <span className="block">{driverText(e.driver_back)}</span>
                                </>
                            ))}
                            {people.length > 0 && row(Users, t('simpleView:event.companion'), <span className="font-bold">{people.join(', ')}</span>)}
                            {e.take_along && row(Backpack, t('simpleView:event.takeAlong'), <span className="whitespace-pre-wrap font-bold">{e.take_along}</span>)}
                            {e.description && <p className="whitespace-pre-wrap" style={fs(21)}>{e.description}</p>}
                        </section>
                    </ViewWindow>
                );
            })()}

            {/* Block L3: neuer Termin, erst die Angaben, dann die Rueckfrage */}
            {eventForm && (
                <div className={dialogLayer} style={{ lineHeight: 1.5, ['--k' as string]: String(fontScale) }} role="dialog" aria-modal="true" aria-labelledby="rv-event-title">
                    <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
                    <div className={cn(overlayBox, 'max-w-xl font-kiosk')} style={tile}>
                        <h2 id="rv-event-title" className="font-bold" style={fs(26)}>{t('simpleView:event.new')}</h2>
                        {eventForm.step === 'enter' ? (
                            <form className="mt-4 space-y-5" onSubmit={(ev) => { ev.preventDefault(); checkEvent(); }} noValidate>
                                {([
                                    ['title', 'text', eventForm.title],
                                    ['date', 'date', eventForm.day],
                                    ['time', 'time', eventForm.time],
                                ] as const).map(([field, type, value]) => (
                                    <div key={field}>
                                        <label htmlFor={`rv-event-${field}`} className="block font-bold" style={fs(21)}>{t(`simpleView:event.label.${field}`)}</label>
                                        <input
                                            id={`rv-event-${field}`}
                                            type={type}
                                            autoComplete="off"
                                            autoFocus={field === 'title'}
                                            maxLength={field === 'title' ? 120 : undefined}
                                            value={value}
                                            onChange={(ev) => {
                                                const next = ev.target.value;
                                                setEventForm({
                                                    ...eventForm,
                                                    ...(field === 'title' ? { title: next } : field === 'date' ? { day: next } : { time: next }),
                                                    error: null,
                                                });
                                            }}
                                            aria-invalid={eventForm.error === field ? true : undefined}
                                            aria-describedby={eventForm.error === field ? 'rv-event-error' : undefined}
                                            className="mt-2 min-h-[64px] w-full min-w-0 rounded-2xl px-4 font-bold"
                                            style={{ ...fs(24), backgroundColor: C.card, color: C.text, border: `2px solid ${eventForm.error === field ? C.red : C.control}` }}
                                        />
                                        {eventForm.error === field && (
                                            <p id="rv-event-error" role="alert" className="mt-2 font-bold" style={{ ...fs(20), color: C.red }}>
                                                {t(`simpleView:event.error.${field}`)}
                                            </p>
                                        )}
                                    </div>
                                ))}
                                <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
                                    <button type="button" onClick={() => setEventForm(null)} className="min-h-[64px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                        {t('simpleView:measure.cancel')}
                                    </button>
                                    <button type="submit" className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white" style={{ ...fs(21), backgroundColor: C.blue }}>
                                        <ChevronRight className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                                        {t('simpleView:measure.next')}
                                    </button>
                                </div>
                            </form>
                        ) : (
                            <div className="mt-4">
                                <p style={fs(21)}>{t('simpleView:measure.question')}</p>
                                <div className="mt-3 rounded-2xl p-4" style={{ backgroundColor: C.blueSoft, color: C.blueDark }}>
                                    <p className="font-bold" style={fs(26)}>{eventForm.title.trim()}</p>
                                    <p className="font-bold" style={fs(22)}>{whenText(`${eventForm.day}T${eventForm.time}`)}</p>
                                </div>
                                <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <button type="button" onClick={() => setEventForm({ ...eventForm, step: 'enter' })} className="min-h-[64px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                        {t('simpleView:measure.change')}
                                    </button>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void saveEvent()}
                                        className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white disabled:opacity-70"
                                        style={{ ...fs(21), backgroundColor: C.blue }}
                                    >
                                        <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                                        {t('simpleView:measure.save')}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Block L4: Rueckfrage vor dem Hinzufuegen und Abhaken */}
            {shopConfirm && (
                <div className={dialogLayer} style={{ lineHeight: 1.5, ['--k' as string]: String(fontScale) }} role="alertdialog" aria-modal="true" aria-labelledby="rv-shop-confirm-title">
                    <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
                    <div className={cn(overlayBox, 'max-w-xl font-kiosk')} style={tile}>
                        <h2 id="rv-shop-confirm-title" className="font-bold" style={fs(26)}>
                            {shopConfirm.kind === 'add' ? t('simpleView:shopping.addQuestion') : t('simpleView:shopping.checkQuestion')}
                        </h2>
                        <p className="mt-3 rounded-2xl p-4 font-bold" style={{ ...fs(26), backgroundColor: C.blueSoft, color: C.blueDark }}>
                            {shopConfirm.kind === 'add' ? shopConfirm.name : `${shopConfirm.item.name}${shopAmount(shopConfirm.item)}`}
                        </p>
                        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <button type="button" onClick={() => setShopConfirm(null)} className="min-h-[64px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                {shopConfirm.kind === 'add' ? t('simpleView:measure.change') : t('medications:today.allTakenNo')}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => void confirmShopping()}
                                className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white disabled:opacity-70"
                                style={{ ...fs(21), backgroundColor: C.blue }}
                            >
                                <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                                {shopConfirm.kind === 'add' ? t('simpleView:shopping.addYes') : t('simpleView:shopping.checkYes')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Rueckfrage: alle einer Tageszeit genommen (Fenster) bzw. alle gezeigten (Kachel) */}
            {takeAllDialog && (
                <div className={dialogLayer} style={{ lineHeight: 1.5, ['--k' as string]: String(fontScale) }} role="dialog" aria-modal="true" aria-labelledby="rv-confirm-title">
                    <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
                    <div className={cn(overlayBox, 'max-w-xl font-kiosk')} style={tile}>
                        <h2 id="rv-confirm-title" className="font-bold" style={fs(26)}>{takeAllDialog.title}</h2>
                        <p className="mt-2" style={fs(21)}>{t('medications:today.allTakenQuestion')}</p>
                        <ul className="mt-4 space-y-2">
                            {takeAllDialog.items.map((i) => (
                                <li key={i.id} className="flex items-start gap-3" style={fs(21)}>
                                    <Pill className="mt-1 h-6 w-6 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
                                    <span>{i.medication_name}{i.medication_dosage ? ` ${i.medication_dosage}` : ''}: {formatAmount(t, i.quantity, i.unit, i.form)}</span>
                                </li>
                            ))}
                        </ul>
                        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <button type="button" onClick={closeTakeAll} className="min-h-[64px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                {t('medications:today.allTakenNo')}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                    const ids = takeAllDialog.items.map((i) => i.id);
                                    closeTakeAll();
                                    void confirmMany(ids);
                                }}
                                className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white"
                                style={{ ...fs(21), backgroundColor: C.green }}
                            >
                                <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                                {t('medications:today.allTakenYes')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Block M: Rueckfrage vor dem Ueberspringen */}
            {skipConfirm && skipConfirm.length > 0 && (
                <div className={dialogLayer} style={{ lineHeight: 1.5, ['--k' as string]: String(fontScale) }} role="alertdialog" aria-modal="true" aria-labelledby="rv-skip-title" aria-describedby="rv-skip-hint">
                    <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
                    <div className={cn(overlayBox, 'max-w-xl font-kiosk')} style={tile}>
                        <h2 id="rv-skip-title" className="font-bold" style={fs(26)}>{t('simpleView:home.skipTitle')}</h2>
                        <ul className="mt-4 space-y-2">
                            {skipConfirm.map((i) => (
                                <li key={i.id} className="flex items-start gap-3" style={fs(21)}>
                                    <Pill className="mt-1 h-6 w-6 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
                                    <span>{intakeLabel(i)}: {formatAmount(t, i.quantity, i.unit, i.form)}</span>
                                </li>
                            ))}
                        </ul>
                        <p id="rv-skip-hint" className="mt-4" style={fs(21)}>{t('simpleView:home.skipHint')}</p>
                        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <button type="button" onClick={() => setSkipConfirm(null)} className="min-h-[64px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                {t('simpleView:home.skipNo')}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                    const ids = skipConfirm.map((i) => i.id);
                                    setSkipConfirm(null);
                                    void skipMany(ids);
                                }}
                                className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white disabled:opacity-70"
                                style={{ ...fs(21), backgroundColor: C.blue }}
                            >
                                <SkipForward className="h-7 w-7 shrink-0" aria-hidden="true" />
                                {t('simpleView:home.skipYes')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Block K: Messwert eintragen, erst die Zahl, dann die Rueckfrage */}
            {vitalForm && (
                <div className={dialogLayer} style={{ lineHeight: 1.5, ['--k' as string]: String(fontScale) }} role="dialog" aria-modal="true" aria-labelledby="rv-measure-title">
                    <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
                    <div className={cn(overlayBox, 'max-w-xl font-kiosk')} style={tile}>
                        <h2 id="rv-measure-title" className="font-bold" style={fs(26)}>{t(`simpleView:measure.button.${vitalForm.type}`)}</h2>
                        {vitalForm.step === 'enter' ? (
                            <form
                                className="mt-4"
                                onSubmit={(e) => { e.preventDefault(); checkVital(); }}
                                noValidate
                            >
                                <label htmlFor="rv-measure-input" className="block font-bold" style={fs(21)}>
                                    {t(`simpleView:measure.label.${vitalForm.type}`, { unit: vitalUnit(vitalForm.type) })}
                                </label>
                                <div className="mt-2 flex items-center gap-3">
                                    <input
                                        id="rv-measure-input"
                                        type="text"
                                        inputMode="decimal"
                                        autoComplete="off"
                                        autoFocus
                                        value={vitalForm.text}
                                        onChange={(e) => setVitalForm({ ...vitalForm, text: e.target.value, error: null })}
                                        aria-invalid={vitalForm.error ? true : undefined}
                                        aria-describedby={vitalForm.error ? 'rv-measure-error' : undefined}
                                        className="min-h-[72px] w-full min-w-0 rounded-2xl px-4 font-bold tabular-nums"
                                        style={{ ...fs(32), backgroundColor: C.card, color: C.text, border: `2px solid ${vitalForm.error ? C.red : C.control}` }}
                                    />
                                    <span className="shrink-0 font-bold" style={fs(24)}>{vitalUnit(vitalForm.type)}</span>
                                </div>
                                {vitalForm.error && (
                                    <p id="rv-measure-error" role="alert" className="mt-2 font-bold" style={{ ...fs(20), color: C.red }}>
                                        {t(`simpleView:measure.error.${vitalForm.error}`)}
                                    </p>
                                )}
                                <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <button type="button" onClick={() => setVitalForm(null)} className="min-h-[64px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                        {t('simpleView:measure.cancel')}
                                    </button>
                                    <button type="submit" className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white" style={{ ...fs(21), backgroundColor: C.blue }}>
                                        <ChevronRight className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                                        {t('simpleView:measure.next')}
                                    </button>
                                </div>
                            </form>
                        ) : (
                            <div className="mt-4">
                                <p style={fs(21)}>{t('simpleView:measure.question')}</p>
                                <p className="mt-3 rounded-2xl p-4 text-center font-bold tabular-nums" style={{ ...fs(36), backgroundColor: C.blueSoft, color: C.blueDark }}>
                                    {(() => {
                                        const parsed = parseRecipientVital(vitalForm.type, vitalForm.text, (shown) => toStorageValue(vitalForm.type, shown, unitSystem));
                                        return parsed.ok ? vitalText(vitalForm.type, parsed.stored) : vitalForm.text;
                                    })()}
                                </p>
                                <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <button type="button" onClick={() => setVitalForm({ ...vitalForm, step: 'enter' })} className="min-h-[64px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                        {t('simpleView:measure.change')}
                                    </button>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void saveVital()}
                                        className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white disabled:opacity-70"
                                        style={{ ...fs(21), backgroundColor: C.blue }}
                                    >
                                        <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                                        {t('simpleView:measure.save')}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Erinnerung (Eskalation Stufe 1): ruhig, eine klare Taste */}
            {reminderOpen && medsOn && dueNow.length > 0 && (
                <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-6 overflow-y-auto p-6 text-center font-kiosk" style={rootStyle} role="alertdialog" aria-modal="true" aria-labelledby="rv-reminder-title">
                    <div className="flex h-32 w-32 items-center justify-center rounded-full" style={{ backgroundColor: C.blue }}>
                        <Pill className="h-16 w-16 text-white" aria-hidden="true" />
                    </div>
                    <h2 id="rv-reminder-title" className="font-bold" style={{ ...fs(36), lineHeight: 1.3 }}>{t('simpleView:reminder.title')}</h2>
                    <p style={fs(24)}>{t('simpleView:reminder.subtitle', { count: dueNow.length })}</p>
                    <ul className="flex flex-wrap justify-center gap-2">
                        {dueNow.map((i) => (
                            <li key={i.id} className="rounded-full px-5 py-2 font-bold" style={{ ...fs(21), ...tile }}>{i.medication_name}</li>
                        ))}
                    </ul>
                    <div className="flex w-full max-w-xl flex-col gap-3 sm:flex-row">
                        <button
                            type="button"
                            onClick={() => { setReminderOpen(false); void confirmMany(dueNow.map((i) => i.id)); }}
                            className="flex min-h-[72px] flex-1 items-center justify-center gap-3 rounded-2xl px-4 font-bold text-white shadow-md"
                            style={{ ...fs(23), backgroundColor: C.green }}
                        >
                            <Check className="h-8 w-8 shrink-0" strokeWidth={3} aria-hidden="true" />
                            {t('simpleView:reminder.taken')}
                        </button>
                        <button type="button" onClick={() => setReminderOpen(false)} className="min-h-[72px] flex-1 rounded-2xl px-4 font-bold" style={secondaryButton}>
                            {t('simpleView:reminder.later')}
                        </button>
                    </div>
                </div>
            )}

            {/* Abmelden mit Rueckfrage */}
            {logoutOpen && (
                <div className={dialogLayer} style={{ lineHeight: 1.5, ['--k' as string]: String(fontScale) }} role="alertdialog" aria-modal="true" aria-labelledby="rv-logout-title" aria-describedby="rv-logout-hint">
                    <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
                    <div className={cn(overlayBox, 'max-w-lg')} style={tile}>
                        <h2 id="rv-logout-title" className="font-bold" style={fs(26)}>{t('simpleView:logout.title')}</h2>
                        <p id="rv-logout-hint" className="mt-2" style={fs(21)}>{t('simpleView:logout.hint')}</p>
                        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <button type="button" onClick={() => setLogoutOpen(false)} className="min-h-[64px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                {t('simpleView:logout.no')}
                            </button>
                            <button
                                type="button"
                                onClick={() => { setLogoutOpen(false); logout(); }}
                                className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white"
                                style={{ ...fs(21), backgroundColor: C.blue }}
                            >
                                <LogOut className="h-6 w-6 shrink-0" aria-hidden="true" />
                                {t('simpleView:logout.yes')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default RecipientView;
