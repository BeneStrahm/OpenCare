import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList, Copy, Check, RefreshCw } from 'lucide-react';
import { Button } from '../ui';
import { api, API_BASE_URL } from '../../lib/api';
import { serverUrl } from '../../lib/serverUrl';

// E62: Aufgaben-Link (JSON) für Abrufe von außen, etwa eine Morgen-Mail über n8n.
// Gleicher Aufbau wie das iCal-Abo auf der Kalenderseite. Nur für die Rolle family (prüft auch der Server).
export const TaskFeedCard = () => {
    const { t } = useTranslation(['tasks']);
    const [allowed, setAllowed] = useState(false);
    const [token, setToken] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void (async () => {
            try {
                const response = await api.get<{ success: boolean; data: { allowed: boolean; token: string | null } }>('/api/task-feed/token');
                if (response.success) {
                    setAllowed(response.data.allowed);
                    setToken(response.data.token);
                }
            } catch (err) {
                console.error('Failed to load task feed token:', err);
            }
        })();
    }, []);

    if (!allowed) return null;

    // Der Link wird von der API ausgeliefert, die eine eigene Adresse haben kann (siehe lib/serverUrl).
    const url = token ? serverUrl(API_BASE_URL, window.location.origin, `/api/task-feed/feed/${token}.json`) : '';

    const generate = async () => {
        if (token && !window.confirm(t('tasks:feed.confirmRegen'))) return;
        setBusy(true);
        setError(null);
        try {
            const response = await api.post<{ success: boolean; data: { token: string } }>('/api/task-feed/token', {});
            if (response.success) {
                setToken(response.data.token);
                setCopied(false);
            }
        } catch (err) {
            console.error('Failed to generate task feed token:', err);
            setError(t('tasks:errors.feed'));
        } finally {
            setBusy(false);
        }
    };

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            /* Zwischenablage nicht verfügbar */
        }
    };

    return (
        <section className="rounded-card border border-border bg-surface-2/40 p-4">
            <div className="flex items-start gap-3">
                <ClipboardList className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <h2 className="text-body font-semibold text-foreground">{t('tasks:feed.title')}</h2>
                    <p className="mt-0.5 text-caption text-muted-foreground">{t('tasks:feed.description')}</p>

                    {error && (
                        <p className="mt-2 rounded-input border border-danger/30 bg-danger/10 px-3 py-2 text-caption text-danger">{error}</p>
                    )}

                    {token ? (
                        <div className="mt-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <input
                                    readOnly
                                    value={url}
                                    onFocus={(e) => e.target.select()}
                                    aria-label={t('tasks:feed.linkLabel')}
                                    className="min-h-[48px] min-w-0 flex-1 rounded-input border border-input bg-surface px-3 py-2 text-caption text-foreground"
                                />
                                <Button variant="secondary" size="icon" className="h-12 w-12" onClick={copy} aria-label={t('tasks:feed.copy')}>
                                    {copied ? <Check className="h-5 w-5 text-success" /> : <Copy className="h-5 w-5" />}
                                </Button>
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                                <button
                                    type="button"
                                    onClick={generate}
                                    disabled={busy}
                                    className="flex min-h-[48px] items-center gap-2 text-caption text-muted-foreground hover:text-foreground disabled:opacity-50"
                                >
                                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                                    {t('tasks:feed.regenerate')}
                                </button>
                            </div>
                            <p className="text-caption text-muted-foreground">{t('tasks:feed.privateNote')}</p>
                        </div>
                    ) : (
                        <Button variant="secondary" size="lg" className="mt-3" onClick={generate} disabled={busy}>
                            {t('tasks:feed.generate')}
                        </Button>
                    )}
                </div>
            </div>
        </section>
    );
};
