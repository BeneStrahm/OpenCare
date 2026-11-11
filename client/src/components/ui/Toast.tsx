import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ToastItem {
    id: string;
    title: string;
    description?: string;
    actionLabel?: string;
    onAction?: () => void;
    /** 'error': bleibt stehen, bis man die Meldung antippt oder schließt. */
    variant?: 'error';
}

interface ToastContextType {
    showToast: (toast: Omit<ToastItem, 'id'>) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const AppToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { t } = useTranslation('common');
    const [toasts, setToasts] = useState<ToastItem[]>([]);

    const showToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setToasts((prev) => [...prev, { ...toast, id }]);
    }, []);

    const removeToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, []);

    const contextValue = useMemo(() => ({ showToast }), [showToast]);

    return (
        <ToastContext.Provider value={contextValue}>
            <ToastPrimitive.Provider swipeDirection="right">
                {children}
                {toasts.map((toast) => (
                    <ToastPrimitive.Root
                        key={toast.id}
                        defaultOpen
                        onOpenChange={(open: boolean) => {
                            if (!open) removeToast(toast.id);
                        }}
                        duration={toast.variant === 'error' ? Infinity : 9000}
                        onClick={toast.variant === 'error' ? () => removeToast(toast.id) : undefined}
                        className="group pointer-events-auto grid w-full max-w-sm grid-cols-[1fr_auto] items-start gap-3 rounded-card border border-border bg-card p-4 shadow-surface-hover animate-slide-up"
                    >
                        <div>
                            <ToastPrimitive.Title className="text-caption font-semibold text-foreground">
                                {toast.title}
                            </ToastPrimitive.Title>
                            {toast.description ? (
                                <ToastPrimitive.Description className="mt-1 text-micro text-muted-foreground">
                                    {toast.description}
                                </ToastPrimitive.Description>
                            ) : null}
                        </div>

                        <div className="flex items-center gap-2">
                            {toast.actionLabel && toast.onAction ? (
                                <ToastPrimitive.Action
                                    altText={toast.actionLabel}
                                    className="rounded-input px-2 py-1 text-micro font-medium text-primary hover:bg-primary-soft"
                                    onClick={toast.onAction}
                                >
                                    {toast.actionLabel}
                                </ToastPrimitive.Action>
                            ) : null}

                            <ToastPrimitive.Close aria-label={t('actions.close')} className="inline-flex h-12 w-12 items-center justify-center rounded-input text-muted-foreground hover:bg-surface-2 hover:text-foreground">
                                <X className="h-4 w-4" />
                            </ToastPrimitive.Close>
                        </div>
                    </ToastPrimitive.Root>
                ))}

                <ToastPrimitive.Viewport className="fixed bottom-20 right-4 z-[100] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
            </ToastPrimitive.Provider>
        </ToastContext.Provider>
    );
};

export const useToast = () => {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within AppToastProvider');
    }
    return context;
};
