import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useWebSocketUpdates } from '../../hooks/useWebSocketUpdates';
import { MAX_VIEW_PHOTOS, prepareViewPhoto } from '../../lib/viewPhotos';
import { Card, CardHeader, CardTitle, CardContent, Button, useToast } from '../ui';

/**
 * Fotos fuer die einfache Ansicht der betreuten Person (Launch Block D).
 * Familie und Admin laden mehrere Fotos hoch; jedes wird vorher im Browser
 * verkleinert und ohne Ortsdaten gespeichert (lib/viewPhotos.ts). Am Tablet
 * erscheinen sie ruhig im Wechsel (RecipientView.tsx).
 */

interface PhotoItem { id: string; created_at: string }

const ViewPhotosCard: React.FC<{ circleId: string | null }> = ({ circleId }) => {
    const { t } = useTranslation(['recipient', 'common']);
    const { showToast } = useToast();
    const [photos, setPhotos] = useState<PhotoItem[]>([]);
    const [images, setImages] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const load = useCallback(async () => {
        if (!circleId) return;
        try {
            const res = await api.get<{ success: boolean; data: PhotoItem[] }>('/api/view-photos');
            setPhotos(Array.isArray(res.data) ? res.data : []);
        } catch {
            showToast({ variant: 'error', title: t('recipient:viewPhotos.errors.load') });
        } finally {
            setLoading(false);
        }
    }, [circleId, showToast, t]);

    useEffect(() => {
        setLoading(true);
        setImages({});
        void load();
    }, [load]);
    useWebSocketUpdates('view_photos', () => void load());

    // Vorschaubilder einzeln nachladen (die Liste enthaelt keine Bilddaten).
    useEffect(() => {
        let cancelled = false;
        for (const photo of photos) {
            if (images[photo.id]) continue;
            api.get<{ success: boolean; data: { id: string; data_url: string } }>(`/api/view-photos/${photo.id}`)
                .then((res) => {
                    if (!cancelled && res.data?.data_url) setImages((prev) => ({ ...prev, [photo.id]: res.data.data_url }));
                })
                .catch(() => undefined);
        }
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [photos]);

    const free = MAX_VIEW_PHOTOS - photos.length;

    const handleFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (files.length === 0) return;
        const chosen = files.slice(0, Math.max(0, free));
        if (files.length > chosen.length) {
            showToast({ variant: 'error', title: t('recipient:viewPhotos.errors.limit', { max: MAX_VIEW_PHOTOS }) });
        }
        let failed = 0;
        setUploading({ done: 0, total: chosen.length });
        for (const [index, file] of chosen.entries()) {
            try {
                const dataUrl = await prepareViewPhoto(file);
                await api.post('/api/view-photos', { data_url: dataUrl });
            } catch {
                failed += 1;
            }
            setUploading({ done: index + 1, total: chosen.length });
        }
        setUploading(null);
        await load();
        if (failed > 0) {
            showToast({ variant: 'error', title: t('recipient:viewPhotos.errors.upload', { count: failed }) });
        } else if (chosen.length > 0) {
            showToast({ title: t('recipient:viewPhotos.uploaded', { count: chosen.length }) });
        }
    };

    const remove = async (id: string) => {
        setBusy(true);
        try {
            await api.delete(`/api/view-photos/${id}`);
            setConfirmDelete(null);
            showToast({ title: t('recipient:viewPhotos.deleted') });
            await load();
        } catch {
            showToast({ variant: 'error', title: t('recipient:viewPhotos.errors.delete') });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card hover={false}>
            <CardHeader>
                <CardTitle className="font-serif">{t('recipient:viewPhotos.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <p className="text-caption text-muted-foreground">{t('recipient:viewPhotos.description', { max: MAX_VIEW_PHOTOS })}</p>

                <div className="flex flex-wrap items-center gap-3">
                    <input
                        ref={inputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => void handleFiles(e)}
                    />
                    <Button
                        variant="secondary"
                        className="min-h-[48px]"
                        onClick={() => inputRef.current?.click()}
                        disabled={uploading !== null || free <= 0}
                    >
                        <ImagePlus className="mr-2 h-5 w-5" aria-hidden="true" />
                        {t('recipient:viewPhotos.add')}
                    </Button>
                    <p className="text-caption text-muted-foreground" role="status">
                        {uploading
                            ? t('recipient:viewPhotos.uploading', { done: uploading.done, total: uploading.total })
                            : free <= 0
                                ? t('recipient:viewPhotos.full', { max: MAX_VIEW_PHOTOS })
                                : t('recipient:viewPhotos.count', { count: photos.length, max: MAX_VIEW_PHOTOS })}
                    </p>
                </div>

                {loading ? (
                    <p className="text-body text-muted-foreground">{t('common:states.loading')}</p>
                ) : photos.length === 0 ? (
                    <p className="text-body text-muted-foreground">{t('recipient:viewPhotos.empty')}</p>
                ) : (
                    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                        {photos.map((photo, index) => (
                            <li key={photo.id} className="flex flex-col gap-2 rounded-card border border-border p-2">
                                {images[photo.id] ? (
                                    <img
                                        src={images[photo.id]}
                                        alt={t('recipient:viewPhotos.alt', { number: index + 1 })}
                                        className="aspect-[4/3] w-full rounded-input object-cover"
                                    />
                                ) : (
                                    <div className="aspect-[4/3] w-full rounded-input bg-surface-2" aria-hidden="true" />
                                )}
                                {confirmDelete === photo.id ? (
                                    <div className="space-y-2">
                                        <p className="text-caption text-foreground">{t('recipient:viewPhotos.confirmDelete')}</p>
                                        <div className="flex flex-wrap gap-2">
                                            <Button variant="destructive" size="sm" className="min-h-[48px]" disabled={busy} onClick={() => void remove(photo.id)}>
                                                {t('recipient:viewPhotos.deleteYes')}
                                            </Button>
                                            <Button variant="ghost" size="sm" className="min-h-[48px]" disabled={busy} onClick={() => setConfirmDelete(null)}>
                                                {t('recipient:viewPhotos.deleteNo')}
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <Button variant="ghost" size="sm" className="min-h-[48px]" onClick={() => setConfirmDelete(photo.id)}>
                                        <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                                        {t('recipient:viewPhotos.delete')}
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
};

export default ViewPhotosCard;
