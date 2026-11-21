// Gemeinsame Gestaltung der einfachen Ansicht fuer ausgelagerte Teile (Termin-Formular,
// Arztgespraech). RecipientView.tsx gibt seine Werte mit, damit Farbe (Block D) und
// Textgroesse (--k) ueberall gleich wirken.
import type React from 'react';

export interface Palette {
    bg: string;
    card: string;
    border: string;
    control: string;
    text: string;
    muted: string;
    blue: string;
    blueDark: string;
    blueSoft: string;
    green: string;
    greenSoft: string;
    red: string;
    redSoft: string;
    amber: string;
    amberSoft: string;
}

/** Was ViewWindow ausser id, Titel und Inhalt braucht (aus RecipientView). */
export interface WindowProps {
    style: React.CSSProperties;
    clock: string;
    clockStyle: React.CSSProperties;
    titleStyle: React.CSSProperties;
    closeStyle: React.CSSProperties;
    barColor: string;
    barBorder: string;
    closeLabel: string;
    scroll: { upLabel: string; downLabel: string; text: string; card: string; track: string; control: string };
    onClose: () => void;
}

export interface RecipientUi {
    C: Palette;
    /** Schriftgroesse in rem, mal der eigenen Textgroesse */
    fs: (px: number) => React.CSSProperties;
    tile: React.CSSProperties;
    secondaryButton: React.CSSProperties;
    windowProps: WindowProps;
    /** Uhrzeit "10:30" */
    clockOf: (value: string | Date) => string;
}
