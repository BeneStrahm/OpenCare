import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api, type RegisterOptions } from '../lib/api';
import { applyServerLanguage } from '../lib/language';
import i18n from '../i18n';
import { clearRecordingsForCurrentUser, kick, pendingRecordingsForCurrentUser } from '../lib/consultationUploader';

interface User {
    id: string;
    username: string;
    name: string;
    avatar_url?: string | null;
    language?: string;
    /** Farbe der einfachen Ansicht (lib/viewColors.ts), null = Standard */
    view_color?: string | null;
}

interface AuthContextType {
    user: User | null;
    loading: boolean;
    login: (username: string, password: string) => Promise<void>;
    register: (password: string, options: RegisterOptions) => Promise<void>;
    refreshToken: () => Promise<void>;
    logout: () => void;
    isAuthenticated: boolean;
    updateProfile: (data: { name?: string; avatar_url?: string | null }) => Promise<void>;
    /** Block D: Farbe der einfachen Ansicht am eigenen Konto speichern. */
    updateViewColor: (color: string | null) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const AUTH_EXPIRED_EVENT = 'opencare:auth-expired';
const IS_DEMO = Boolean(import.meta.env.VITE_DEMO);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let mounted = true;

        const clearSession = () => {
            api.logout();
            localStorage.removeItem('user');
            if (mounted) {
                setUser(null);
            }
        };

        const onAuthExpired = () => {
            clearSession();
        };

        window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);

        const bootstrapSession = async () => {
            const token = api.getToken();
            // In the static demo there is no real auth: load the seeded user directly.
            if (!token && !IS_DEMO) {
                if (mounted) {
                    setLoading(false);
                }
                return;
            }

            try {
                const response = await api.get<{ success: boolean; data: { user: User } }>('/api/auth/me');
                if (!mounted) {
                    return;
                }

                if (response.success && response.data?.user) {
                    setUser(response.data.user);
                    localStorage.setItem('user', JSON.stringify(response.data.user));
                    // Once per session load: reconcile UI language with the account.
                    applyServerLanguage(response.data.user.language);
                } else {
                    clearSession();
                }
            } catch (error) {
                console.error('Failed to restore session:', error);
                clearSession();
            } finally {
                if (mounted) {
                    setLoading(false);
                }
            }
        };

        void bootstrapSession();

        return () => {
            mounted = false;
            window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
        };
    }, []);

    const login = async (username: string, password: string) => {
        const response = await api.login(username, password);
        if (response.success && response.user) {
            setUser(response.user);
            localStorage.setItem('user', JSON.stringify(response.user));
            applyServerLanguage(response.user.language);
        }
    };

    const register = async (password: string, options: RegisterOptions) => {
        const response = await api.register(password, options);
        if (response.success && response.user) {
            setUser(response.user);
            localStorage.setItem('user', JSON.stringify(response.user));
            applyServerLanguage(response.user.language);
        }
    };

    const refreshToken = async () => {
        const response = await api.refreshToken();
        if (response.success && response.user) {
            setUser(response.user);
            localStorage.setItem('user', JSON.stringify(response.user));
        }
    };

    const logout = () => {
        void logoutChecked();
    };

    // Vor dem Abmelden: wartende Aufnahmen von Arztgespraechen hochladen. Was
    // dann noch wartet, wird nur nach ausdruecklicher Bestaetigung geloescht.
    const logoutChecked = async () => {
        try {
            if (await pendingRecordingsForCurrentUser() > 0) {
                await kick();
                const left = await pendingRecordingsForCurrentUser();
                if (left > 0) {
                    if (!window.confirm(i18n.t('consultations:logout.pending', { count: left }))) return;
                    await clearRecordingsForCurrentUser();
                }
            }
        } catch (error) {
            console.warn('[auth] pending recordings check failed:', error);
        }
        doLogout();
    };

    const doLogout = () => {
        api.logout();
        setUser(null);
        localStorage.removeItem('user');
        // Purge le cache des reponses API (donnees de sante) dans le service
        // worker: sur un appareil partage, elles ne doivent pas rester lisibles
        // hors ligne pour le prochain utilisateur.
        navigator.serviceWorker?.controller?.postMessage({ type: 'PURGE_API_CACHE' });
    };

    const updateProfile = async (data: { name?: string; avatar_url?: string | null }) => {
        const response = await api.put<{ success: boolean; data: { user: User } }>('/api/auth/profile', data);
        if (response.success && response.data?.user) {
            setUser(response.data.user);
            localStorage.setItem('user', JSON.stringify(response.data.user));
        }
    };

    const updateViewColor = async (color: string | null) => {
        const response = await api.put<{ success: boolean; data: { user: User } }>('/api/auth/view-color', { color });
        if (response.success && response.data?.user) {
            setUser(response.data.user);
            localStorage.setItem('user', JSON.stringify(response.data.user));
        }
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                loading,
                login,
                register,
                refreshToken,
                logout,
                isAuthenticated: !!user,
                updateProfile,
                updateViewColor,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};
