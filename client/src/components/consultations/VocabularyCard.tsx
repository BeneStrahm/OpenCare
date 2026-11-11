import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookA, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { Card, CardContent, Button, Input } from '../ui';
import { cleanVocabularyTerm, MAX_VOCABULARY_TERM } from '../../lib/consultationLogic';

interface VocabularyTerm { id: string; term: string; created_at: string }
interface VocabularyData { custom: VocabularyTerm[]; automatic: string[] }

/**
 * Fachwoerter fuer die Spracherkennung: Namen von Medikamenten, Diagnosen
 * oder Aerzten, die oft falsch erkannt werden. Eigene Woerter koennen admin
 * und family pflegen; die automatischen Woerter kommen aus den Daten des
 * Kreises und sind nur zur Ansicht.
 */
const VocabularyCard: React.FC<{ canWrite: boolean }> = ({ canWrite }) => {
    const { t } = useTranslation(['consultations']);
    const [data, setData] = useState<VocabularyData | null>(null);
    const [term, setTerm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);

    const load = async () => {
        try {
            const res = await api.get<{ success: boolean; data: VocabularyData }>('/api/consultations/vocabulary');
            if (res.success && res.data) {
                setData({
                    custom: Array.isArray(res.data.custom) ? res.data.custom : [],
                    automatic: Array.isArray(res.data.automatic) ? res.data.automatic : [],
                });
                setFailed(false);
            }
        } catch {
            setFailed(true);
        }
    };

    useEffect(() => { void load(); }, []);

    const add = async (e: React.FormEvent) => {
        e.preventDefault();
        const clean = cleanVocabularyTerm(term);
        if (!clean) {
            setError(t('consultations:vocabulary.invalid', { max: MAX_VOCABULARY_TERM }));
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await api.post('/api/consultations/vocabulary', { term: clean });
            setTerm('');
            await load();
        } catch (err) {
            setError(err instanceof Error && err.message === 'DUPLICATE'
                ? t('consultations:vocabulary.duplicate')
                : t('consultations:vocabulary.saveError'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (item: VocabularyTerm) => {
        setBusy(true);
        try {
            await api.delete(`/api/consultations/vocabulary/${item.id}`);
            await load();
        } catch {
            setError(t('consultations:vocabulary.saveError'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card hover={false}>
            <CardContent className="space-y-4 pt-5 md:pt-6">
                <div>
                    <h2 className="flex items-center gap-2 text-h2 font-semibold text-foreground">
                        <BookA className="h-5 w-5 text-primary" aria-hidden="true" />
                        {t('consultations:vocabulary.title')}
                    </h2>
                    <p className="mt-1 text-body text-muted-foreground">{t('consultations:vocabulary.hint')}</p>
                </div>

                {failed && <p className="text-caption text-danger" role="alert">{t('consultations:vocabulary.loadError')}</p>}

                <div>
                    <h3 className="mb-2 text-body font-semibold text-foreground">{t('consultations:vocabulary.custom')}</h3>
                    {data && data.custom.length === 0 && (
                        <p className="text-caption text-muted-foreground">{t('consultations:vocabulary.noCustom')}</p>
                    )}
                    <ul className="flex flex-wrap gap-2">
                        {data?.custom.map((item) => (
                            <li key={item.id} className="flex items-center gap-1 rounded-full border border-border bg-card py-1 pl-4 pr-1 text-body">
                                {item.term}
                                {canWrite && (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-9 w-9 text-muted-foreground hover:text-danger"
                                        onClick={() => void remove(item)}
                                        disabled={busy}
                                        aria-label={t('consultations:vocabulary.remove', { term: item.term })}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>

                {canWrite && (
                    <form onSubmit={(e) => void add(e)} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <Input
                            id="vocabulary-term"
                            label={t('consultations:vocabulary.addLabel')}
                            placeholder={t('consultations:vocabulary.placeholder')}
                            value={term}
                            maxLength={MAX_VOCABULARY_TERM}
                            onChange={(e) => setTerm(e.target.value)}
                            aria-invalid={error ? true : undefined}
                            aria-describedby={error ? 'vocabulary-error' : undefined}
                        />
                        <Button type="submit" disabled={busy || !term.trim()} className="min-h-[44px] shrink-0">
                            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
                            {t('consultations:vocabulary.add')}
                        </Button>
                    </form>
                )}
                {error && <p id="vocabulary-error" className="text-caption text-danger" role="alert">{error}</p>}

                {data && data.automatic.length > 0 && (
                    <div>
                        <h3 className="text-body font-semibold text-foreground">{t('consultations:vocabulary.automatic')}</h3>
                        <p className="mb-2 text-caption text-muted-foreground">{t('consultations:vocabulary.automaticHint')}</p>
                        <ul className="flex flex-wrap gap-2">
                            {data.automatic.map((word) => (
                                <li key={word} className="rounded-full bg-muted px-3 py-1 text-caption text-foreground">{word}</li>
                            ))}
                        </ul>
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

export default VocabularyCard;
