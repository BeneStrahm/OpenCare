import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Card, CardContent, Input } from '../ui';
import { SwitchRow } from './FeaturesCard';
import RegionSectionHeader from './RegionSectionHeader';
import { TEAM_SELECTABLE_FUNCTIONS, TEAM_PIN_MAX, TEAM_PIN_MIN, isTeamFunction, isTeamPin, onlyDigits, type TeamAccessInfo, type TeamFunction } from '../../lib/teamAccess';

/**
 * E64 Teambereich (nur admin): gemeinsames Passwort des Pflegeteams fuer das Tablet der
 * betreuten Person und die Funktionen, die es freischaltet. Ohne Passwort oder ohne
 * Funktion erscheint am Tablet keine Taste. Jede Aenderung schliesst einen offenen Teambereich.
 */
const TeamAccessCard: React.FC = () => {
    const { t } = useTranslation('settings');
    const [info, setInfo] = useState<TeamAccessInfo | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState('');
    const [password, setPassword] = useState('');
    const [repeat, setRepeat] = useState('');

    const apply = (data: TeamAccessInfo) => setInfo({ ...data, functions: (data.functions ?? []).filter(isTeamFunction) });

    useEffect(() => {
        api.get<{ success: boolean; data: TeamAccessInfo }>('/api/team-access')
            .then((res) => apply(res.data))
            .catch(() => setLoadFailed(true));
    }, []);

    const save = async (body: { functions: TeamFunction[]; password?: string | null }, message: string) => {
        setSaving(true);
        setError('');
        setSaved('');
        try {
            const res = await api.put<{ success: boolean; data: TeamAccessInfo }>('/api/team-access', body);
            apply(res.data);
            setSaved(message);
            return true;
        } catch (err) {
            const code = err instanceof Error ? err.message : '';
            setError(code === 'TEAM_PIN_FORMAT' ? t('team.errors.length', { min: TEAM_PIN_MIN, max: TEAM_PIN_MAX }) : t('team.errors.save'));
            return false;
        } finally {
            setSaving(false);
        }
    };

    const toggle = (fn: TeamFunction) => {
        if (!info) return;
        const current = info.functions.filter((f) => TEAM_SELECTABLE_FUNCTIONS.includes(f));
        const next = current.includes(fn) ? current.filter((f) => f !== fn) : [...current, fn];
        void save({ functions: next }, t('team.savedFunctions'));
    };

    const savePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!info) return;
        if (!isTeamPin(password)) { setSaved(''); setError(t('team.errors.length', { min: TEAM_PIN_MIN, max: TEAM_PIN_MAX })); return; }
        if (password !== repeat) { setSaved(''); setError(t('team.errors.repeat')); return; }
        if (await save({ functions: info.functions, password }, t('team.savedPassword'))) {
            setPassword('');
            setRepeat('');
        }
    };

    const removePassword = () => {
        if (!info) return;
        void save({ functions: info.functions, password: null }, t('team.removed'));
    };

    return (
        <Card>
            <CardContent className="p-6">
                <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary">
                        <Lock className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 className="text-caption font-semibold text-foreground">{t('team.title')}</h3>
                        <p className="mt-1 text-micro text-muted-foreground">{t('team.subtitle')}</p>
                    </div>
                </div>

                {loadFailed && (
                    <p role="alert" className="mt-4 text-caption text-danger">{t('team.errors.load')}</p>
                )}

                {info && (
                    <div className="mt-6 space-y-6 divide-y divide-border [&>*+*]:pt-6">
                        <section>
                            <RegionSectionHeader title={t('team.functions.title')} subtitle={t('team.functions.subtitle')} scope="circle" />
                            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                                {TEAM_SELECTABLE_FUNCTIONS.map((fn) => (
                                    <SwitchRow
                                        key={fn}
                                        label={t(`team.functions.items.${fn}`)}
                                        hint={t(`team.functions.hints.${fn}`)}
                                        on={info.functions.includes(fn)}
                                        disabled={saving}
                                        onToggle={() => toggle(fn)}
                                    />
                                ))}
                            </div>
                            <p className="mt-3 text-caption text-muted-foreground">{t('team.functions.consultationNote')}</p>
                        </section>

                        <section>
                            <RegionSectionHeader
                                title={t('team.password.title')}
                                subtitle={info.has_password ? t('team.password.isSet') : t('team.password.notSet')}
                                scope="circle"
                            />
                            <form onSubmit={savePassword} className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                                <Input
                                    type="password"
                                    autoComplete="new-password"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    maxLength={TEAM_PIN_MAX}
                                    label={info.has_password ? t('team.password.new') : t('team.password.first')}
                                    value={password}
                                    onChange={(e) => setPassword(onlyDigits(e.target.value))}
                                />
                                <Input
                                    type="password"
                                    autoComplete="new-password"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    maxLength={TEAM_PIN_MAX}
                                    label={t('team.password.repeat')}
                                    value={repeat}
                                    onChange={(e) => setRepeat(onlyDigits(e.target.value))}
                                />
                                <div className="flex flex-wrap gap-3 md:col-span-2">
                                    <Button type="submit" disabled={saving}>{t('team.password.save')}</Button>
                                    {info.has_password && (
                                        <Button type="button" variant="secondary" disabled={saving} onClick={removePassword}>
                                            {t('team.password.remove')}
                                        </Button>
                                    )}
                                </div>
                            </form>
                            <p className="mt-3 text-micro text-muted-foreground">{t('team.password.hint', { min: TEAM_PIN_MIN, max: TEAM_PIN_MAX })}</p>
                        </section>
                    </div>
                )}

                {error && <p role="alert" className="mt-4 text-caption text-danger">{error}</p>}
                {saved && !error && <p role="status" className="mt-4 text-caption text-success">{saved}</p>}
            </CardContent>
        </Card>
    );
};

export default TeamAccessCard;
