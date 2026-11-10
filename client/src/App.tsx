import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './contexts/AuthContext';
import { useCircle } from './contexts/CircleContext';
import Layout from './components/layout/Layout';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Join from './pages/Join';
import CareLink from './pages/CareLink';
import Emergency from './pages/Emergency';
import Handover from './pages/Handover';
import ConsultationPrep from './pages/ConsultationPrep';
import Consultations from './pages/Consultations';
import ConsultationDetail from './pages/ConsultationDetail';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import Journal from './pages/Journal';
import Calendar from './pages/Calendar';
import Medications from './pages/Medications';
import Health from './pages/Health';
import Tasks from './pages/Tasks';
import ShoppingList from './pages/ShoppingList';
import Messages from './pages/Messages';
import Expenses from './pages/Expenses';
import Documents from './pages/Documents';
import Contacts from './pages/Contacts';
import Recipient from './pages/Recipient';
import Circle from './pages/Circle';
import Visitors from './pages/Visitors';
import CarePlan from './pages/CarePlan';
import Settings from './pages/Settings';
import Integrations from './pages/Integrations';
import RecipientView from './pages/RecipientView';
import { isPathEnabled } from './lib/features';
import { recipientCircleOf, recipientRedirect } from './lib/recipientView';

function App() {
    const { isAuthenticated, loading } = useAuth();
    const { loading: circlesLoading, needsOnboarding, activeCircle, circles } = useCircle();
    const { t } = useTranslation('common');
    const location = useLocation();

    // Pages publiques: accessibles sans compte (lien magique intervenant,
    // fiche urgence QR), avant toute logique d'authentification.
    if (location.pathname.startsWith('/care/')) {
        return (
            <Routes>
                <Route path="/care/:token" element={<CareLink />} />
            </Routes>
        );
    }
    if (location.pathname.startsWith('/urgence/')) {
        return (
            <Routes>
                <Route path="/urgence/:token" element={<Emergency />} />
            </Routes>
        );
    }
    if (location.pathname.startsWith('/relais/')) {
        return (
            <Routes>
                <Route path="/relais/:token" element={<Handover />} />
            </Routes>
        );
    }
    // Mot de passe oublie : pages publiques, hors session.
    if (location.pathname === '/forgot-password' || location.pathname === '/reset-password') {
        return (
            <Routes>
                <Route path="/forgot-password" element={<ForgotPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />
            </Routes>
        );
    }

    if (loading || (isAuthenticated && circlesLoading)) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-3">
                    <div className="spinner-brand" />
                    <p className="text-caption text-muted-foreground">{t('states.loading')}</p>
                </div>
            </div>
        );
    }

    if (!isAuthenticated) {
        return <Login />;
    }

    // Betreute Person (Launch Block C): nur die einfache Ansicht, kein Menü und
    // keine Seite der normalen App. Jede andere Adresse führt zurück auf "/".
    const recipientCircle = recipientCircleOf(circles);
    if (recipientCircle) {
        const redirect = recipientRedirect(location.pathname);
        if (redirect) return <Navigate to={redirect} replace />;
        return <RecipientView circle={recipientCircle} />;
    }

    // Sans cercle: onboarding (création du premier cercle) ou page d'invitation.
    if (needsOnboarding && location.pathname !== '/join') {
        return <Onboarding />;
    }
    if (location.pathname === '/onboarding') {
        return <Onboarding />;
    }

    // Fork: Seiten ausgeschalteter Funktionen fuehren zur Uebersicht.
    if (activeCircle && !isPathEnabled(activeCircle.settings, location.pathname)) {
        return <Navigate to="/" replace />;
    }

    return (
        <Layout>
            <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/journal" element={<Journal />} />
                <Route path="/calendar" element={<Calendar />} />
                <Route path="/medications" element={<Medications />} />
                <Route path="/health" element={<Health />} />
                <Route path="/tasks" element={<Tasks />} />
                <Route path="/shopping" element={<ShoppingList />} />
                <Route path="/messages" element={<Messages />} />
                <Route path="/expenses" element={<Expenses />} />
                <Route path="/documents" element={<Documents />} />
                <Route path="/contacts" element={<Contacts />} />
                <Route path="/recipient" element={<Recipient />} />
                <Route path="/consultation" element={<ConsultationPrep />} />
                <Route path="/consultations" element={<Consultations />} />
                <Route path="/consultations/:id" element={<ConsultationDetail />} />
                <Route path="/circle" element={<Circle />} />
                <Route path="/visitors" element={<Visitors />} />
                <Route path="/care-plan" element={<CarePlan />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/integrations" element={<Integrations />} />
                <Route path="/join" element={<Join />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </Layout>
    );
}

export default App;
