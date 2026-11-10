import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    CalendarDays, Check, CheckCheck, LogOut, MapPin, MessageCircle, Phone, Pill, RotateCcw,
    Settings as SettingsIcon, ThermometerSun, Users, Backpack, Car, Volume2, Square, X,
    Stethoscope, CalendarRange, CalendarClock,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import type { CircleSummary } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { formatClock, intlLocale } from '../i18n/format';
import { clockDate } from '../lib/clock';
import { SUPPORTED_LANGUAGES, LANGUAGE_NAMES } from '../i18n';
import { changeAppLanguage } from '../lib/language';
import { formatAmount } from '../lib/medications';
import { isFeatureEnabled, type FeatureId } from '../lib/features';
import { cn } from '../lib/utils';
import {
    FONT_SCALES, MOMENTS, RECIPIENT_QUESTIONS, isCompanionActive, isTravelActive, loadFontScale,
    localDay, momentOf, saveFontScale, type Moment, type RecipientQuestion,
} from '../lib/recipientView';

// Einfache Ansicht der betreuten Person (Rolle recipient), Launch Block C.
// Ersetzt die fruehere Tablet-Ansicht (Kiosk): gleiche ruhige Gestaltung (helle
// Kacheln, grosse Schrift, Atkinson Hyperlegible), aber mit dem eigenen Konto und
// nur ueber die normalen API-Routen, die middleware/circle.ts fuer recipient
// freigibt. Schreiben kann sie nur eines: Einnahmen als genommen bestaetigen
// (mit Rueckgaengig, 10 Minuten). Kein Menue, keine anderen Seiten (App.tsx).
// Palette fest und hell, wie zuvor im Kiosk: das dunkle Thema der App gilt hier nicht.
const C = {
    bg: '#f5f7fb',
    card: '#ffffff',
    border: '#d5dbe6',
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

type Notice = { kind: 'ok' | 'error' | 'queued'; text: string } | null;

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
const PersonPhoto: React.FC<{ name: string; url: string | null; size: number }> = ({ name, url, size }) =>
    url ? (
        <img src={url} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size, border: `3px solid ${C.border}` }} />
    ) : (
        <div
            className="flex shrink-0 items-center justify-center rounded-full font-bold"
            style={{ width: size, height: size, backgroundColor: C.blueSoft, color: C.blue, fontSize: size * 0.42 }}
            aria-hidden="true"
        >
            {(name.trim().charAt(0) || '?').toUpperCase()}
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
    const { t, i18n } = useTranslation(['simpleView', 'medications', 'calendar', 'companion']);
    const { logout } = useAuth();

    const [now, setNow] = useState(() => new Date());
    const [fontScale, setFontScale] = useState<number>(loadFontScale);

    const [intakes, setIntakes] = useState<Intake[]>([]);
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [heat, setHeat] = useState<Heatwave | null>(null);
    const [loadError, setLoadError] = useState(false);

    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<Notice>(null);
    const [confirmMoment, setConfirmMoment] = useState<Moment | null>(null);

    const [settingsOpen, setSettingsOpen] = useState(false);
    const [logoutOpen, setLogoutOpen] = useState(false);
    const [reminderOpen, setReminderOpen] = useState(false);
    const [askOpen, setAskOpen] = useState(false);
    const [question, setQuestion] = useState<RecipientQuestion | null>(null);
    const [answer, setAnswer] = useState<{ state: 'loading' | 'done' | 'error'; text: string }>({ state: 'loading', text: '' });
    const [speaking, setSpeaking] = useState(false);

    const settings = circle.settings;
    const on = (id: FeatureId) => isFeatureEnabled(settings, id);
    const medsOn = on('medications');
    const calendarOn = on('calendar');
    const contactsOn = on('contacts');
    const heatOn = on('heatwave');

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

    const load = useCallback(async () => {
        const jobs: Promise<unknown>[] = [];
        if (medsOn) jobs.push(loadIntakes());
        if (calendarOn) {
            jobs.push(api.get<{ success: boolean; data: CalendarEvent[] }>(`/api/events?from=${day}&to=${day}`)
                .then((res) => setEvents(res.data ?? [])));
        }
        if (contactsOn) {
            jobs.push(api.get<{ success: boolean; data: Contact[] }>('/api/contacts')
                .then((res) => setContacts(res.data ?? [])));
        }
        if (heatOn) {
            jobs.push(api.get<{ success: boolean; data: Heatwave }>('/api/heatwave')
                .then((res) => setHeat(res.data ?? null)));
        }
        const results = await Promise.allSettled(jobs);
        setLoadError(results.some((r) => r.status === 'rejected'));
    }, [medsOn, calendarOn, contactsOn, heatOn, day, loadIntakes]);

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
    useWebSocketUpdates('reminder', () => {
        void load();
        setReminderOpen(true);
    });

    // Rueckgaengig verschwindet genau dann, wenn die vom Server genannte Zeit um ist.
    const [undoClock, setUndoClock] = useState(() => Date.now());
    useEffect(() => {
        const next = intakes.reduce(
            (min, i) => (i.undo_until && i.undo_until > undoClock ? Math.min(min, i.undo_until) : min),
            Infinity
        );
        if (next === Infinity) return;
        const id = window.setTimeout(() => setUndoClock(Date.now()), Math.max(0, next - Date.now()) + 50);
        return () => window.clearTimeout(id);
    }, [intakes, undoClock]);
    const canUndo = (i: Intake) => i.status === 'taken' && Boolean(i.undo_until && i.undo_until > undoClock);

    // Erfolgsmeldungen bleiben 10 s stehen, Fehler bis zum Schliessen.
    useEffect(() => {
        if (!notice || notice.kind === 'error') return;
        const id = window.setTimeout(() => setNotice(null), 10_000);
        return () => window.clearTimeout(id);
    }, [notice]);

    // ── Einnahmen ──

    const isOpen = (i: Intake) => i.status === 'pending' || i.status === 'missed';
    const byMoment = useMemo(() => {
        const groups: Record<Moment, Intake[]> = { morning: [], noon: [], evening: [], night: [] };
        for (const i of intakes) {
            const due = clockDate(i.due_at);
            groups[momentOf(due ? due.getHours() : 12)].push(i);
        }
        for (const m of MOMENTS) groups[m].sort((a, b) => a.due_at.localeCompare(b.due_at));
        return groups;
    }, [intakes]);
    const dueNow = intakes.filter((i) => isOpen(i) && (clockDate(i.due_at)?.getTime() ?? Infinity) <= now.getTime());

    /** Offline in der Warteschlange: lokal als genommen zeigen, ohne Rueckgaengig. */
    const markLocally = (ids: string[]) =>
        setIntakes((prev) => prev.map((i) => (ids.includes(i.id) ? { ...i, status: 'taken', confirmed_at: null, undo_until: undefined } : i)));

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
        setAskOpen(false);
        setQuestion(null);
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

    const visitorEvents = events.filter((e) => e.category !== 'medical');
    const appointmentEvents = events.filter((e) => e.category === 'medical');
    const heatActive = Boolean(heat?.enabled && heat?.active);
    const heatRed = heat?.level === 'red';

    const timeRange = (e: CalendarEvent) =>
        e.end_time ? `${clockOf(e.start_time)} – ${clockOf(e.end_time)}` : clockOf(e.start_time);
    /** Wer dabei ist: nur wenn "Jemand muss mitkommen" aktiv ist (eventExtras.ts). */
    const peopleOf = (e: CalendarEvent): string[] => isCompanionActive(e)
        ? [...(e.members_data ?? []).map((m) => m.name), ...(e.guests ?? [])]
        : [];
    /** Fahrt wie im Kalender (calendar:card.*), nur wenn "Jemand muss fahren" aktiv ist. */
    const travelLines = (e: CalendarEvent): string[] => {
        if (!isTravelActive(e)) return [];
        const lines: string[] = [];
        if (e.travel_to_minutes) {
            const start = clockDate(e.start_time);
            const leave = start ? new Date(start.getTime() - e.travel_to_minutes * 60_000) : null;
            const driver = (e.driver_to || '').trim();
            if (leave) lines.push(t('calendar:card.travelTo', { time: clockOf(leave) }) + (driver ? ` · ${t('calendar:card.driver', { name: driver })}` : ''));
        }
        if (e.travel_back_minutes) {
            const driver = (e.driver_back || '').trim();
            lines.push(t('calendar:card.travelBack', { time: clockOf(e.end_time || e.start_time) }) + (driver ? ` · ${t('calendar:card.driver', { name: driver })}` : ''));
        }
        return lines;
    };

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

    return (
        <div className="min-h-screen font-kiosk" style={rootStyle}>
            <div className="mx-auto flex min-h-screen w-full max-w-[1200px] flex-col gap-5 px-4 pb-12 pt-3 sm:px-6">
                {/* Kopfzeile: Datum, Uhr, Einstellungen, Abmelden (immer mit Text) */}
                <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3" style={tile}>
                    <div className="flex items-center gap-4">
                        <img src={`${import.meta.env.BASE_URL}OpenCare.png`} alt="" className="h-12 w-12 rounded-xl" />
                        <div>
                            <p className="font-bold first-letter:uppercase" style={{ ...fs(20), color: C.muted }}>{dateLabel}</p>
                            <p className="font-bold tabular-nums" style={{ ...fs(36), lineHeight: 1.2 }}>{clockOf(now)}</p>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <button type="button" onClick={() => setSettingsOpen(true)} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-4 font-bold" style={secondaryButton}>
                            <SettingsIcon className="h-6 w-6 shrink-0" aria-hidden="true" />
                            {t('simpleView:header.settings')}
                        </button>
                        <button type="button" onClick={() => setLogoutOpen(true)} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-4 font-bold" style={secondaryButton}>
                            <LogOut className="h-6 w-6 shrink-0" aria-hidden="true" />
                            {t('simpleView:header.logout')}
                        </button>
                    </div>
                </header>

                {/* Begruessung mit Foto */}
                <section
                    className="relative overflow-hidden rounded-3xl"
                    style={{ minHeight: 180, backgroundImage: `url(${HERO_IMAGE})`, backgroundSize: 'cover', backgroundPosition: 'center right' }}
                >
                    <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.9) 50%, rgba(255,255,255,0.2) 80%, rgba(255,255,255,0) 100%)' }} />
                    <div className="relative flex min-h-[180px] items-center gap-5 p-5 sm:p-7">
                        <PersonPhoto name={name} url={circle.recipient_photo_url} size={88} />
                        <div>
                            <h1 className="font-bold" style={{ ...fs(40), color: C.blueDark, lineHeight: 1.2 }}>{greeting}</h1>
                            <p className="mt-1 font-bold" style={{ ...fs(22), color: C.blueDark }}>{t('simpleView:tagline')}</p>
                        </div>
                    </div>
                </section>

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

                {/* Medikamente heute: eine Taste pro Einnahme, wie in Medikamente > Heute */}
                {medsOn && (
                    <section className="rounded-3xl p-5 sm:p-6" style={{ backgroundColor: C.greenSoft, border: `1px solid ${C.border}` }} aria-labelledby="rv-meds">
                        <h2 id="rv-meds" className="mb-4 flex items-center gap-3" style={sectionTitle(C.text)}>
                            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-white" style={{ backgroundColor: C.green }}>
                                <Pill className="h-7 w-7" aria-hidden="true" />
                            </span>
                            {t('simpleView:meds.title')}
                        </h2>

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

                        {intakes.length === 0 ? (
                            <p style={fs(21)}>{t('simpleView:meds.empty')}</p>
                        ) : (
                            <div className="space-y-6">
                                {MOMENTS.map((moment) => {
                                    const group = byMoment[moment];
                                    if (group.length === 0) return null;
                                    const open = group.filter(isOpen);
                                    return (
                                        <div key={moment}>
                                            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                                                <h3 className="font-bold" style={fs(24)}>{t(`medications:moments.${moment}`)}</h3>
                                                {open.length > 1 && (
                                                    <button type="button" onClick={() => setConfirmMoment(moment)} disabled={busy} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                                                        <CheckCheck className="h-6 w-6 shrink-0" aria-hidden="true" />
                                                        {t(`medications:today.allTaken.${moment}`)}
                                                    </button>
                                                )}
                                            </div>
                                            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                                {group.map((intake) => {
                                                    const amount = formatAmount(t, intake.quantity, intake.unit, intake.form);
                                                    return (
                                                        <li key={intake.id} className="flex flex-col gap-3 rounded-2xl p-4" style={tile}>
                                                            <div className="flex items-start gap-4">
                                                                {intake.photo_url ? (
                                                                    <img src={intake.photo_url} alt="" className="h-20 w-20 shrink-0 rounded-2xl object-cover" style={{ border: `1px solid ${C.border}` }} />
                                                                ) : (
                                                                    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl" style={{ backgroundColor: C.blueSoft, color: C.blue }} aria-hidden="true">
                                                                        <Pill className="h-10 w-10" />
                                                                    </div>
                                                                )}
                                                                <div className="min-w-0">
                                                                    <p className="font-bold" style={fs(23)}>
                                                                        {intake.medication_name}
                                                                        {intake.medication_dosage ? ` ${intake.medication_dosage}` : ''}
                                                                    </p>
                                                                    <p className="font-bold" style={{ ...fs(21), color: C.green }}>
                                                                        {intake.time_fixed === false
                                                                            ? amount
                                                                            : t('medications:today.takeAt', { amount, time: clockOf(intake.due_at) })}
                                                                    </p>
                                                                    {intakeDetails(intake).map((line, idx) => (
                                                                        <p key={idx} style={{ ...fs(18), color: C.muted }}>{line}</p>
                                                                    ))}
                                                                </div>
                                                            </div>

                                                            {intake.status === 'taken' && (
                                                                <p className="flex items-center gap-2 font-bold" style={{ ...fs(21), color: C.green }}>
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
                                                                <p className="font-bold" style={{ ...fs(21), color: C.red }}>{t('medications:today.status.missed')}</p>
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
                                                            {canUndo(intake) && (
                                                                <div className="flex flex-wrap items-center gap-3">
                                                                    <button type="button" onClick={() => void setStatus(intake, 'pending')} disabled={busy} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                                                                        <RotateCcw className="h-6 w-6 shrink-0" aria-hidden="true" />
                                                                        {t('medications:today.undo')}
                                                                    </button>
                                                                    <span style={{ ...fs(17), color: C.muted }}>
                                                                        {t('simpleView:meds.undoHint', { time: clockOf(new Date(intake.undo_until ?? Date.now())) })}
                                                                    </span>
                                                                </div>
                                                            )}
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                )}

                {/* Wer kommt heute, Termine heute */}
                {calendarOn && (
                    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                        <section className="rounded-3xl p-5 sm:p-6" style={{ backgroundColor: C.blueSoft, border: `1px solid ${C.border}` }} aria-labelledby="rv-visitors">
                            <h2 id="rv-visitors" className="mb-4 flex items-center gap-3" style={sectionTitle(C.blueDark)}>
                                <Users className="h-8 w-8 shrink-0" aria-hidden="true" />
                                {t('simpleView:visitors.title')}
                            </h2>
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
                                            <li key={`${e.id}-${e.start_time}`} className="flex items-center gap-4 rounded-2xl p-4" style={tile}>
                                                {people.length > 0 ? (
                                                    <PersonPhoto name={people[0]} url={null} size={64} />
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
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </section>

                        <section className="rounded-3xl p-5 sm:p-6" style={{ backgroundColor: C.purpleSoft, border: `1px solid ${C.border}` }} aria-labelledby="rv-appointments">
                            <h2 id="rv-appointments" className="mb-4 flex items-center gap-3" style={sectionTitle(C.purple)}>
                                <CalendarDays className="h-8 w-8 shrink-0" aria-hidden="true" />
                                {t('simpleView:appointments.title')}
                            </h2>
                            {appointmentEvents.length === 0 ? (
                                <p style={fs(21)}>{t('simpleView:appointments.empty')}</p>
                            ) : (
                                <ul className="space-y-3">
                                    {appointmentEvents.map((e) => {
                                        const people = peopleOf(e);
                                        return (
                                            <li key={`${e.id}-${e.start_time}`} className="flex items-start gap-4 rounded-2xl p-4" style={tile}>
                                                <p className="shrink-0 font-bold tabular-nums" style={{ ...fs(23), color: C.purple }}>{clockOf(e.start_time)}</p>
                                                <div className="min-w-0 space-y-1">
                                                    <p className="font-bold" style={fs(23)}>{e.title}</p>
                                                    {e.location && (
                                                        <p className="flex items-start gap-2" style={fs(18)}>
                                                            <MapPin className="mt-1 h-5 w-5 shrink-0" style={{ color: C.purple }} aria-hidden="true" />
                                                            <span>{e.location}</span>
                                                        </p>
                                                    )}
                                                    {travelLines(e).map((line, idx) => (
                                                        <p key={idx} className="flex items-start gap-2" style={fs(18)}>
                                                            <Car className="mt-1 h-5 w-5 shrink-0" style={{ color: C.purple }} aria-hidden="true" />
                                                            <span>{line}</span>
                                                        </p>
                                                    ))}
                                                    {people.length > 0 && (
                                                        <p className="flex items-start gap-2" style={fs(18)}>
                                                            <Users className="mt-1 h-5 w-5 shrink-0" style={{ color: C.purple }} aria-hidden="true" />
                                                            <span>{t('simpleView:appointments.companion', { names: people.join(', ') })}</span>
                                                        </p>
                                                    )}
                                                    {e.take_along && (
                                                        <p className="flex items-start gap-2" style={fs(18)}>
                                                            <Backpack className="mt-1 h-5 w-5 shrink-0" style={{ color: C.purple }} aria-hidden="true" />
                                                            <span className="whitespace-pre-wrap">{t('calendar:card.takeAlong', { text: e.take_along })}</span>
                                                        </p>
                                                    )}
                                                    {e.description && <p style={{ ...fs(18), color: C.muted }}>{e.description}</p>}
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </section>
                    </div>
                )}

                {/* Wichtige Kontakte */}
                {contactsOn && (
                    <section className="rounded-3xl p-5 sm:p-6" style={tile} aria-labelledby="rv-contacts">
                        <h2 id="rv-contacts" className="mb-4 flex items-center gap-3" style={sectionTitle(C.blueDark)}>
                            <Phone className="h-8 w-8 shrink-0" aria-hidden="true" />
                            {t('simpleView:contacts.title')}
                        </h2>
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
                    </section>
                )}

                {/* Fragen Sie mich: nur feste Fragen */}
                {questions.length > 0 && (
                    <button
                        type="button"
                        onClick={() => { setQuestion(null); setAskOpen(true); }}
                        className="flex min-h-[88px] items-center gap-4 rounded-3xl px-6 py-3 text-left text-white shadow-md"
                        style={{ backgroundColor: C.blue }}
                    >
                        <MessageCircle className="h-10 w-10 shrink-0" aria-hidden="true" />
                        <span>
                            <span className="block font-bold" style={fs(26)}>{t('simpleView:ask.button')}</span>
                            <span className="block" style={fs(18)}>{t('simpleView:ask.hint')}</span>
                        </span>
                    </button>
                )}
            </div>

            {/* Rueckfrage: alle einer Tageszeit genommen */}
            {confirmMoment && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ lineHeight: 1.5, ['--k' as string]: String(fontScale) }} role="dialog" aria-modal="true" aria-labelledby="rv-confirm-title">
                    <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
                    <div className={cn(overlayBox, 'max-w-xl font-kiosk')} style={tile}>
                        <h2 id="rv-confirm-title" className="font-bold" style={fs(26)}>{t(`medications:today.allTaken.${confirmMoment}`)}</h2>
                        <p className="mt-2" style={fs(21)}>{t('medications:today.allTakenQuestion')}</p>
                        <ul className="mt-4 space-y-2">
                            {byMoment[confirmMoment].filter(isOpen).map((i) => (
                                <li key={i.id} className="flex items-start gap-3" style={fs(21)}>
                                    <Pill className="mt-1 h-6 w-6 shrink-0" style={{ color: C.blue }} aria-hidden="true" />
                                    <span>{i.medication_name}{i.medication_dosage ? ` ${i.medication_dosage}` : ''}: {formatAmount(t, i.quantity, i.unit, i.form)}</span>
                                </li>
                            ))}
                        </ul>
                        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <button type="button" onClick={() => setConfirmMoment(null)} className="min-h-[64px] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                {t('medications:today.allTakenNo')}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                    const ids = byMoment[confirmMoment].filter(isOpen).map((i) => i.id);
                                    setConfirmMoment(null);
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

            {/* Erinnerung (Eskalation Stufe 1): ruhig, eine klare Taste */}
            {reminderOpen && medsOn && dueNow.length > 0 && (
                <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 overflow-y-auto p-6 text-center font-kiosk" style={rootStyle} role="alertdialog" aria-modal="true" aria-labelledby="rv-reminder-title">
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

            {/* Fragen Sie mich */}
            {askOpen && (
                <div className="fixed inset-0 z-[70] overflow-y-auto font-kiosk" style={rootStyle} role="dialog" aria-modal="true" aria-labelledby="rv-ask-title">
                    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <h2 id="rv-ask-title" className="font-bold" style={{ ...fs(32), color: C.blueDark }}>{t('simpleView:ask.button')}</h2>
                            <button type="button" onClick={closeAsk} className="flex min-h-[56px] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                                <X className="h-6 w-6 shrink-0" aria-hidden="true" />
                                {t('simpleView:ask.close')}
                            </button>
                        </div>

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
                    </div>
                </div>
            )}

            {/* Eigene Einstellungen: Schriftgroesse und Sprache */}
            {settingsOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 font-kiosk" style={{ lineHeight: 1.5, ['--k' as string]: String(fontScale) }} role="dialog" aria-modal="true" aria-labelledby="rv-settings-title">
                    <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
                    <div className={cn(overlayBox, 'max-w-xl')} style={tile}>
                        <h2 id="rv-settings-title" className="font-bold" style={fs(28)}>{t('simpleView:settings.title')}</h2>

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

                        <button
                            type="button"
                            onClick={() => setSettingsOpen(false)}
                            className="mt-8 flex min-h-[64px] w-full items-center justify-center gap-2 rounded-2xl font-bold text-white"
                            style={{ ...fs(21), backgroundColor: C.green }}
                        >
                            <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                            {t('simpleView:settings.close')}
                        </button>
                    </div>
                </div>
            )}

            {/* Abmelden mit Rueckfrage */}
            {logoutOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 font-kiosk" style={{ lineHeight: 1.5, ['--k' as string]: String(fontScale) }} role="alertdialog" aria-modal="true" aria-labelledby="rv-logout-title" aria-describedby="rv-logout-hint">
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
                                style={{ ...fs(21), backgroundColor: C.red }}
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
