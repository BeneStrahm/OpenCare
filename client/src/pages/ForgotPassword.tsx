import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import { AuthShell } from '../components/auth/AuthShell';
import { Button } from '../components/ui/Button';

/**
 * Passwort vergessen (E18): Konten haben keine E-Mail-Adresse. Die Seite erklaert,
 * dass ein Administrator auf der Seite Kreis einen Link zum Zuruecksetzen erzeugt
 * und weitergibt (24 Stunden gueltig, einmal nutzbar).
 */
const ForgotPassword: React.FC = () => {
    const { t } = useTranslation(['auth', 'common']);
    const navigate = useNavigate();

    return (
        <AuthShell subtitle={t('auth:forgot.subtitle')}>
            <div className="space-y-6">
                <div className="flex items-start gap-3 p-4 rounded-input bg-primary-soft border border-border">
                    <Users className="w-5 h-5 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                    <div className="space-y-1">
                        <p className="text-body-sm font-medium text-foreground">{t('auth:forgot.askAdminTitle')}</p>
                        <p className="text-body-sm text-foreground">{t('auth:forgot.askAdmin')}</p>
                    </div>
                </div>
                <Button type="button" className="w-full h-12" size="lg" onClick={() => navigate('/', { replace: true })}>
                    {t('auth:forgot.backToLogin')}
                </Button>
            </div>
        </AuthShell>
    );
};

export default ForgotPassword;
