import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ToggleRight } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useCircle } from '../../contexts/CircleContext';
import { Card, CardContent } from '../ui';
import RegionSectionHeader from './RegionSectionHeader';
import {
    FEATURE_IDS, RETIRED_FEATURES, VITAL_TYPES,
    isFeatureEnabled, enabledVitalTypes,
    type VitalType,
} from '../../lib/features';

/** Waehlbare Funktionen: ohne die vorerst stillgelegten. */
const SELECTABLE_FEATURES = FEATURE_IDS.filter((id) => !RETIRED_FEATURES.includes(id));

/**
 * Fork: Funktionen des Kreises ein- und ausschalten (nur Admins).
 * Ausgeschaltete Funktionen verschwinden fuer alle im Kreis, der Server
 * sperrt sie zusaetzlich. Gespeicherte Daten bleiben erhalten.
 */

interface SwitchRowProps {
    label: string;
    hint?: string;
    on: boolean;
    disabled?: boolean;
    onToggle: () => void;
}

export const SwitchRow: React.FC<SwitchRowProps> = ({ label, hint, on, disabled, onToggle }) => (
    <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={onToggle}
        className={cn(
            'flex min-h-[56px] w-full items-center justify-between gap-4 rounded-card border px-4 py-3 text-left transition-colors duration-fast disabled:opacity-60',
            on ? 'border-primary/40 bg-primary-soft' : 'border-border bg-card hover:bg-surface-2'
        )}
    >
        <span className="min-w-0">
            <span className="block text-body font-medium text-foreground">{label}</span>
            {hint && <span className="mt-0.5 block text-micro text-muted-foreground">{hint}</span>}
        </span>
        <span
            aria-hidden="true"
            className={cn(
                'relative inline-flex h-8 w-14 shrink-0 items-center rounded-pill transition-colors duration-fast',
                on ? 'bg-primary' : 'bg-surface-2 border border-border'
            )}
        >
            <span
                className={cn(
                    'inline-block h-6 w-6 rounded-full bg-white shadow transition-transform duration-fast',
                    on ? 'translate-x-7' : 'translate-x-1'
                )}
            />
        </span>
    </button>
);

const FeaturesCard: React.FC = () => {
    const { t } = useTranslation('settings');
    const { activeCircle, refreshCircles } = useCircle();
    const settings = activeCircle?.settings as Record<string, unknown> | undefined;
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const save = async (patch: Record<string, unknown>) => {
        if (!activeCircle) return;
        setSaving(true);
        setError('');
        try {
            await api.put(`/api/circles/${activeCircle.id}`, { settings: patch });
            await refreshCircles();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('features.error'));
        } finally {
            setSaving(false);
        }
    };

    // Der Server ersetzt das ganze Objekt: immer alle Schalter mitschicken.
    const toggleFeature = (id: (typeof FEATURE_IDS)[number]) => {
        const next: Record<string, boolean> = {};
        // Stillgelegte (RETIRED_FEATURES) fehlen in der Liste, sie sind ohnehin aus.
        for (const f of SELECTABLE_FEATURES) next[f] = isFeatureEnabled(settings, f);
        next[id] = !next[id];
        void save({ features: next });
    };

    const vitals = enabledVitalTypes(settings);
    const toggleVital = (type: VitalType) => {
        const next = vitals.includes(type) ? vitals.filter((v) => v !== type) : [...vitals, type];
        if (next.length === 0) return; // mindestens ein Messwert bleibt
        void save({ vital_types: next });
    };
    const healthOn = isFeatureEnabled(settings, 'health');

    return (
        <Card>
            <CardContent className="p-6">
                <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary">
                        <ToggleRight className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 className="text-caption font-semibold text-foreground">{t('features.title')}</h3>
                        <p className="mt-1 text-micro text-muted-foreground">{t('features.subtitle')}</p>
                    </div>
                </div>

                <div className="mt-6 space-y-6 divide-y divide-border [&>*+*]:pt-6">
                    <section>
                        <RegionSectionHeader title={t('features.modules.title')} subtitle={t('features.modules.subtitle')} scope="circle" />
                        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                            {SELECTABLE_FEATURES.map((id) => (
                                <SwitchRow
                                    key={id}
                                    label={t(`features.items.${id}`)}
                                    on={isFeatureEnabled(settings, id)}
                                    disabled={saving}
                                    onToggle={() => toggleFeature(id)}
                                />
                            ))}
                        </div>
                        <p className="mt-3 text-micro text-muted-foreground">{t('features.modules.fixed')}</p>
                    </section>

                    {healthOn && (
                        <section>
                            <RegionSectionHeader title={t('features.vitals.title')} subtitle={t('features.vitals.subtitle')} scope="circle" />
                            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                                {VITAL_TYPES.map((type) => {
                                    const on = vitals.includes(type);
                                    return (
                                        <SwitchRow
                                            key={type}
                                            label={t(`features.vitals.items.${type}`)}
                                            on={on}
                                            disabled={saving || (on && vitals.length === 1)}
                                            onToggle={() => toggleVital(type)}
                                        />
                                    );
                                })}
                            </div>
                            <p className="mt-3 text-micro text-muted-foreground">{t('features.vitals.hint')}</p>
                        </section>
                    )}
                </div>

                <p className="mt-6 text-micro text-muted-foreground">{t('features.dataKept')}</p>
                {error && <p className="mt-2 text-caption text-danger">{error}</p>}
            </CardContent>
        </Card>
    );
};

export default FeaturesCard;
