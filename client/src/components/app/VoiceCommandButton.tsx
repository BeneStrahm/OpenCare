import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, Square, X, Volume2, Loader2, Check, Pencil, Keyboard, Send } from 'lucide-react';
import { api } from '../../lib/api';
import { intlLocale } from '../../i18n/format';
import { cn } from '../../lib/utils';

// Sprachsteuerung: feste, kleine Befehlsmenge (Termine, Aufgaben, Messwerte).
// Ablauf: Mikrofon -> Text (selbst gehostetes Whisper ueber /api/voice/transcribe)
// -> /api/voice-commands/parse -> grosse Rueckfrage mit Ja / Nein -> /execute.
// Ohne Ja wird nie etwas gespeichert. Fehlt etwas (Uhrzeit, Einheit...), traegt
// man es im Dialog ein. Kein Mikrofon oder kein Whisper: Texteingabe.
//
// Helle, feste Farben wie im Kiosk-Modus, grosse Tasten, Schrift skalierbar.
const C = {
    bg: '#f5f7fb',
    card: '#ffffff',
    border: '#d5dbe6',
    // Rand von Eingabefeldern: mind. 3:1 auf Weiss und auf bg (WCAG 1.4.11)
    inputBorder: '#6b7484',
    text: '#1d2433',
    muted: '#5b6472',
    blue: '#1f4fd1',
    blueSoft: '#e8eefc',
    green: '#1f7a3a',
    greenSoft: '#e6f4ea',
    red: '#d63b3b',
    redSoft: '#fdecec',
};

type Intent = 'create_event' | 'list_events' | 'create_task' | 'complete_task' | 'record_weight' | 'record_glucose';
type Field = 'title' | 'date' | 'time' | 'value' | 'unit' | 'task' | 'due_date';

interface Params {
    title?: string;
    date?: string;
    time?: string;
    category?: 'medical' | 'other';
    due_date?: string;
    query?: string;
    value?: number | string;
    unit?: string;
    task_id?: string;
    task_title?: string;
}

interface ParseData {
    intent: Intent | null;
    params: Params;
    missing: Field[];
    source?: 'rules' | 'local_ai';
    confirmation_text: string | null;
    error?: string;
    candidates?: Array<{ id: string; title: string }>;
    text: string;
}

type Phase =
    | { kind: 'idle' }
    | { kind: 'recording' }
    | { kind: 'working' }
    | { kind: 'confirm'; intent: Intent; params: Params; text: string; source?: string }
    | { kind: 'edit'; intent: Intent; params: Params; missing: Field[]; text: string; hint?: string }
    | { kind: 'choose'; intent: Intent; params: Params; candidates: Array<{ id: string; title: string }> }
    | { kind: 'done'; text: string; list?: Array<{ title: string; time: string }> }
    | { kind: 'error'; text: string };

const FIELDS_FOR: Record<Intent, Field[]> = {
    create_event: ['title', 'date', 'time'],
    list_events: ['date'],
    create_task: ['title', 'due_date'],
    complete_task: ['task'],
    record_weight: ['value', 'unit'],
    record_glucose: ['value', 'unit'],
};

const UNITS: Partial<Record<Intent, string[]>> = {
    record_weight: ['kg', 'lb'],
    record_glucose: ['mg/dL', 'mmol/L', 'g/L'],
};

const pickRecorderMimeType = (): string => {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
};

const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
/** Sicherheitsgrenze: ein Befehl ist kurz. */
const MAX_RECORD_MS = 30_000;

interface VoiceCommandButtonProps {
    /** 'kiosk': grosse Kachel fuer die betreute Person; 'header': Taste in der Kopfzeile. */
    variant: 'kiosk' | 'header';
    fontScale?: number;
    className?: string;
}

const VoiceCommandButton: React.FC<VoiceCommandButtonProps> = ({ variant, fontScale = 1, className }) => {
    const { t } = useTranslation(['voiceCommands']);
    const fs = (px: number): React.CSSProperties => ({ fontSize: `calc(${px}px * ${fontScale})` });
    const speechLang = intlLocale();
    const isKiosk = variant === 'kiosk';

    const [open, setOpen] = useState(false);
    const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
    const [showText, setShowText] = useState(false);
    const [textInput, setTextInput] = useState('');
    const [notice, setNotice] = useState('');

    const recorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const timerRef = useRef<number | null>(null);

    const speak = useCallback((text: string) => {
        if (!text || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
        try {
            window.speechSynthesis.cancel();
            const utter = new SpeechSynthesisUtterance(text);
            utter.lang = speechLang;
            utter.rate = 0.95;
            window.speechSynthesis.speak(utter);
        } catch { /* nur Text */ }
    }, [speechLang]);

    const stopMedia = () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = null;
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== 'inactive') {
            recorder.ondataavailable = null;
            recorder.onstop = null;
            recorder.stop();
        }
        recorderRef.current = null;
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
    };

    useEffect(() => () => {
        stopMedia();
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    }, []);

    const close = () => {
        stopMedia();
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
        setOpen(false);
        setPhase({ kind: 'idle' });
        setNotice('');
        setTextInput('');
    };

    const errorText = (code: string | undefined): string => {
        const key = `voiceCommands:errors.${code ?? 'generic'}`;
        const msg = t(key);
        return msg === key ? t('voiceCommands:errors.generic') : msg;
    };

    const showConfirm = (intent: Intent, params: Params, confirmation: string, source?: string) => {
        setPhase({ kind: 'confirm', intent, params, text: confirmation, source });
        speak(`${confirmation} ${t('voiceCommands:confirm.sayYes')}`);
    };

    const execute = async (intent: Intent, params: Params) => {
        setPhase({ kind: 'working' });
        try {
            const res = await api.post<{ success: boolean; data: { spoken_text: string; events?: Array<{ title: string; time: string }> } }>(
                '/api/voice-commands/execute', { intent, params }
            );
            const text = res.data?.spoken_text || t('voiceCommands:result.saved');
            setPhase({ kind: 'done', text, list: res.data?.events });
            speak(text);
        } catch (error) {
            const text = errorText(error instanceof Error ? error.message : undefined);
            setPhase({ kind: 'error', text });
            speak(text);
        }
    };

    const handleParsed = async (data: ParseData) => {
        if (!data.intent) {
            const text = t('voiceCommands:errors.notUnderstood', { text: data.text });
            setPhase({ kind: 'error', text });
            speak(t('voiceCommands:errors.notUnderstoodShort'));
            return;
        }
        if (data.error === 'TASK_AMBIGUOUS' && data.candidates?.length) {
            setPhase({ kind: 'choose', intent: data.intent, params: data.params, candidates: data.candidates });
            speak(t('voiceCommands:choose.question'));
            return;
        }
        if (data.error) {
            const text = errorText(data.error);
            setPhase({ kind: 'error', text });
            speak(text);
            return;
        }
        if (data.intent === 'list_events') {
            await execute('list_events', data.params);
            return;
        }
        if (data.missing.length > 0 || !data.confirmation_text) {
            setPhase({ kind: 'edit', intent: data.intent, params: data.params, missing: data.missing, text: data.text });
            speak(t('voiceCommands:edit.pleaseComplete'));
            return;
        }
        showConfirm(data.intent, data.params, data.confirmation_text, data.source);
    };

    const sendText = async (text: string) => {
        const clean = text.trim();
        if (!clean) return;
        setPhase({ kind: 'working' });
        setNotice('');
        try {
            const res = await api.post<{ success: boolean; data: ParseData }>('/api/voice-commands/parse', { text: clean });
            if (res.data) await handleParsed(res.data);
        } catch (error) {
            const text = errorText(error instanceof Error ? error.message : undefined);
            setPhase({ kind: 'error', text });
            speak(text);
        }
    };

    const transcribe = async (blob: Blob) => {
        if (blob.size === 0) { setPhase({ kind: 'idle' }); return; }
        if (blob.size > MAX_AUDIO_BYTES) {
            setPhase({ kind: 'error', text: t('voiceCommands:errors.tooLong') });
            return;
        }
        setPhase({ kind: 'working' });
        try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = () => reject(new Error('read'));
                reader.readAsDataURL(blob);
            });
            const res = await api.post<{ success: boolean; data: { text: string } }>('/api/voice/transcribe', { audio: dataUrl });
            const text = res.success ? (res.data?.text ?? '').trim() : '';
            if (!text) {
                setPhase({ kind: 'error', text: t('voiceCommands:errors.empty') });
                return;
            }
            await sendText(text);
        } catch {
            // Whisper nicht eingerichtet oder nicht erreichbar: Texteingabe anbieten.
            setShowText(true);
            setNotice(t('voiceCommands:errors.WHISPER_NOT_CONFIGURED'));
            setPhase({ kind: 'idle' });
        }
    };

    const startRecording = async () => {
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
        setNotice('');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            const mimeType = pickRecorderMimeType();
            const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
            chunksRef.current = [];
            recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
            recorder.onstop = () => {
                if (timerRef.current) window.clearTimeout(timerRef.current);
                stream.getTracks().forEach((track) => track.stop());
                streamRef.current = null;
                const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
                chunksRef.current = [];
                void transcribe(blob);
            };
            recorderRef.current = recorder;
            recorder.start();
            timerRef.current = window.setTimeout(() => stopRecording(), MAX_RECORD_MS);
            setPhase({ kind: 'recording' });
        } catch {
            setShowText(true);
            setNotice(t('voiceCommands:errors.micDenied'));
        }
    };

    const stopRecording = () => {
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== 'inactive') recorder.stop();
    };

    const preview = async (intent: Intent, params: Params) => {
        setPhase({ kind: 'working' });
        try {
            const res = await api.post<{ success: boolean; data: { params: Params; confirmation_text: string } }>(
                '/api/voice-commands/preview', { intent, params }
            );
            if (res.data) showConfirm(intent, res.data.params, res.data.confirmation_text);
        } catch (error) {
            const code = error instanceof Error ? error.message : undefined;
            setPhase({ kind: 'edit', intent, params, missing: [], text: '', hint: errorText(code) });
        }
    };

    // ── Darstellung ──

    const bigButton = 'flex min-h-[72px] w-full items-center justify-center gap-3 rounded-2xl px-5 font-bold shadow-sm active:shadow-inner disabled:opacity-60';

    const trigger = isKiosk ? (
        <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn('flex min-h-[80px] items-center gap-4 rounded-2xl px-5 text-left text-white shadow-md active:shadow-inner', className)}
            style={{ backgroundColor: C.green }}
        >
            <Mic className="h-10 w-10 shrink-0" aria-hidden="true" />
            <span>
                <span className="block font-bold" style={fs(24)}>{t('voiceCommands:trigger')}</span>
                <span className="block" style={{ ...fs(15), opacity: 0.9 }}>{t('voiceCommands:triggerHint')}</span>
            </span>
        </button>
    ) : (
        <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn('inline-flex h-10 items-center gap-2 rounded-input px-3 text-caption font-semibold text-white', className)}
            style={{ backgroundColor: C.green }}
            aria-label={t('voiceCommands:trigger')}
        >
            <Mic className="h-5 w-5" aria-hidden="true" />
            <span className="hidden sm:inline">{t('voiceCommands:trigger')}</span>
        </button>
    );

    if (!open) return trigger;

    const fieldLabel = (f: Field) => t(`voiceCommands:fields.${f}`);
    const inputStyle: React.CSSProperties = { ...fs(22), backgroundColor: C.card, border: `2px solid ${C.inputBorder}`, color: C.text };

    const renderEdit = (p: Extract<Phase, { kind: 'edit' }>) => {
        const fields = FIELDS_FOR[p.intent].filter((f) => f !== 'task');
        const set = (key: keyof Params, value: string) =>
            setPhase({ ...p, params: { ...p.params, [key]: value === '' ? undefined : value } });
        return (
            <form
                className="flex flex-col gap-4"
                onSubmit={(e) => { e.preventDefault(); void preview(p.intent, p.params); }}
            >
                <p className="font-bold" style={fs(26)}>{t(`voiceCommands:intents.${p.intent}`)}</p>
                {p.text && <p style={{ ...fs(18), color: C.muted }}>{t('voiceCommands:heard', { text: p.text })}</p>}
                {p.missing.length > 0 && (
                    <p className="rounded-2xl px-4 py-3" style={{ ...fs(20), backgroundColor: C.blueSoft }}>
                        {t('voiceCommands:edit.missing', { fields: p.missing.map(fieldLabel).join(', ') })}
                    </p>
                )}
                {p.hint && <p className="rounded-2xl px-4 py-3" style={{ ...fs(20), backgroundColor: C.redSoft, color: C.red }}>{p.hint}</p>}
                {fields.map((f) => {
                    const id = `vc-${f}`;
                    if (f === 'unit') {
                        const options = UNITS[p.intent] ?? [];
                        return (
                            <label key={f} htmlFor={id} className="flex flex-col gap-1">
                                <span className="font-semibold" style={fs(20)}>{fieldLabel(f)}</span>
                                <select id={id} value={p.params.unit ?? ''} onChange={(e) => set('unit', e.target.value)}
                                    className="min-h-[60px] rounded-2xl px-4" style={inputStyle} required>
                                    <option value="" disabled>{t('voiceCommands:edit.chooseUnit')}</option>
                                    {options.map((u) => <option key={u} value={u}>{u}</option>)}
                                </select>
                            </label>
                        );
                    }
                    const type = f === 'date' || f === 'due_date' ? 'date' : f === 'time' ? 'time' : 'text';
                    const key = f as keyof Params;
                    return (
                        <label key={f} htmlFor={id} className="flex flex-col gap-1">
                            <span className="font-semibold" style={fs(20)}>{fieldLabel(f)}</span>
                            <input
                                id={id}
                                type={type}
                                inputMode={f === 'value' ? 'decimal' : undefined}
                                value={String(p.params[key] ?? '')}
                                onChange={(e) => set(key, e.target.value)}
                                required={f !== 'due_date'}
                                className="min-h-[60px] rounded-2xl px-4"
                                style={inputStyle}
                            />
                        </label>
                    );
                })}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <button type="submit" className={bigButton} style={{ ...fs(24), backgroundColor: C.blue, color: '#fff' }}>
                        <Check className="h-8 w-8" aria-hidden="true" />{t('voiceCommands:edit.next')}
                    </button>
                    <button type="button" onClick={close} className={bigButton} style={{ ...fs(24), backgroundColor: C.card, color: C.text, border: `2px solid ${C.border}` }}>
                        <X className="h-8 w-8" aria-hidden="true" />{t('voiceCommands:confirm.no')}
                    </button>
                </div>
            </form>
        );
    };

    const renderBody = () => {
        switch (phase.kind) {
            case 'idle':
            case 'recording':
                return (
                    <div className="flex flex-col items-center gap-5">
                        <button
                            type="button"
                            onClick={phase.kind === 'recording' ? stopRecording : startRecording}
                            className="flex min-h-[140px] w-full items-center justify-center gap-4 rounded-3xl font-bold text-white shadow-lg active:shadow-inner"
                            style={{ ...fs(30), backgroundColor: phase.kind === 'recording' ? C.red : C.green }}
                            aria-live="polite"
                        >
                            {phase.kind === 'recording'
                                ? (<><Square className="h-12 w-12" strokeWidth={3} aria-hidden="true" />{t('voiceCommands:mic.stop')}</>)
                                : (<><Mic className="h-14 w-14" aria-hidden="true" />{t('voiceCommands:mic.start')}</>)}
                        </button>
                        {notice && <p className="text-center" style={{ ...fs(20), color: C.red }}>{notice}</p>}
                        {!showText && phase.kind === 'idle' && (
                            <button type="button" onClick={() => setShowText(true)} className="inline-flex items-center gap-2 underline underline-offset-4" style={{ ...fs(20), color: C.blue }}>
                                <Keyboard className="h-6 w-6" aria-hidden="true" />{t('voiceCommands:typeInstead')}
                            </button>
                        )}
                        {showText && phase.kind === 'idle' && (
                            <form className="flex w-full gap-2" onSubmit={(e) => { e.preventDefault(); void sendText(textInput); }}>
                                <input
                                    value={textInput}
                                    onChange={(e) => setTextInput(e.target.value)}
                                    placeholder={t('voiceCommands:textPlaceholder')}
                                    aria-label={t('voiceCommands:textPlaceholder')}
                                    className="min-h-[64px] flex-1 rounded-2xl px-5"
                                    style={inputStyle}
                                    maxLength={500}
                                />
                                <button type="submit" disabled={!textInput.trim()} className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-white disabled:opacity-60" style={{ backgroundColor: C.blue }} aria-label={t('voiceCommands:send')}>
                                    <Send className="h-7 w-7" aria-hidden="true" />
                                </button>
                            </form>
                        )}
                        <div className="w-full rounded-2xl p-4" style={{ backgroundColor: C.card, border: `1px solid ${C.border}` }}>
                            <p className="mb-2 font-semibold" style={fs(20)}>{t('voiceCommands:examples.title')}</p>
                            <ul className="space-y-1" style={{ ...fs(19), color: C.muted }}>
                                {(['event', 'list', 'task', 'done', 'weight', 'glucose'] as const).map((k) => (
                                    <li key={k} className="italic">{t(`voiceCommands:examples.${k}`)}</li>
                                ))}
                            </ul>
                        </div>
                    </div>
                );
            case 'working':
                return (
                    <div className="flex flex-col items-center gap-4 py-10" role="status">
                        <Loader2 className="h-14 w-14 animate-spin" style={{ color: C.blue }} aria-hidden="true" />
                        <p style={fs(24)}>{t('voiceCommands:mic.working')}</p>
                    </div>
                );
            case 'confirm':
                return (
                    <div className="flex flex-col gap-5">
                        <p className="rounded-3xl px-6 py-6 font-bold leading-snug" style={{ ...fs(30), backgroundColor: C.card, border: `2px solid ${C.blue}` }} aria-live="assertive">
                            {phase.text}
                        </p>
                        {phase.source === 'local_ai' && (
                            <p style={{ ...fs(18), color: C.muted }}>{t('voiceCommands:confirm.localAi')}</p>
                        )}
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <button type="button" onClick={() => void execute(phase.intent, phase.params)} className={bigButton} style={{ ...fs(28), backgroundColor: C.green, color: '#fff', minHeight: 96 }}>
                                <Check className="h-10 w-10" aria-hidden="true" />{t('voiceCommands:confirm.yes')}
                            </button>
                            <button type="button" onClick={close} className={bigButton} style={{ ...fs(28), backgroundColor: C.card, color: C.text, border: `2px solid ${C.border}`, minHeight: 96 }}>
                                <X className="h-10 w-10" aria-hidden="true" />{t('voiceCommands:confirm.no')}
                            </button>
                        </div>
                        <div className="flex flex-wrap justify-center gap-3">
                            <button type="button" onClick={() => speak(phase.text)} className="inline-flex items-center gap-2 rounded-2xl px-4 py-2" style={{ ...fs(20), backgroundColor: C.blueSoft, color: C.blue }}>
                                <Volume2 className="h-6 w-6" aria-hidden="true" />{t('voiceCommands:confirm.readAloud')}
                            </button>
                            {phase.intent !== 'complete_task' && (
                                <button type="button" onClick={() => setPhase({ kind: 'edit', intent: phase.intent, params: phase.params, missing: [], text: '' })} className="inline-flex items-center gap-2 rounded-2xl px-4 py-2" style={{ ...fs(20), backgroundColor: C.blueSoft, color: C.blue }}>
                                    <Pencil className="h-6 w-6" aria-hidden="true" />{t('voiceCommands:confirm.edit')}
                                </button>
                            )}
                        </div>
                    </div>
                );
            case 'edit':
                return renderEdit(phase);
            case 'choose':
                return (
                    <div className="flex flex-col gap-3">
                        <p className="font-bold" style={fs(26)}>{t('voiceCommands:choose.question')}</p>
                        {phase.candidates.map((c) => (
                            <button key={c.id} type="button" onClick={() => void preview(phase.intent, { ...phase.params, task_id: c.id })}
                                className={cn(bigButton, 'justify-start text-left')} style={{ ...fs(24), backgroundColor: C.card, color: C.text, border: `2px solid ${C.border}` }}>
                                {c.title}
                            </button>
                        ))}
                        <button type="button" onClick={close} className={bigButton} style={{ ...fs(22), backgroundColor: C.bg, color: C.muted, border: `1px solid ${C.border}` }}>
                            {t('voiceCommands:confirm.no')}
                        </button>
                    </div>
                );
            case 'done':
            case 'error':
                return (
                    <div className="flex flex-col gap-5">
                        <p className="rounded-3xl px-6 py-6 font-bold leading-snug" aria-live="assertive"
                            style={{ ...fs(28), backgroundColor: phase.kind === 'done' ? C.greenSoft : C.redSoft, color: phase.kind === 'done' ? C.green : C.red }}>
                            {phase.text}
                        </p>
                        {phase.kind === 'done' && phase.list && phase.list.length > 0 && (
                            <ul className="space-y-2">
                                {phase.list.map((ev, i) => (
                                    <li key={`${ev.time}-${i}`} className="flex gap-4 rounded-2xl p-3" style={{ backgroundColor: C.card, border: `1px solid ${C.border}` }}>
                                        <span className="font-bold tabular-nums" style={{ ...fs(22), color: C.blue }}>{ev.time}</span>
                                        <span className="font-bold" style={fs(22)}>{ev.title}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <button type="button" onClick={() => { setPhase({ kind: 'idle' }); setTextInput(''); }} className={bigButton} style={{ ...fs(24), backgroundColor: C.blue, color: '#fff' }}>
                                <Mic className="h-8 w-8" aria-hidden="true" />{t('voiceCommands:result.again')}
                            </button>
                            <button type="button" onClick={close} className={bigButton} style={{ ...fs(24), backgroundColor: C.card, color: C.text, border: `2px solid ${C.border}` }}>
                                {t('voiceCommands:result.close')}
                            </button>
                        </div>
                    </div>
                );
        }
    };

    return (
        <>
            {trigger}
            <div
                className={cn('fixed inset-0 z-[130] flex flex-col overflow-y-auto', isKiosk && 'font-kiosk')}
                style={{ backgroundColor: C.bg, color: C.text }}
                role="dialog"
                aria-modal="true"
                aria-labelledby="voice-command-title"
            >
                <header className="flex items-center justify-between gap-4 px-5 pt-5 lg:px-10">
                    <h2 id="voice-command-title" className="font-extrabold leading-tight" style={{ ...fs(30), color: C.green }}>
                        {t('voiceCommands:title')}
                    </h2>
                    <button type="button" onClick={close} className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl"
                        style={{ backgroundColor: C.card, border: `1px solid ${C.border}` }} aria-label={t('voiceCommands:result.close')}>
                        <X className="h-7 w-7" aria-hidden="true" />
                    </button>
                </header>
                <div className="mx-auto w-full max-w-2xl flex-1 px-5 py-6 lg:px-10">{renderBody()}</div>
            </div>
        </>
    );
};

export default VoiceCommandButton;
