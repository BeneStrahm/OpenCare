// E64 Teambereich in der einfachen Ansicht (Rolle recipient), Figma T1 bis T5:
// Passwortseite, Pflegetagebuch und Medikamentenplan. Taste, Hinweis und Kacheln stehen in
// RecipientView.tsx. Pflegetagebuch im Stil der einfachen Ansicht (Figma T6, T7, Roadmap 21.1),
// Medikamentenplan wie die Druckansicht der App. Der Server prueft den offenen Teambereich.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ClipboardList, FileText, Lock, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { intlLocale } from '../../i18n/format';
import { clockDate } from '../../lib/clock';
import { MAX_PHOTOS, compressImage } from '../../lib/journalPhotos';
import { matchSuggestions } from '../../lib/recipientView';
import { TEAM_PIN_MAX, isTeamFunction, onlyDigits, type TeamUnlockResult } from '../../lib/teamAccess';
import MedicationPlanPrint from '../../pages/MedicationPlanPrint';
import { ViewWindow } from './ViewWindow';
import type { RecipientUi } from './ui';

type UnlockError = 'empty' | 'wrong' | 'locked' | 'off' | 'failed';

/**
 * Figma T2 und T3: PIN eingeben (nur Ziffern, Zahlentastatur), Zurueck oder Oeffnen.
 * Dieselbe Seite vor dem Pruefen im Arztgespraech (A11, A13) mit eigenem Titel und Satz.
 */
export const TeamPasswordWindow: React.FC<{
    ui: RecipientUi;
    onClose: () => void;
    onUnlocked: (result: TeamUnlockResult) => void;
    title?: string;
    intro?: string;
    icon?: React.ReactNode;
}> = ({ ui, onClose, onUnlocked, title, intro, icon }) => {
    const { t } = useTranslation(['simpleView']);
    const { C, fs, tile, secondaryButton, windowProps } = ui;
    const uid = useId();
    const [password, setPassword] = useState('');
    const [error, setError] = useState<UnlockError | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (busy) return;
        if (!password) { setError('empty'); return; }
        setBusy(true);
        setError(null);
        try {
            const res = await api.post<{ success: boolean; data: TeamUnlockResult }>('/api/team-access/unlock', { password });
            setPassword('');
            onUnlocked({
                token: res.data.token,
                functions: (res.data.functions ?? []).filter(isTeamFunction),
                idle_minutes: res.data.idle_minutes,
            });
        } catch (err) {
            const code = err instanceof Error ? err.message : '';
            setPassword('');
            setError(code === 'WRONG_PASSWORD' ? 'wrong' : code === 'TEAM_LOCKED' ? 'locked' : code === 'TEAM_ACCESS_OFF' ? 'off' : 'failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <ViewWindow
            id={`${uid}-title`}
            title={title ?? t('simpleView:team.title')}
            icon={icon ?? <Lock className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />}
            {...windowProps}
            onClose={onClose}
        >
            <form onSubmit={submit} className="space-y-5 rounded-3xl p-6 min-[512px]:p-8" style={tile} noValidate>
                <p style={{ ...fs(22), lineHeight: 1.5 }}>{intro ?? t('simpleView:team.intro')}</p>
                <div>
                    <label htmlFor={`${uid}-password`} className="block font-bold" style={fs(21)}>{t('simpleView:team.passwordLabel')}</label>
                    <input
                        id={`${uid}-password`}
                        type="password"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={TEAM_PIN_MAX}
                        autoComplete="off"
                        autoFocus
                        value={password}
                        onChange={(e) => setPassword(onlyDigits(e.target.value))}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? `${uid}-error` : undefined}
                        className="mt-2 min-h-[4rem] w-full min-w-0 rounded-2xl px-4 font-bold"
                        style={{ ...fs(24), backgroundColor: C.card, color: C.text, border: `2px solid ${error ? C.red : C.control}` }}
                    />
                    {error && (
                        <p id={`${uid}-error`} role="alert" className="mt-2 font-bold" style={{ ...fs(20), color: C.red }}>
                            {t(`simpleView:team.error.${error}`)}
                        </p>
                    )}
                </div>
                <div className="grid grid-cols-1 gap-3 pt-1 min-[512px]:grid-cols-2">
                    <button type="button" onClick={onClose} className="min-h-[4rem] rounded-2xl px-4 font-bold" style={secondaryButton}>
                        {t('simpleView:team.back')}
                    </button>
                    <button
                        type="submit"
                        disabled={busy}
                        className="flex min-h-[4rem] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white disabled:opacity-70"
                        style={{ ...fs(21), backgroundColor: C.blue }}
                    >
                        <Lock className="h-7 w-7 shrink-0" strokeWidth={2.5} aria-hidden="true" />
                        {t('simpleView:team.open')}
                    </button>
                </div>
            </form>
        </ViewWindow>
    );
};

interface TeamJournalEntry {
    id: string;
    author_name: string;
    team_entry?: boolean;
    content: string;
    occurred_at: string;
    photos: Array<{ id: string; file_path: string }>;
}

const JOURNAL_PAGE = 20;
type JournalError = 'content' | 'name' | 'date' | 'photo' | 'offline' | 'failed';
interface JournalForm { content: string; date: string; photos: string[]; name: string }

/** Heutiges Datum als JJJJ-MM-TT in Ortszeit (Feld "Datum"). */
const todayIso = (): string => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Figma T6 und T7 (Roadmap 21.1): Pflegetagebuch im Teambereich, nur lesen und neu eintragen.
 * Bearbeiten und Loeschen nur in der App, kein Diktieren (noch nicht gewuenscht), ohne Internet
 * kein Speichern (keine Warteschlange, E64).
 */
export const TeamJournalWindow: React.FC<{ ui: RecipientUi; onClose: () => void }> = ({ ui, onClose }) => {
    const { t } = useTranslation(['simpleView']);
    const { C, fs, tile, secondaryButton, windowProps, clockOf } = ui;
    const uid = useId();
    const [entries, setEntries] = useState<TeamJournalEntry[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [form, setForm] = useState<JournalForm | null>(null);
    const [error, setError] = useState<JournalError | null>(null);
    const [names, setNames] = useState<string[]>([]);
    const [nameOpen, setNameOpen] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    const load = useCallback(async (before?: string) => {
        const params = new URLSearchParams({ limit: String(JOURNAL_PAGE) });
        if (before) params.set('before', before);
        try {
            const res = await api.get<{ success: boolean; data: TeamJournalEntry[] }>(`/api/journal?${params.toString()}`);
            const list = Array.isArray(res.data) ? res.data : [];
            setEntries((prev) => {
                if (!before) return list;
                const known = new Set(prev.map((e) => e.id));
                return [...prev, ...list.filter((e) => !known.has(e.id))];
            });
            setHasMore(list.length >= JOURNAL_PAGE);
            setLoadFailed(false);
        } catch {
            setLoadFailed(true);
        }
    }, []);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        api.get<{ success: boolean; data: string[] }>('/api/team-access/names')
            .then((res) => setNames(Array.isArray(res.data) ? res.data : []))
            // Ohne Vorschlaege geht das Feld trotzdem (freie Eingabe).
            .catch(() => setNames([]));
    }, []);
    // Meldungen bleiben 15 Sekunden stehen.
    useEffect(() => {
        if (!notice) return;
        const id = window.setTimeout(() => setNotice(null), 15_000);
        return () => window.clearTimeout(id);
    }, [notice]);

    const when = (value: string) => {
        const date = clockDate(value);
        if (!date) return value;
        const day = new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
        return t('simpleView:teamJournal.when', { day, time: clockOf(date) });
    };
    const primary: React.CSSProperties = { ...fs(21), backgroundColor: C.blue };
    const fieldStyle = (bad: boolean): React.CSSProperties => ({ ...fs(24), backgroundColor: C.card, color: C.text, border: `2px solid ${bad ? C.red : C.control}` });
    const label = (htmlFor: string, text: string) => <label htmlFor={htmlFor} className="block font-bold" style={fs(21)}>{text}</label>;
    const errorLine = (kinds: JournalError[]) => error && kinds.includes(error) && (
        <p id={`${uid}-error`} role="alert" className="mt-2 font-bold" style={{ ...fs(20), color: C.red }}>{t(`simpleView:teamJournal.error.${error}`)}</p>
    );

    const addPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (fileRef.current) fileRef.current.value = '';
        if (!form || files.length === 0) return;
        const room = MAX_PHOTOS - form.photos.length;
        const added: string[] = [];
        let failed = false;
        for (const file of files.slice(0, Math.max(room, 0))) {
            try {
                const out = await compressImage(file);
                if (out) added.push(out); else failed = true;
            } catch {
                failed = true;
            }
        }
        setForm((prev) => (prev ? { ...prev, photos: [...prev.photos, ...added] } : prev));
        setError(failed ? 'photo' : null);
    };

    const publish = async () => {
        if (!form || busy) return;
        const content = form.content.trim();
        const name = form.name.trim();
        if (!content && form.photos.length === 0) { setError('content'); return; }
        if (!form.date || form.date > todayIso()) { setError('date'); return; }
        if (!name) { setError('name'); return; }
        if (!navigator.onLine) { setError('offline'); return; }
        setBusy(true);
        setError(null);
        try {
            const payload: Record<string, unknown> = { type: 'note', content, photos: form.photos, team_author_name: name };
            // Anderer Tag: Uhrzeit von jetzt an diesem Tag (wie das Feld in der App ohne Uhrzeit).
            if (form.date !== todayIso()) {
                const now = new Date();
                const [y, m, d] = form.date.split('-').map(Number);
                payload.occurred_at = new Date(y, m - 1, d, now.getHours(), now.getMinutes()).toISOString();
            }
            await api.post('/api/journal', payload);
            setForm(null);
            setNotice(t('simpleView:teamJournal.saved'));
            await load();
        } catch {
            setError(navigator.onLine ? 'failed' : 'offline');
        } finally {
            setBusy(false);
        }
    };

    // ── Figma T7: Neuer Eintrag ──
    if (form) {
        const nameMatches = nameOpen ? matchSuggestions(names.map((n) => ({ name: n })), form.name) : [];
        const set = (patch: Partial<JournalForm>) => { setForm({ ...form, ...patch }); setError(null); };
        return (
            <ViewWindow id={`${uid}-new`} title={t('simpleView:teamJournal.newTitle')} icon={<ClipboardList className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={() => setForm(null)}>
                <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void publish(); }} noValidate>
                    <div className="rounded-3xl p-6 min-[512px]:p-8" style={tile}>
                        {label(`${uid}-content`, t('simpleView:teamJournal.contentLabel'))}
                        <textarea
                            id={`${uid}-content`}
                            rows={4}
                            maxLength={5000}
                            value={form.content}
                            onChange={(e) => set({ content: e.target.value })}
                            aria-invalid={error === 'content' ? true : undefined}
                            aria-describedby={error === 'content' ? `${uid}-error` : undefined}
                            className="mt-2 w-full min-w-0 rounded-2xl px-4 py-3 font-bold"
                            style={{ ...fieldStyle(error === 'content'), lineHeight: 1.5 }}
                        />
                        {errorLine(['content'])}
                    </div>
                    <div className="grid grid-cols-1 gap-4 min-[512px]:grid-cols-2">
                        <div className="rounded-3xl p-6 min-[512px]:p-8" style={tile}>
                            {label(`${uid}-date`, t('simpleView:teamJournal.dateLabel'))}
                            <input
                                id={`${uid}-date`}
                                type="date"
                                max={todayIso()}
                                value={form.date}
                                onChange={(e) => set({ date: e.target.value })}
                                aria-invalid={error === 'date' ? true : undefined}
                                aria-describedby={error === 'date' ? `${uid}-error` : undefined}
                                className="mt-2 min-h-[4rem] w-full min-w-0 rounded-2xl px-4 font-bold"
                                style={fieldStyle(error === 'date')}
                            />
                            {errorLine(['date'])}
                        </div>
                        <div className="rounded-3xl p-6 min-[512px]:p-8" style={tile}>
                            <p className="font-bold" style={fs(21)}>{t('simpleView:teamJournal.photosLabel')}</p>
                            {form.photos.length > 0 && (
                                <ul className="mt-3 flex flex-wrap gap-3">
                                    {form.photos.map((src, i) => (
                                        <li key={i} className="space-y-2">
                                            <img src={src} alt={t('simpleView:teamJournal.photoN', { n: i + 1 })} className="h-24 w-32 rounded-xl object-cover" />
                                            <button type="button" onClick={() => set({ photos: form.photos.filter((_, k) => k !== i) })} className="flex min-h-[3.5rem] items-center gap-2 rounded-2xl px-4 font-bold" style={secondaryButton} aria-label={t('simpleView:teamJournal.removePhotoN', { n: i + 1 })}>
                                                <Trash2 className="h-6 w-6 shrink-0" aria-hidden="true" />
                                                {t('simpleView:teamJournal.removePhoto')}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void addPhotos(e)} />
                            {form.photos.length < MAX_PHOTOS ? (
                                <button type="button" onClick={() => fileRef.current?.click()} className="mt-3 flex min-h-[4rem] items-center gap-2 rounded-2xl px-5 font-bold" style={secondaryButton}>
                                    <Plus className="h-7 w-7 shrink-0" aria-hidden="true" />
                                    {t('simpleView:teamJournal.addPhoto')}
                                </button>
                            ) : (
                                <p className="mt-3" style={{ ...fs(19), color: C.muted }}>{t('simpleView:teamJournal.photoLimit', { max: MAX_PHOTOS })}</p>
                            )}
                            {errorLine(['photo'])}
                        </div>
                    </div>
                    <div className="space-y-5 rounded-3xl p-6 min-[512px]:p-8" style={tile}>
                        <div>
                            {label(`${uid}-name`, t('simpleView:teamJournal.nameLabel'))}
                            <input
                                id={`${uid}-name`}
                                type="text"
                                autoComplete="off"
                                maxLength={100}
                                value={form.name}
                                onFocus={() => setNameOpen(true)}
                                onBlur={() => setNameOpen(false)}
                                onChange={(e) => { set({ name: e.target.value }); setNameOpen(true); }}
                                role="combobox"
                                aria-autocomplete="list"
                                aria-expanded={nameMatches.length > 0}
                                aria-controls={nameMatches.length > 0 ? `${uid}-names` : undefined}
                                aria-invalid={error === 'name' ? true : undefined}
                                aria-describedby={error === 'name' ? `${uid}-error` : undefined}
                                className="mt-2 min-h-[4rem] w-full min-w-0 rounded-2xl px-4 font-bold"
                                style={fieldStyle(error === 'name')}
                            />
                            {nameMatches.length > 0 && (
                                <ul id={`${uid}-names`} role="listbox" className="mt-2 overflow-hidden rounded-2xl" style={{ backgroundColor: C.card, border: `2px solid ${C.control}` }}>
                                    {nameMatches.map((item, i) => (
                                        <li key={item.name} role="option" aria-selected={false}>
                                            <button
                                                type="button"
                                                // Vor dem Verlassen des Feldes waehlen (sonst schliesst sich die Liste zuerst).
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => { set({ name: item.name }); setNameOpen(false); }}
                                                className="block min-h-[3.5rem] w-full px-4 py-2 text-left font-bold"
                                                style={{ ...fs(21), borderTop: i === 0 ? 'none' : `1px solid ${C.border}` }}
                                            >
                                                {item.name}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {errorLine(['name'])}
                        </div>
                        {errorLine(['offline', 'failed'])}
                        <div className="grid grid-cols-1 gap-3 min-[512px]:grid-cols-2">
                            <button type="button" onClick={() => setForm(null)} className="min-h-[4rem] rounded-2xl px-4 font-bold" style={secondaryButton}>
                                {t('simpleView:team.back')}
                            </button>
                            <button type="submit" disabled={busy} className="flex min-h-[4rem] items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white disabled:opacity-70" style={primary}>
                                <Check className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                                {t('simpleView:teamJournal.publish')}
                            </button>
                        </div>
                    </div>
                </form>
            </ViewWindow>
        );
    }

    // ── Figma T6: Liste ──
    return (
        <ViewWindow id={`${uid}-title`} title={t('simpleView:team.journal')} icon={<ClipboardList className="h-9 w-9 shrink-0" style={{ color: C.blue }} aria-hidden="true" />} {...windowProps} onClose={onClose}>
            <div className="space-y-4">
                {notice && (
                    <p role="status" className="flex items-start gap-3 rounded-2xl px-4 py-3 font-bold" style={{ ...fs(20), color: C.green, backgroundColor: C.greenSoft }}>
                        <Check className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
                        <span>{notice}</span>
                    </p>
                )}
                <div className="space-y-3 rounded-3xl p-6 min-[512px]:p-8" style={tile}>
                    <button type="button" onClick={() => { setForm({ content: '', date: todayIso(), photos: [], name: '' }); setError(null); setNotice(null); }} className="flex min-h-[4rem] w-full items-center justify-center gap-2 rounded-2xl px-4 font-bold text-white" style={primary}>
                        <Plus className="h-7 w-7 shrink-0" strokeWidth={3} aria-hidden="true" />
                        {t('simpleView:teamJournal.newEntry')}
                    </button>
                    <p style={{ ...fs(19), color: C.muted }}>{t('simpleView:teamJournal.hint')}</p>
                </div>
                {loadFailed && <p role="alert" className="font-bold" style={{ ...fs(20), color: C.red }}>{t('simpleView:teamJournal.loadError')}</p>}
                {!loadFailed && entries.length === 0 && <p style={{ ...fs(20), color: C.muted }}>{t('simpleView:teamJournal.empty')}</p>}
                {entries.map((entry) => (
                    <article key={entry.id} className="space-y-3 rounded-3xl p-6 min-[512px]:p-8" style={tile}>
                        <p className="font-bold" style={fs(21)}>{when(entry.occurred_at)}</p>
                        {entry.content && <p className="whitespace-pre-wrap" style={{ ...fs(21), lineHeight: 1.5 }}>{entry.content}</p>}
                        {entry.photos.length > 0 && (
                            <div className="flex flex-wrap gap-3">
                                {entry.photos.map((photo, i) => (
                                    <img key={photo.id} src={photo.file_path} alt={t('simpleView:teamJournal.photoN', { n: i + 1 })} className="h-36 w-48 rounded-xl object-cover" loading="lazy" />
                                ))}
                            </div>
                        )}
                        <p style={{ ...fs(19), color: C.muted }}>
                            {entry.team_entry ? t('simpleView:teamJournal.byTeam', { name: entry.author_name }) : entry.author_name}
                        </p>
                    </article>
                ))}
                {hasMore && (
                    <button type="button" onClick={() => void load(entries[entries.length - 1]?.occurred_at)} className="min-h-[4rem] w-full rounded-2xl px-4 font-bold" style={secondaryButton}>
                        {t('simpleView:teamJournal.loadMore')}
                    </button>
                )}
            </div>
        </ViewWindow>
    );
};

/** Medikamentenplan wie die Druckansicht der normalen App, ohne Drucken. */
export const TeamPlanWindow: React.FC<{ ui: RecipientUi; onClose: () => void }> = ({ ui, onClose }) => {
    const { t } = useTranslation(['simpleView']);
    const uid = useId();
    return (
        <ViewWindow
            id={`${uid}-title`}
            title={t('simpleView:team.medplan')}
            icon={<FileText className="h-9 w-9 shrink-0" style={{ color: ui.C.blue }} aria-hidden="true" />}
            {...ui.windowProps}
            onClose={onClose}
        >
            {/* A4 quer: breiter als das Tablet, darum seitlich verschiebbar */}
            <div className="overflow-x-auto rounded-3xl bg-white font-sans">
                <div className="min-w-[56rem]">
                    <MedicationPlanPrint embedded />
                </div>
            </div>
        </ViewWindow>
    );
};
