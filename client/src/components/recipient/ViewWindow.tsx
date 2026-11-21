// Fenster und Scrollbalken der einfachen Ansicht (Rolle recipient), aus RecipientView.tsx
// herausgeloest, damit auch die Fenster des Arztgespraechs (RecipientConsultations.tsx) sie nutzen.
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { VIEW_SCALE } from '../../lib/recipientView';

// Rueckfragen liegen ueber den Fenstern.
const PAGE_LAYER = { window: 'z-[70]', dialog: 'z-[80]' } as const;

/**
 * Einheitliche Seite der einfachen Ansicht (Wunsch vom 14. November): Fenster, Eingaben,
 * Rueckfragen sehen gleich aus, es gibt keine Pop-ups mehr. Leiste oben ueber
 * die volle Breite: links die Uhrzeit, in der Mitte bei Bedarf Symbol und Titel, rechts das X
 * (ohne Text, bewusste Ausnahme, fuer Screenreader "Schliessen"). Darunter der Inhalt, rechts immer
 * der eigene Scrollbalken. X und Balken haben rechts 5 px Abstand. Nur die Startseite hat keine Leiste.
 */
export const ViewWindow: React.FC<{
    id: string;
    title?: string;
    icon?: React.ReactNode;
    /** Ohne Titel in der Leiste: id der Ueberschrift im Inhalt */
    labelledBy?: string;
    role?: 'dialog' | 'alertdialog';
    layer?: keyof typeof PAGE_LAYER;
    clock: string;
    closeLabel: string;
    onClose: () => void;
    style: React.CSSProperties;
    clockStyle: React.CSSProperties;
    titleStyle: React.CSSProperties;
    closeStyle: React.CSSProperties;
    barColor: string;
    barBorder: string;
    scroll: { upLabel: string; downLabel: string; text: string; card: string; track: string; control: string };
    /** E47: weitere Taste links neben dem X (z. B. "Hilfe") */
    action?: React.ReactNode;
    children: React.ReactNode;
}> = ({ id, title, icon, labelledBy, role = 'dialog', layer = 'window', clock, closeLabel, onClose, style, clockStyle, titleStyle, closeStyle, barColor, barBorder, scroll, action, children }) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    return (
        <div className={cn('fixed inset-0 flex flex-col font-kiosk', PAGE_LAYER[layer])} style={style} role={role} aria-modal="true" aria-labelledby={title ? id : labelledBy}>
            <div className="flex shrink-0 items-center gap-3 py-[6px] pl-6 pr-[5px]" style={{ backgroundColor: barColor, borderBottom: `2px solid ${barBorder}` }}>
                <div className="flex min-w-max flex-1 basis-0">
                    <p className="whitespace-nowrap font-bold tabular-nums" style={clockStyle}>{clock}</p>
                </div>
                {title && (
                    <h2 id={id} className="flex min-w-0 items-center justify-center gap-3 text-center font-bold" style={titleStyle}>
                        {icon}
                        <span className="min-w-0">{title}</span>
                    </h2>
                )}
                <div className="flex min-w-max flex-1 basis-0 items-center justify-end gap-3">
                    {action}
                    <button type="button" autoFocus onClick={onClose} aria-label={closeLabel} className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl" style={closeStyle}>
                        <X className="h-10 w-10" strokeWidth={3} aria-hidden="true" />
                    </button>
                </div>
            </div>
            <div className="flex min-h-0 flex-1 gap-3 pr-[5px]">
                <div ref={scrollRef} tabIndex={0} className="min-w-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {/* Alle Fenster volle Breite, rechts kein Rand, der Scrollbalken haelt Abstand (Figma, 14. November) */}
                    <div className="mx-auto flex w-full max-w-[72rem] flex-col gap-5 pb-12 pl-4 pt-5 min-[512px]:pl-6">
                        {children}
                    </div>
                </div>
                <div className="flex w-[2.8125rem] shrink-0 flex-col py-[5px]">
                    <ScrollBar target={scrollRef} {...scroll} />
                </div>
            </div>
        </div>
    );
};

/**
 * Sichtbarer Scrollbalken fuer ein Fenster der einfachen Ansicht (Wunsch vom 12. November,
 * nach BFIT-Bund "Scrollbalken"): oben ein Pfeil-Schalter, dazwischen der Rollbalken mit dem
 * ziehbaren Bildlauffeld (zeigt Position und Groesse des sichtbaren Ausschnitts), unten ein
 * Pfeil-Schalter. Chrome auf Android zeigt den eigenen Balken nur kurz beim Wischen, darum ein
 * eigener. Immer sichtbar (Wunsch vom 14. November): passt alles, sind beide Pfeile gesperrt und
 * das Bildlauffeld fuellt den Rollbalken. Pfeile, Rollbalken und Bildlauffeld gleich breit (Figma).
 */
export const ScrollBar: React.FC<{
    target: React.RefObject<HTMLDivElement | null>;
    upLabel: string;
    downLabel: string;
    text: string;
    card: string;
    track: string;
    control: string;
}> = ({ target, upLabel, downLabel, text, card, track, control }) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const drag = useRef<{ startY: number; startTop: number } | null>(null);
    const [m, setM] = useState({ top: 0, height: 0, client: 0, trackH: 0 });

    useEffect(() => {
        const el = target.current;
        if (!el) return;
        const update = () => setM({
            top: el.scrollTop,
            height: el.scrollHeight,
            client: el.clientHeight,
            trackH: trackRef.current?.clientHeight ?? 0,
        });
        update();
        el.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        let ro: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(update);
            ro.observe(el);
            if (el.firstElementChild) ro.observe(el.firstElementChild);
            if (trackRef.current) ro.observe(trackRef.current);
        }
        return () => {
            el.removeEventListener('scroll', update);
            window.removeEventListener('resize', update);
            ro?.disconnect();
        };
    }, [target]);

    const range = Math.max(0, m.height - m.client);
    const overflow = range > 1;
    const thumbH = overflow ? Math.min(m.trackH, Math.max(48 * VIEW_SCALE, (m.trackH * m.client) / m.height)) : m.trackH;
    const thumbTop = overflow ? ((m.trackH - thumbH) * m.top) / range : 0;
    const atStart = m.top <= 1;
    const atEnd = m.top >= range - 1;

    const smooth = (): ScrollBehavior =>
        typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    const step = (dir: 1 | -1) => target.current?.scrollBy({ top: dir * Math.max(40 * VIEW_SCALE, m.client * 0.75), behavior: smooth() });

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        const box = trackRef.current?.getBoundingClientRect();
        if (!box || !target.current) return;
        const y = e.clientY - box.top;
        if (y >= thumbTop && y <= thumbTop + thumbH) {
            drag.current = { startY: e.clientY, startTop: target.current.scrollTop };
            e.currentTarget.setPointerCapture(e.pointerId);
        } else {
            step(y < thumbTop ? -1 : 1);
        }
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || !target.current || m.trackH <= thumbH) return;
        target.current.scrollTop = d.startTop + ((e.clientY - d.startY) * range) / (m.trackH - thumbH);
    };
    const endDrag = () => { drag.current = null; };

    const arrow = (dir: 1 | -1, disabled: boolean) => (
        <button
            type="button"
            onClick={() => step(dir)}
            disabled={disabled}
            aria-label={dir < 0 ? upLabel : downLabel}
            className="flex h-14 w-full shrink-0 items-center justify-center rounded-2xl disabled:opacity-40"
            style={{ backgroundColor: card, color: text, border: `2px solid ${control}` }}
        >
            {dir < 0
                ? <ChevronUp className="h-9 w-9" strokeWidth={3} aria-hidden="true" />
                : <ChevronDown className="h-9 w-9" strokeWidth={3} aria-hidden="true" />}
        </button>
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
            {arrow(-1, atStart)}
            <div
                ref={trackRef}
                className="relative min-h-[3rem] flex-1 cursor-pointer touch-none select-none"
                aria-hidden="true"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <div className="absolute inset-0 rounded-full" style={{ backgroundColor: track, border: `2px solid ${control}` }} />
                <div
                    className="absolute inset-x-0 rounded-full"
                    style={{ top: thumbTop, height: thumbH, backgroundColor: text }}
                />
            </div>
            {arrow(1, atEnd)}
        </div>
    );
};
