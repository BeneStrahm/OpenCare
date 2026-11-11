import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { LanguageSwitcher } from '../components/ui/LanguageSwitcher';
import { HeartHandshake, Sun, Moon, AlertCircle } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

// Public preview of an invite, used for the "you will join X's circle" banner.
interface InviteInfo {
    role: string;
    invitee_username: string;
    circle_name: string;
    recipient_first_name: string | null;
    inviter_name: string | null;
}

const MIN_PASSWORD_LENGTH = 10;

/**
 * Anmeldung (E18): Benutzername (VornameNachname) und Passwort.
 * Drei Ansichten:
 *  - login: Benutzername und Passwort;
 *  - invite: Einladungslink, Benutzername steht fest, die Person waehlt nur ihr Passwort;
 *  - first: leerer Server, das erste Konto mit Vor- und Nachname (wird Administrator).
 * Ohne Einladung gibt es kein Registrieren.
 */
const Login: React.FC = () => {
    const { t } = useTranslation(['auth', 'common', 'nav']);
    const { login, register } = useAuth();
    const { actualTheme, setTheme } = useTheme();
    const navigate = useNavigate();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [firstAccount, setFirstAccount] = useState(false);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [inviteToken, setInviteToken] = useState<string | null>(null);
    const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
    const [inviteInvalid, setInviteInvalid] = useState(false);

    // Detect an invite token in the URL (?invite=... or ?token=..., the latter
    // being the /join link format) and auto-switch to registration mode.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const invite = params.get('invite') ?? params.get('token');
        if (invite) {
            setInviteToken(invite);
            return;
        }
        // Leerer Server: das erste Konto anlegen lassen.
        let mounted = true;
        api.get<{ success: boolean; data: { firstAccount: boolean } }>('/api/auth/setup-status')
            .then((res) => {
                if (mounted && res.success && res.data?.firstAccount) setFirstAccount(true);
            })
            .catch(() => undefined);
        return () => {
            mounted = false;
        };
    }, []);

    // Public invite preview: show whose circle will be joined.
    useEffect(() => {
        if (!inviteToken) return;
        let mounted = true;
        api.get<{ success: boolean; data: InviteInfo }>(`/api/invites/info/${inviteToken}`)
            .then((res) => {
                if (!mounted) return;
                if (res.success && res.data) {
                    setInviteInfo(res.data);
                } else {
                    setInviteInvalid(true);
                }
            })
            .catch(() => {
                if (mounted) setInviteInvalid(true);
            });
        return () => {
            mounted = false;
        };
    }, [inviteToken]);

    // Solange die Einladung geprueft wird, kein Formular zeigen (sonst blitzt kurz die Anmeldung auf).
    const inviteLoading = Boolean(inviteToken) && !inviteInfo && !inviteInvalid;
    const mode: 'login' | 'invite' | 'first' = inviteToken && inviteInfo
        ? 'invite'
        : !inviteToken && firstAccount ? 'first' : 'login';

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (mode !== 'login') {
            if (password.length < MIN_PASSWORD_LENGTH) {
                setError(t('auth:reset.tooShort', { count: MIN_PASSWORD_LENGTH }));
                return;
            }
            if (password !== confirm) {
                setError(t('auth:reset.mismatch'));
                return;
            }
        }

        setLoading(true);
        try {
            if (mode === 'login') {
                await login(username, password);
            } else if (mode === 'invite') {
                // Benutzername und Rolle kommen aus der Einladung (Server).
                await register(password, { inviteToken: inviteToken ?? undefined });
                navigate('/', { replace: true });
            } else {
                // Erstes Konto: danach fuehrt die Einrichtung zum Anlegen des Kreises.
                await register(password, { firstName, lastName });
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : t('common:states.error'));
        } finally {
            setLoading(false);
        }
    };

    const circleName = inviteInfo?.recipient_first_name || inviteInfo?.circle_name || '';

    return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4 relative">
            <LanguageSwitcher className="absolute top-4 left-4" />
            <button
                type="button"
                onClick={() => setTheme(actualTheme === 'dark' ? 'light' : 'dark')}
                aria-label={t('nav:user.toggleTheme')}
                className="absolute top-4 right-4 p-2 rounded-input border border-border bg-card text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
            >
                {actualTheme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <Card className="w-full max-w-md" hover={false}>
                <CardHeader className="text-center pb-8 pt-8">
                    <div className="mx-auto mb-6">
                        <img src={`${import.meta.env.BASE_URL}OpenCare.png`} alt="OpenCare" className="w-16 h-16 rounded-xl object-contain mx-auto" />
                    </div>
                    <CardTitle className="font-serif text-display mb-2">
                        Open<span className="text-primary">Care</span>
                    </CardTitle>
                    <p className="text-muted-foreground text-caption">
                        {t('auth:tagline')}
                    </p>
                </CardHeader>

                <CardContent className="space-y-6 px-8 pb-8">
                    {/* Invite banner */}
                    {inviteToken && inviteInfo && (
                        <div className="flex items-start gap-3 p-3 rounded-input bg-primary-soft border border-border">
                            <HeartHandshake className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                            <div>
                                <p className="text-caption text-foreground font-medium">
                                    {t('auth:invite.joinCircle', { name: circleName })}
                                </p>
                                <p className="mt-0.5 text-micro text-muted-foreground">
                                    {t('auth:invite.invitedBy', {
                                        name: inviteInfo.inviter_name || t('auth:invite.someone'),
                                        role: t(`nav:roles.${inviteInfo.role}`, { defaultValue: inviteInfo.role }),
                                    })}
                                </p>
                            </div>
                        </div>
                    )}
                    {inviteToken && inviteInvalid && (
                        <div className="flex items-start gap-3 p-3 rounded-input bg-destructive/10 border border-destructive/20">
                            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                            <p className="text-caption text-destructive">{t('auth:invite.invalid')}</p>
                        </div>
                    )}

                    {!inviteLoading && (
                    <form onSubmit={handleSubmit} className="space-y-5">
                        {mode === 'first' && (
                            <>
                                <p className="text-body-sm text-foreground">{t('auth:first.intro')}</p>
                                <Input
                                    id="first-name"
                                    label={t('auth:fields.firstName')}
                                    type="text"
                                    autoComplete="given-name"
                                    value={firstName}
                                    onChange={(e) => setFirstName(e.target.value)}
                                    required
                                />
                                <Input
                                    id="last-name"
                                    label={t('auth:fields.lastName')}
                                    type="text"
                                    autoComplete="family-name"
                                    value={lastName}
                                    onChange={(e) => setLastName(e.target.value)}
                                    required
                                />
                            </>
                        )}

                        {mode === 'invite' && inviteInfo && (
                            <div className="space-y-1.5">
                                <p className="text-caption font-medium text-foreground">{t('auth:fields.username')}</p>
                                <p className="rounded-input border border-border bg-surface-2 px-4 py-3 text-body font-semibold text-foreground">
                                    {inviteInfo.invitee_username}
                                </p>
                                <p className="text-caption text-muted-foreground">{t('auth:invite.usernameHint')}</p>
                            </div>
                        )}

                        {mode === 'login' && (
                            <div className="space-y-1.5">
                                <Input
                                    id="username"
                                    label={t('auth:fields.username')}
                                    type="text"
                                    autoComplete="username"
                                    autoCapitalize="words"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    required
                                    aria-invalid={error ? true : undefined}
                                    aria-describedby={error ? 'username-hint login-error' : 'username-hint'}
                                />
                                <p id="username-hint" className="text-caption text-muted-foreground">
                                    {t('auth:fields.usernameHint')}
                                </p>
                            </div>
                        )}

                        <div className="space-y-1.5">
                            <Input
                                id="password"
                                label={mode === 'login' ? t('auth:fields.password') : t('auth:reset.newPassword')}
                                type="password"
                                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                aria-invalid={error ? true : undefined}
                                aria-describedby={error ? 'login-error' : undefined}
                            />
                            {mode !== 'login' && (
                                <p className="text-caption text-muted-foreground">
                                    {t('auth:reset.hint', { count: MIN_PASSWORD_LENGTH })}
                                </p>
                            )}
                            {mode === 'login' && (
                                <div className="text-right">
                                    <button
                                        type="button"
                                        onClick={() => navigate('/forgot-password')}
                                        className="text-caption text-primary hover:text-primary/80 transition-colors hover:underline underline-offset-4"
                                    >
                                        {t('auth:login.forgot')}
                                    </button>
                                </div>
                            )}
                        </div>

                        {mode !== 'login' && (
                            <Input
                                id="password-confirm"
                                label={t('auth:reset.confirmPassword')}
                                type="password"
                                autoComplete="new-password"
                                value={confirm}
                                onChange={(e) => setConfirm(e.target.value)}
                                required
                                aria-invalid={error ? true : undefined}
                                aria-describedby={error ? 'login-error' : undefined}
                            />
                        )}

                        {error && (
                            <div role="alert" className="p-3 rounded-input bg-destructive/10 border border-destructive/20 animate-accordion-down">
                                <p id="login-error" className="text-label-sm text-destructive font-medium text-center">{error}</p>
                            </div>
                        )}

                        <Button
                            type="submit"
                            disabled={loading}
                            className="w-full h-12 text-body-sm font-semibold mt-2"
                            size="lg"
                        >
                            {loading ? (
                                <span className="flex items-center gap-2">
                                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    {t('common:states.loading')}
                                </span>
                            ) : mode === 'login' ? (
                                t('auth:login.submit')
                            ) : (
                                t('auth:register.submit')
                            )}
                        </Button>
                    </form>
                    )}

                </CardContent>
            </Card>

            <p className="absolute bottom-6 text-label-sm text-muted-foreground text-center w-full">
                &copy; {new Date().getFullYear()} OpenCare <a href="https://nexaflow.fr" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">NexaFlow</a> &middot; {t('auth:footer')}
            </p>
        </div>
    );
};

export default Login;
