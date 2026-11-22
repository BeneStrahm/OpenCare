import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, isToday, isYesterday } from 'date-fns';
import { BookOpen, Edit2, ImagePlus, Mic, Square, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { MAX_PHOTOS, compressImage } from '../lib/journalPhotos';
import { useAuth } from '../contexts/AuthContext';
import { useFeatures } from '../lib/features';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { Button, Card, CardContent, Dialog, Input, Textarea, useToast } from '../components/ui';
import { EmptyState } from '../components/app';
import { dateLocale, formatClock } from '../i18n/format';
// ─── Types alignés sur server/src/routes/journal.ts ─────────────────────────

type EntryType = 'visit' | 'note' | 'vital' | 'medication' | 'incident' | 'mood';

interface JournalPhoto {
    id: string;
    entry_id: string;
    file_path: string;
    mime_type: string;
}

interface JournalEntry {
    id: string;
    author_user_id: string | null;
    author_name: string;
    /** E64: im Teambereich am Tablet eingetragen, author_name ist der eingegebene Name */
    team_entry?: boolean;
    type: EntryType;
    content: string;
    data: Record<string, unknown> | null;
    occurred_at: string;
    photos: JournalPhoto[];
}

// ─── Constantes ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 30;
// Fotos: lib/journalPhotos.ts (auch im Teambereich am Tablet)

// ─── Helpers ─────────────────────────────────────────────────────────────────

const toLocalInputValue = (date: Date) => format(date, "yyyy-MM-dd'T'HH:mm");

// ─── Dictée vocale ───────────────────────────────────────────────────────────

// Le body JSON global du serveur est limité à 8 Mo: on garde une marge
// (la data URL base64 pèse environ 4/3 de l'audio).
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/** Premier type MIME audio supporté par MediaRecorder (webm avec repli). */
const pickRecorderMimeType = (): string => {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
        'audio/ogg',
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
};

const formatRecordDuration = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

// ─── Page ────────────────────────────────────────────────────────────────────

/**
 * E64 teamMode: im Teambereich am Tablet der betreuten Person. Lesen und neu eintragen mit
 * Namen ("Ihr Name", Vorschlaege aus GET /api/team-access/names, neue Namen erlaubt).
 * Kein Bearbeiten, Loeschen, Diktieren und keine grosse Fotoansicht (laege hinter dem Fenster).
 * Einfaches Tagebuch: keine Art des Eintrags (neue Eintraege sind 'note'), Name fuer alle Rollen
 * (eigener Name vorab). Einnahmen und Messungen stehen nicht in der Liste (Server blendet aus).
 */
const Journal: React.FC<{ teamMode?: boolean }> = ({ teamMode = false }) => {
    const { t } = useTranslation(['journal', 'common']);
    const { user } = useAuth();
    const circle = useCircle();
    const { activeCircle, myRole } = circle;
    const canWriteJournal = teamMode || circle.canWriteJournal;
    const isAdmin = !teamMode && circle.isAdmin;
    const voiceJournalOn = useFeatures().isOn('voice_journal') && !teamMode;
    const [authorName, setAuthorName] = useState(() => (teamMode ? '' : user?.name ?? ''));
    const [authorNames, setAuthorNames] = useState<string[]>([]);
    const { showToast } = useToast();

    const [entries, setEntries] = useState<JournalEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState('');

    // Composeur
    const [content, setContent] = useState('');
    const [occurredAt, setOccurredAt] = useState(() => toLocalInputValue(new Date()));
    const [photos, setPhotos] = useState<string[]>([]);
    const [photoError, setPhotoError] = useState('');
    const [publishing, setPublishing] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Dictée vocale (Whisper)
    const [recording, setRecording] = useState(false);
    const [recordSeconds, setRecordSeconds] = useState(0);
    const [transcribing, setTranscribing] = useState(false);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const recordTimerRef = useRef<number | null>(null);

    // Edition, suppression, visionneuse
    const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null);
    const [editContent, setEditContent] = useState('');
    const [editOccurredAt, setEditOccurredAt] = useState('');
    const [savingEdit, setSavingEdit] = useState(false);
    const [lightboxPhoto, setLightboxPhoto] = useState<JournalPhoto | null>(null);

    // Nombre d'entrées chargées, pour rafraîchir la même fenêtre après un événement temps réel.
    const entriesCountRef = useRef(0);
    entriesCountRef.current = entries.length;

    // Eigener Name vorab, sobald das Konto geladen ist (im Teambereich bleibt das Feld leer).
    useEffect(() => {
        if (!teamMode && user?.name) setAuthorName((prev) => prev || user.name);
    }, [teamMode, user?.name]);

    // Namensvorschlaege (GET /api/team-access/names: admin, family, professional und Teambereich).
    // Freunde (neighbor) bekommen keine Liste, das Feld bleibt frei beschreibbar.
    const canListNames = teamMode || myRole === 'admin' || myRole === 'family' || myRole === 'professional';
    useEffect(() => {
        if (!canListNames || !activeCircle?.id) return;
        api.get<{ success: boolean; data: string[] }>('/api/team-access/names')
            .then((res) => setAuthorNames(Array.isArray(res.data) ? res.data : []))
            .catch(() => setAuthorNames([]));
    }, [canListNames, activeCircle?.id]);

    const buildQuery = (limit: number, before?: string) => {
        const params = new URLSearchParams();
        params.set('limit', String(limit));
        if (before) params.set('before', before);
        return `/api/journal?${params.toString()}`;
    };

    /** Recharge la timeline depuis le début (fenêtre courante conservée sauf reset). */
    const refresh = async (opts: { spinner?: boolean; reset?: boolean } = {}) => {
        if (opts.spinner) setLoading(true);
        try {
            const limit = opts.reset
                ? PAGE_SIZE
                : Math.min(Math.max(entriesCountRef.current, PAGE_SIZE), 200);
            const response = await api.get<{ success: boolean; data: JournalEntry[] }>(buildQuery(limit));
            if (response.success) {
                setEntries(response.data);
                setHasMore(response.data.length >= limit);
                setError('');
            }
        } catch (err) {
            console.error('Failed to load journal:', err);
            setError(err instanceof Error ? err.message : t('journal:errors.load'));
        } finally {
            if (opts.spinner) setLoading(false);
        }
    };

    // Recharger quand le cercle actif change.
    useEffect(() => {
        if (!activeCircle?.id) return;
        void refresh({ spinner: true, reset: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    // Temps réel: un autre membre publie, modifie ou supprime une entrée.
    useWebSocketUpdates('journal', () => {
        void refresh();
    });

    const loadMore = async () => {
        const last = entries[entries.length - 1];
        if (!last || loadingMore) return;
        setLoadingMore(true);
        try {
            const response = await api.get<{ success: boolean; data: JournalEntry[] }>(
                buildQuery(PAGE_SIZE, last.occurred_at)
            );
            if (response.success) {
                setEntries((prev) => {
                    const known = new Set(prev.map((e) => e.id));
                    return [...prev, ...response.data.filter((e) => !known.has(e.id))];
                });
                setHasMore(response.data.length >= PAGE_SIZE);
            }
        } catch (err) {
            console.error('Failed to load more journal entries:', err);
            setError(err instanceof Error ? err.message : t('journal:errors.load'));
        } finally {
            setLoadingMore(false);
        }
    };

    // ─── Composeur ───────────────────────────────────────────────────────────

    const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (files.length === 0) return;
        setPhotoError('');
        const remaining = MAX_PHOTOS - photos.length;
        const selected = files.filter((f) => f.type.startsWith('image/')).slice(0, Math.max(remaining, 0));
        try {
            const compressed: string[] = [];
            for (const file of selected) {
                const result = await compressImage(file);
                if (result) {
                    compressed.push(result);
                } else {
                    setPhotoError(t('journal:errors.photoTooLarge'));
                }
            }
            if (compressed.length > 0) {
                setPhotos((prev) => [...prev, ...compressed].slice(0, MAX_PHOTOS));
            }
        } catch (err) {
            console.error('Failed to read photo:', err);
            setPhotoError(t('journal:errors.photoRead'));
        }
    };

    const resetComposer = () => {
        setContent('');
        setPhotos([]);
        setPhotoError('');
        setOccurredAt(toLocalInputValue(new Date()));
    };

    // ─── Dictée vocale: enregistrement, transcription, rangement ────────────

    const stopRecordTimer = () => {
        if (recordTimerRef.current !== null) {
            window.clearInterval(recordTimerRef.current);
            recordTimerRef.current = null;
        }
    };

    const transcribeBlob = async (blob: Blob) => {
        if (blob.size === 0) return;
        if (blob.size > MAX_AUDIO_BYTES) {
            showToast({ variant: 'error', title: t('journal:voice.tooLong') });
            return;
        }
        setTranscribing(true);
        try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = () => reject(new Error('read'));
                reader.readAsDataURL(blob);
            });
            const res = await api.post<{ success: boolean; data: { text: string } }>(
                '/api/voice/transcribe',
                { audio: dataUrl }
            );
            const text = res.success ? res.data.text.trim() : '';
            if (!text) {
                showToast({ variant: 'error', title: t('journal:voice.emptyTranscript') });
                return;
            }
            // Le texte est placé dans la zone de saisie: l'aidant relit avant de publier.
            setContent((prev) => (prev.trim() ? `${prev.trimEnd()}\n${text}` : text));
        } catch (err) {
            const message = err instanceof Error ? err.message : '';
            if (message === 'WHISPER_NOT_CONFIGURED') {
                showToast({
                    variant: 'error',
                    title: t('journal:voice.notConfiguredTitle'),
                    description: t('journal:voice.notConfiguredBody'),
                });
            } else {
                showToast({ variant: 'error', title: t('journal:voice.transcribeError') });
            }
        } finally {
            setTranscribing(false);
        }
    };

    const startRecording = async () => {
        if (recording || transcribing) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeType = pickRecorderMimeType();
            const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
            chunksRef.current = [];
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) chunksRef.current.push(event.data);
            };
            recorder.onstop = () => {
                stream.getTracks().forEach((track) => track.stop());
                stopRecordTimer();
                setRecording(false);
                const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
                chunksRef.current = [];
                void transcribeBlob(blob);
            };
            recorderRef.current = recorder;
            recorder.start();
            setRecordSeconds(0);
            setRecording(true);
            recordTimerRef.current = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
        } catch (err) {
            console.error('Microphone access failed:', err);
            showToast({
                variant: 'error',
                title: t('journal:voice.micDeniedTitle'),
                description: t('journal:voice.micDeniedBody'),
            });
        }
    };

    const stopRecording = () => {
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== 'inactive') recorder.stop();
    };

    // Nettoyage au démontage: timer + micro relâché sans lancer de transcription.
    useEffect(() => {
        return () => {
            stopRecordTimer();
            const recorder = recorderRef.current;
            if (recorder && recorder.state !== 'inactive') {
                recorder.ondataavailable = null;
                recorder.onstop = null;
                recorder.stop();
                recorder.stream.getTracks().forEach((track) => track.stop());
            }
        };
    }, []);

    const handlePublish = async (e: React.FormEvent) => {
        e.preventDefault();
        if (publishing) return;
        const trimmed = content.trim();
        const name = authorName.trim();
        if (!trimmed && photos.length === 0) return;
        if (!name) {
            setError(t('journal:team.nameRequired'));
            return;
        }

        setPublishing(true);
        setError('');
        try {
            const payload: Record<string, unknown> = {
                type: 'note',
                content: trimmed,
                photos,
            };
            if (occurredAt) payload.occurred_at = new Date(occurredAt).toISOString();
            if (teamMode) payload.team_author_name = name;
            else payload.author_name = name;

            await api.post('/api/journal', payload);
            resetComposer();
            showToast({ title: t('journal:toasts.published') });
            await refresh();
        } catch (err) {
            console.error('Failed to publish journal entry:', err);
            setError(err instanceof Error ? err.message : t('journal:errors.publish'));
        } finally {
            setPublishing(false);
        }
    };

    // ─── Edition et suppression ──────────────────────────────────────────────

    const canManage = (entry: JournalEntry) =>
        !teamMode && (isAdmin || (entry.author_user_id !== null && entry.author_user_id === user?.id));

    const openEdit = (entry: JournalEntry) => {
        setEditingEntry(entry);
        setEditContent(entry.content);
        setEditOccurredAt(toLocalInputValue(new Date(entry.occurred_at)));
    };

    const handleSaveEdit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editingEntry || savingEdit) return;
        setSavingEdit(true);
        try {
            const payload: Record<string, unknown> = { content: editContent };
            if (editOccurredAt) payload.occurred_at = new Date(editOccurredAt).toISOString();
            await api.put(`/api/journal/${editingEntry.id}`, payload);
            setEditingEntry(null);
            showToast({ title: t('journal:toasts.updated') });
            await refresh();
        } catch (err) {
            console.error('Failed to update journal entry:', err);
            setError(err instanceof Error ? err.message : t('journal:errors.update'));
        } finally {
            setSavingEdit(false);
        }
    };

    const handleDelete = async (entry: JournalEntry) => {
        if (!window.confirm(t('journal:confirmDelete'))) return;
        try {
            await api.delete(`/api/journal/${entry.id}`);
            showToast({ title: t('journal:toasts.deleted') });
            await refresh();
        } catch (err) {
            console.error('Failed to delete journal entry:', err);
            setError(err instanceof Error ? err.message : t('journal:errors.delete'));
        }
    };

    // ─── Présentation ────────────────────────────────────────────────────────

    const groups = useMemo(() => {
        const map = new Map<string, JournalEntry[]>();
        for (const entry of entries) {
            const key = format(new Date(entry.occurred_at), 'yyyy-MM-dd');
            const list = map.get(key);
            if (list) {
                list.push(entry);
            } else {
                map.set(key, [entry]);
            }
        }
        return Array.from(map.entries());
    }, [entries]);

    const dayLabel = (key: string) => {
        const date = new Date(`${key}T00:00:00`);
        if (isToday(date)) return t('journal:days.today');
        if (isYesterday(date)) return t('journal:days.yesterday');
        return format(date, 'EEEE d MMMM yyyy', { locale: dateLocale() });
    };

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center min-h-[50vh]">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="text-muted-foreground font-medium animate-pulse">{t('journal:loading')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-3xl mx-auto space-y-6">
            {error ? (
                <div id="journal-error" role="alert" className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            {!teamMode && (
                <div>
                    <h1 className="text-h1 mb-1">{t('journal:title')}</h1>
                    <p className="text-muted-foreground text-body">{t('journal:subtitle')}</p>
                </div>
            )}

            {/* Composeur */}
            {canWriteJournal && (
                <Card>
                    <CardContent className="p-4 md:p-5">
                        <form onSubmit={handlePublish} className="space-y-4">
                            <Textarea
                                label={t('journal:composer.contentLabel')}
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                placeholder={t('journal:composer.placeholder')}
                                rows={3}
                            />

                            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                                <div className="sm:max-w-[220px]">
                                    <Input
                                        label={t('journal:composer.dateLabel')}
                                        type="datetime-local"
                                        value={occurredAt}
                                        onChange={(e) => setOccurredAt(e.target.value)}
                                    />
                                </div>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    className="hidden"
                                    onChange={(e) => void handlePhotoSelect(e)}
                                />
                                <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={photos.length >= MAX_PHOTOS}
                                >
                                    <ImagePlus className="mr-2 h-4 w-4" />
                                    {t('journal:composer.addPhotos')}
                                    <span className="ml-2 text-micro text-muted-foreground">
                                        {t('journal:composer.photoHint', { current: photos.length, max: MAX_PHOTOS })}
                                    </span>
                                </Button>
                                {!voiceJournalOn ? null : recording ? (
                                    <div className="flex h-11 items-center gap-2 rounded-input border border-border bg-surface-2/40 px-3 md:h-10">
                                        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-danger animate-pulse" aria-hidden="true" />
                                        <span className="text-caption font-medium tabular-nums text-foreground">
                                            {formatRecordDuration(recordSeconds)}
                                        </span>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            aria-label={t('journal:voice.stop')}
                                            onClick={stopRecording}
                                        >
                                            <Square className="h-4 w-4" />
                                        </Button>
                                    </div>
                                ) : (
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        onClick={() => void startRecording()}
                                        disabled={transcribing}
                                        aria-label={t('journal:voice.record')}
                                    >
                                        <Mic className="mr-2 h-4 w-4" />
                                        {transcribing ? t('journal:voice.transcribing') : t('journal:voice.record')}
                                    </Button>
                                )}
                            </div>

                            {photos.length > 0 && (
                                <div className="flex flex-wrap gap-2">
                                    {photos.map((photo, index) => (
                                        <div key={index} className="relative">
                                            <img
                                                src={photo}
                                                alt={t('journal:photo.alt')}
                                                className="h-16 w-16 rounded-input border border-border object-cover"
                                            />
                                            <button
                                                type="button"
                                                aria-label={t('journal:composer.removePhoto')}
                                                onClick={() => setPhotos((prev) => prev.filter((_, i) => i !== index))}
                                                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-surface hover:text-foreground"
                                            >
                                                <X className="h-3 w-3" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {photoError ? <p className="text-micro text-danger">{photoError}</p> : null}

                            <div className="sm:max-w-sm">
                                <Input
                                    id="journal-author-name"
                                    label={t('journal:team.nameLabel')}
                                    value={authorName}
                                    onChange={(e) => setAuthorName(e.target.value)}
                                    list={authorNames.length > 0 ? 'journal-author-names' : undefined}
                                    autoComplete="off"
                                    maxLength={100}
                                    required
                                />
                                {authorNames.length > 0 && (
                                    <datalist id="journal-author-names">
                                        {authorNames.map((n) => <option key={n} value={n} />)}
                                    </datalist>
                                )}
                                <p className="mt-1 text-caption text-muted-foreground">{t('journal:team.nameHint')}</p>
                            </div>

                            <div className="flex justify-end">
                                <Button type="submit" disabled={publishing}>
                                    {publishing ? t('journal:composer.publishing') : t('journal:composer.publish')}
                                </Button>
                            </div>
                        </form>
                    </CardContent>
                </Card>
            )}

            {/* Timeline groupée par jour */}
            {entries.length === 0 ? (
                <EmptyState
                    icon={<BookOpen className="h-10 w-10" />}
                    title={t('journal:empty.title')}
                    description={t('journal:empty.description')}
                />
            ) : (
                <div className="space-y-6">
                    {groups.map(([dayKey, dayEntries]) => (
                        <section key={dayKey}>
                            <h2 className="mb-2 text-caption font-semibold text-muted-foreground first-letter:uppercase">
                                {dayLabel(dayKey)}
                            </h2>
                            <div className="space-y-3">
                                {dayEntries.map((entry) => {
                                    return (
                                        <Card key={entry.id}>
                                            <CardContent className="p-4">
                                                <div className="flex items-start gap-3">
                                                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-caption font-semibold text-primary">
                                                        {(entry.author_name || '?').trim().charAt(0).toUpperCase() || '?'}
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                            <span className="text-body font-semibold">{entry.author_name}</span>
                                                            {entry.team_entry && (
                                                                <span className="text-micro text-muted-foreground">{t('journal:team.badge')}</span>
                                                            )}
                                                            <span className="text-micro text-muted-foreground">
                                                                {formatClock(entry.occurred_at)}
                                                            </span>
                                                        </div>
                                                        {entry.content ? (
                                                            <p className="mt-1 whitespace-pre-wrap text-body text-foreground">
                                                                {entry.content}
                                                            </p>
                                                        ) : null}
                                                        {entry.photos.length > 0 && (
                                                            <div className="mt-2 flex flex-wrap gap-2">
                                                                {entry.photos.map((photo) => (
                                                                    <button
                                                                        key={photo.id}
                                                                        type="button"
                                                                        aria-label={t('journal:photo.open')}
                                                                        onClick={() => { if (!teamMode) setLightboxPhoto(photo); }}
                                                                        className="rounded-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                                                    >
                                                                        <img
                                                                            src={photo.file_path}
                                                                            alt={t('journal:photo.alt')}
                                                                            className="h-16 w-16 rounded-input border border-border object-cover"
                                                                        />
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                    {canManage(entry) && (
                                                        <div className="flex shrink-0 items-center gap-1">
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                aria-label={t('journal:actions.edit')}
                                                                onClick={() => openEdit(entry)}
                                                            >
                                                                <Edit2 className="h-4 w-4" />
                                                            </Button>
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                aria-label={t('journal:actions.delete')}
                                                                onClick={() => void handleDelete(entry)}
                                                            >
                                                                <Trash2 className="h-4 w-4 text-danger" />
                                                            </Button>
                                                        </div>
                                                    )}
                                                </div>
                                            </CardContent>
                                        </Card>
                                    );
                                })}
                            </div>
                        </section>
                    ))}

                    {hasMore && (
                        <div className="flex justify-center">
                            <Button variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                                {loadingMore ? t('journal:timeline.loadingMore') : t('journal:timeline.loadMore')}
                            </Button>
                        </div>
                    )}
                </div>
            )}

            {/* Visionneuse photo plein écran */}
            <Dialog
                open={lightboxPhoto !== null}
                onOpenChange={(open) => {
                    if (!open) setLightboxPhoto(null);
                }}
                title={t('journal:photo.title')}
                className="sm:max-w-3xl"
            >
                {lightboxPhoto ? (
                    <img
                        src={lightboxPhoto.file_path}
                        alt={t('journal:photo.alt')}
                        className="max-h-[70vh] w-full rounded-input object-contain"
                    />
                ) : null}
            </Dialog>

            {/* Edition d'une entrée */}
            <Dialog
                open={editingEntry !== null}
                onOpenChange={(open) => {
                    if (!open) setEditingEntry(null);
                }}
                title={t('journal:edit.title')}
            >
                <form onSubmit={handleSaveEdit} className="space-y-4">
                    <Textarea
                        label={t('journal:edit.contentLabel')}
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        rows={4}
                    />
                    <Input
                        label={t('journal:edit.dateLabel')}
                        type="datetime-local"
                        value={editOccurredAt}
                        onChange={(e) => setEditOccurredAt(e.target.value)}
                    />
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setEditingEntry(null)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={savingEdit}>
                            {t('common:actions.save')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Journal;
