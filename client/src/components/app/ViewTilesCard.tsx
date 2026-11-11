import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { useCircle } from '../../contexts/CircleContext';
import { Card, CardHeader, CardTitle, CardContent } from '../ui';
import { SwitchRow } from './FeaturesCard';
import { VIEW_TILE_IDS, VIEW_TILE_FEATURES, isFeatureEnabled, isViewTileOn, type ViewTileId } from '../../lib/features';

/**
 * Kacheln der einfachen Ansicht ein- und ausblenden (nur Admins).
 * Nur Anzeige: die Rechte der betreuten Person bleiben gleich.
 * Die Kachel Einstellungen bleibt immer sichtbar.
 */
const ViewTilesCard: React.FC = () => {
    const { t } = useTranslation('recipient');
    const { activeCircle, refreshCircles } = useCircle();
    const settings = activeCircle?.settings as Record<string, unknown> | undefined;
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    // Der Server ersetzt das ganze Objekt: immer alle Schalter mitschicken.
    const toggle = async (id: ViewTileId) => {
        if (!activeCircle) return;
        const next: Record<string, boolean> = {};
        for (const tile of VIEW_TILE_IDS) next[tile] = isViewTileOn(settings, tile);
        next[id] = !next[id];
        setSaving(true);
        setError('');
        try {
            await api.put(`/api/circles/${activeCircle.id}`, { settings: { view_tiles: next } });
            await refreshCircles();
        } catch {
            setError(t('viewTiles.error'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Card hover={false}>
            <CardHeader>
                <CardTitle className="font-serif">{t('viewTiles.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <p className="text-caption text-muted-foreground">{t('viewTiles.description')}</p>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {VIEW_TILE_IDS.map((id) => {
                        const feature = VIEW_TILE_FEATURES[id];
                        const featureOff = feature !== undefined && !isFeatureEnabled(settings, feature);
                        return (
                            <SwitchRow
                                key={id}
                                label={t(`viewTiles.items.${id}`)}
                                hint={featureOff ? t('viewTiles.featureOff') : undefined}
                                on={isViewTileOn(settings, id)}
                                disabled={saving}
                                onToggle={() => void toggle(id)}
                            />
                        );
                    })}
                </div>
                <p className="text-caption text-muted-foreground">{t('viewTiles.fixed')}</p>
                {error && <p role="alert" className="text-caption text-danger">{error}</p>}
            </CardContent>
        </Card>
    );
};

export default ViewTilesCard;
