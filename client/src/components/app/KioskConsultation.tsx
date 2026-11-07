import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Check, Mic, Square, CloudUpload } from 'lucide-react';
import { getPairedDevice } from '../../lib/kioskDevice';
import {
    startConsultationRecording,
    isRecordingSupported,
    ConsultationRecorderError,
    type ActiveRecording,
} from '../../lib/consultationRecorder';
import { formatDuration, kioskFollowUp } from '../../lib/consultationLogic';
import { getKioskLastRecording, setKioskLastRecording } from '../../lib/consultationUploader';
import KioskQueueStatus from './KioskQueueStatus';

/**
 * Arztgespraech aufnehmen am Tablet der betreuten Person.
 * Drei Schritte, jeweils eine einzige grosse Entscheidung:
 *   1. "Hat der Arzt zugestimmt?" Ja / Nein
 *   2. Aufnahme mit sehr grosser Stopp-Taste
 *   3. "Gespeichert. Wird hochgeladen, sobald Internet da ist."
 */

const C = {
    bg: '#f5f7fb', card: '#ffffff', border: '#d5dbe6', text: '#1d2433', muted: '#5b6472',
    blue: '#1f4fd1', green: '#1f7a3a', red: '#c62828',
};

interface Props {
    fontScale: number;
    onClose: () => void;
}

const KioskConsultation: React.FC<Props> = ({ fontScale, onClose }) => {
    const { t } = useTranslation(['consultations']);
    const [step, setStep] = useState<'consent' | 'recording' | 'saved' | 'declined'>('consent');
    const [active, setActive] = useState<ActiveRecording | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const activeRef = useRef<ActiveRecording | null>(null);
    activeRef.current = active;

    const fs = (px: number): React.CSSProperties => ({ fontSize: `calc(${px}px * ${fontScale || 1})` });

    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - active.startedAt.getTime()) / 1000)), 1000);
        return () => window.clearInterval(timer);
    }, [active]);

    // Schliessen waehrend der Aufnahme: sauber beenden und speichern.
    useEffect(() => () => { void activeRef.current?.stop(); }, []);

    const start = async () => {
        setBusy(true);
        setError(null);
        try {
            // Zweite Aufnahme kurz danach gehoert zum selben Gespraech.
            const followUp = kioskFollowUp(getKioskLastRecording(), Date.now());
            const rec = await startConsultationRecording({
                circleId: getPairedDevice()?.circleId ?? null,
                consultationId: followUp.consultation_id,
                followsClientId: followUp.follows_client_id,
                fromKiosk: true,
                consentConfirmed: true,
                consentAt: new Date(),
            });
            setKioskLastRecording({ client_id: rec.clientId, consultation_id: followUp.consultation_id, at: Date.now() });
            // Speicher voll: Aufnahme endet von selbst, Gespeichertes bleibt erhalten.
            rec.onStorageError(() => {
                setError(t('consultations:recorder.errors.STORAGE_FULL'));
                void stopRef.current?.();
            });
            setElapsed(0);
            setActive(rec);
            setStep('recording');
        } catch (e) {
            const code = e instanceof ConsultationRecorderError ? e.code : 'START_FAILED';
            setError(t(`consultations:recorder.errors.${code}`));
        } finally {
            setBusy(false);
        }
    };

    const stop = async () => {
        const current = activeRef.current;
        if (!current) return;
        setBusy(true);
        try {
            const result = await current.stop();
            // Zeitfenster fuer eine Folgeaufnahme ab dem Ende dieser Aufnahme.
            const last = getKioskLastRecording();
            if (last && last.client_id === result.clientId) setKioskLastRecording({ ...last, at: Date.now() });
        } finally {
            setActive(null);
            setBusy(false);
            setStep('saved');
        }
    };
    const stopRef = useRef<(() => Promise<void>) | null>(null);
    stopRef.current = stop;

    const bigButton = 'flex w-full items-center justify-center gap-4 rounded-3xl px-6 font-bold shadow-md focus:outline-none focus-visible:ring-4 focus-visible:ring-offset-2 active:shadow-inner disabled:opacity-60';

    return (
        <div
            className="fixed inset-0 z-[90] flex flex-col font-kiosk"
            style={{ backgroundColor: C.bg, color: C.text }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="kiosk-consultation-title"
        >
            {step !== 'recording' && (
                <div className="flex justify-end p-4">
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex h-16 min-w-[64px] items-center justify-center gap-2 rounded-2xl px-4 font-semibold"
                        style={{ ...fs(20), backgroundColor: C.card, border: `1px solid ${C.border}` }}
                    >
                        <X className="h-8 w-8" aria-hidden="true" />{t('consultations:kiosk.close')}
                    </button>
                </div>
            )}

            <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-8 p-6 text-center">
                {step === 'consent' && (
                    <>
                        <p id="kiosk-consultation-title" className="font-bold leading-tight" style={fs(40)}>
                            {t('consultations:kiosk.consentQuestion')}
                        </p>
                        <p style={{ ...fs(24), color: C.muted }}>{t('consultations:kiosk.consentHint')}</p>
                        {!isRecordingSupported() ? (
                            <p style={{ ...fs(24), color: C.red }} role="alert">{t('consultations:recorder.errors.UNSUPPORTED')}</p>
                        ) : (
                            <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
                                <button
                                    type="button"
                                    onClick={() => void start()}
                                    disabled={busy}
                                    className={`${bigButton} min-h-[120px] text-white`}
                                    style={{ ...fs(34), backgroundColor: C.green }}
                                >
                                    <Check className="h-12 w-12" aria-hidden="true" />{t('consultations:kiosk.yes')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setStep('declined')}
                                    disabled={busy}
                                    className={`${bigButton} min-h-[120px]`}
                                    style={{ ...fs(34), backgroundColor: C.card, border: `2px solid ${C.border}` }}
                                >
                                    <X className="h-12 w-12" aria-hidden="true" />{t('consultations:kiosk.no')}
                                </button>
                            </div>
                        )}
                        {error && <p style={{ ...fs(24), color: C.red }} role="alert">{error}</p>}
                    </>
                )}

                {step === 'declined' && (
                    <>
                        <p id="kiosk-consultation-title" className="font-bold" style={fs(36)}>{t('consultations:kiosk.declinedTitle')}</p>
                        <p style={{ ...fs(24), color: C.muted }}>{t('consultations:kiosk.declinedHint')}</p>
                        <button type="button" onClick={onClose} className={`${bigButton} min-h-[96px] text-white`} style={{ ...fs(28), backgroundColor: C.blue }}>
                            {t('consultations:kiosk.ok')}
                        </button>
                    </>
                )}

                {step === 'recording' && (
                    <>
                        <p id="kiosk-consultation-title" className="flex items-center gap-3 font-bold" style={{ ...fs(36), color: C.red }}>
                            <Mic className="h-10 w-10 animate-pulse" aria-hidden="true" />
                            {t('consultations:kiosk.recording')}
                        </p>
                        <p className="font-mono font-bold" style={fs(72)}>{formatDuration(elapsed)}</p>
                        <p style={{ ...fs(22), color: C.muted }}>{t('consultations:kiosk.recordingHint')}</p>
                        <button
                            type="button"
                            onClick={() => void stop()}
                            disabled={busy}
                            className={`${bigButton} min-h-[160px] text-white`}
                            style={{ ...fs(40), backgroundColor: C.red }}
                        >
                            <Square className="h-14 w-14" aria-hidden="true" />{t('consultations:kiosk.stop')}
                        </button>
                        {error && <p style={{ ...fs(22), color: C.red }} role="alert">{error}</p>}
                    </>
                )}

                {step === 'saved' && (
                    <>
                        <div className="flex h-36 w-36 items-center justify-center rounded-full" style={{ backgroundColor: C.green }}>
                            <CloudUpload className="h-20 w-20 text-white" aria-hidden="true" />
                        </div>
                        <p id="kiosk-consultation-title" className="font-bold" style={fs(40)} role="status">{t('consultations:kiosk.savedTitle')}</p>
                        <p style={{ ...fs(26), color: C.muted }}>{t('consultations:kiosk.savedHint')}</p>
                        <KioskQueueStatus fontScale={fontScale} />
                        <button type="button" onClick={onClose} className={`${bigButton} min-h-[96px] text-white`} style={{ ...fs(28), backgroundColor: C.blue }}>
                            {t('consultations:kiosk.ok')}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};

export default KioskConsultation;
