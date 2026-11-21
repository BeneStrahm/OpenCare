// E64 Teambereich in der einfachen Ansicht (Rolle recipient), Figma T1 bis T5:
// Passwortseite, Pflegetagebuch und Medikamentenplan. Taste, Hinweis und Kacheln stehen in
// RecipientView.tsx. Pflegetagebuch und Medikamentenplan zeigen dieselben Seiten wie die
// normale App (Wunsch vom 22. November), der Server prueft den offenen Teambereich.
import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList, FileText, Lock } from 'lucide-react';
import { api } from '../../lib/api';
import { TEAM_PIN_MAX, isTeamFunction, onlyDigits, type TeamUnlockResult } from '../../lib/teamAccess';
import Journal from '../../pages/Journal';
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

/** Pflegetagebuch wie in der normalen App, im Teambereich nur lesen und neu eintragen. */
export const TeamJournalWindow: React.FC<{ ui: RecipientUi; onClose: () => void }> = ({ ui, onClose }) => {
    const { t } = useTranslation(['simpleView']);
    const uid = useId();
    return (
        <ViewWindow
            id={`${uid}-title`}
            title={t('simpleView:team.journal')}
            icon={<ClipboardList className="h-9 w-9 shrink-0" style={{ color: ui.C.blue }} aria-hidden="true" />}
            {...ui.windowProps}
            onClose={onClose}
        >
            {/* Schrift und Farben der normalen App */}
            <div className="font-sans text-foreground">
                <Journal teamMode />
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
