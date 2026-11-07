import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, Square, ShieldCheck, Sun } from 'lucide-react';
import { Button } from '../ui';
import {
    startConsultationRecording,
    isRecordingSupported,
    isWakeLockSupported,
    ConsultationRecorderError,
    type ActiveRecording,
} from '../../lib/consultationRecorder';
import { formatDuration } from '../../lib/consultationLogic';

interface Props {
    circleId: string | null;
    consultationId: string;
    onStopped: () => void;
}

/**
 * Aufnahme im Gespraech: Erst die Einwilligung bestaetigen, dann starten.
 * Waehrend der Aufnahme: grosse Laufzeit, grosse Stopp-Taste.
 */
const RecorderPanel: React.FC<Props> = ({ circleId, consultationId, onStopped }) => {
    const { t } = useTranslation(['consultations']);
    const [consent, setConsent] = useState(false);
    // Zeitpunkt, zu dem die Zustimmung des Arztes bestaetigt wurde
    const [consentAt, setConsentAt] = useState<Date | null>(null);
    const [active, setActive] = useState<ActiveRecording | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [wakeLock, setWakeLock] = useState(false);
    const activeRef = useRef<ActiveRecording | null>(null);
    activeRef.current = active;

    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => {
            setElapsed(Math.round((Date.now() - active.startedAt.getTime()) / 1000));
            setWakeLock(active.wakeLockActive());
        }, 1000);
        return () => window.clearInterval(timer);
    }, [active]);

    // Seite verlassen waehrend der Aufnahme: sauber beenden, nichts geht verloren.
    useEffect(() => () => { void activeRef.current?.stop(); }, []);

    const start = async () => {
        if (!consent) return;
        setBusy(true);
        setError(null);
        try {
            const rec = await startConsultationRecording({
                circleId,
                consultationId,
                fromKiosk: false,
                consentConfirmed: true,
                consentAt: consentAt ?? new Date(),
            });
            // Speicher voll: Die Aufnahme endet von selbst, Gespeichertes bleibt erhalten.
            rec.onStorageError(() => {
                setError(t('consultations:recorder.errors.STORAGE_FULL'));
                void stopRef.current?.();
            });
            setElapsed(0);
            setWakeLock(rec.wakeLockActive());
            setActive(rec);
        } catch (e) {
            const code = e instanceof ConsultationRecorderError ? e.code : 'START_FAILED';
            setError(t(`consultations:recorder.errors.${code}`));
        } finally {
            setBusy(false);
        }
    };

    const stop = async () => {
        const active = activeRef.current;
        if (!active) return;
        setBusy(true);
        try {
            await active.stop();
        } finally {
            setActive(null);
            setConsent(false);
            setConsentAt(null);
            setBusy(false);
            onStopped();
        }
    };

    const stopRef = useRef<(() => Promise<void>) | null>(null);
    stopRef.current = stop;

    if (!isRecordingSupported()) {
        return (
            <p className="rounded-input border border-warning/40 bg-warning/10 p-4 text-body text-foreground" role="status">
                {t('consultations:recorder.errors.UNSUPPORTED')}
            </p>
        );
    }

    if (active) {
        return (
            <div className="space-y-4 rounded-card border-2 border-danger/40 bg-danger/5 p-5 text-center" role="region" aria-label={t('consultations:recorder.recordingNow')}>
                <p className="flex items-center justify-center gap-2 text-h2 font-semibold text-danger">
                    <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-danger" aria-hidden="true" />
                    {t('consultations:recorder.recordingNow')}
                </p>
                <p className="font-mono text-display text-foreground" aria-live="off">{formatDuration(elapsed)}</p>
                <p className="flex items-center justify-center gap-2 text-caption text-muted-foreground">
                    <Sun className="h-4 w-4" aria-hidden="true" />
                    {wakeLock ? t('consultations:recorder.wakeLockOn') : t('consultations:recorder.wakeLockOff')}
                </p>
                <Button
                    variant="destructive"
                    size="lg"
                    onClick={() => void stop()}
                    disabled={busy}
                    className="min-h-[64px] w-full text-h2"
                >
                    <Square className="mr-2 h-6 w-6" aria-hidden="true" />
                    {t('consultations:recorder.stop')}
                </Button>
                {error && <p className="text-body text-danger" role="alert">{error}</p>}
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <label className="flex cursor-pointer items-start gap-3 rounded-input border border-border bg-card p-4">
                <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => {
                        setConsent(e.target.checked);
                        setConsentAt(e.target.checked ? new Date() : null);
                    }}
                    className="mt-1 h-6 w-6 shrink-0 accent-primary"
                />
                <span>
                    <span className="flex items-center gap-2 text-body font-semibold text-foreground">
                        <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
                        {t('consultations:recorder.consent')}
                    </span>
                    <span className="mt-1 block text-caption text-muted-foreground">{t('consultations:recorder.consentHint')}</span>
                </span>
            </label>
            <Button
                size="lg"
                onClick={() => void start()}
                disabled={!consent || busy}
                className="min-h-[56px] w-full text-body"
                aria-describedby={!consent ? 'consent-needed' : undefined}
            >
                <Mic className="mr-2 h-5 w-5" aria-hidden="true" />
                {t('consultations:recorder.start')}
            </Button>
            {!consent && (
                <p id="consent-needed" className="text-caption text-muted-foreground">{t('consultations:recorder.consentNeeded')}</p>
            )}
            {!isWakeLockSupported() && (
                <p className="text-caption text-muted-foreground">{t('consultations:recorder.wakeLockUnsupported')}</p>
            )}
            {error && <p className="text-body text-danger" role="alert">{error}</p>}
        </div>
    );
};

export default RecorderPanel;
