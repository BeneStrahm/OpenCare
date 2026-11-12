/**
 * Farben der einfachen Ansicht (Launch Block D, Entscheidung E16).
 *
 * Die betreute Person waehlt in ihren Einstellungen eine Farbe; gespeichert am
 * Konto (users.view_color, Kennungen auch in server/src/routes/userSettings.ts).
 * Die Farbe faerbt Ueberschriften, Hauptasten und helle Flaechen. Gruen fuer
 * "genommen" und Rot fuer Fehler bleiben fest, damit ihre Bedeutung gleich bleibt.
 *
 * Jede Farbe erfuellt die Vorgaben aus Phase 3b (geprueft in tests/client/viewColors.test.ts):
 *   - weisse Schrift auf strong: mind. 4,5:1 (alle hier ueber 6:1)
 *   - dark als Schrift auf Weiss und auf soft: mind. 7:1
 *   - strong als Rand auf dem Hintergrund und auf soft: mind. 3:1
 */

export interface ViewColor {
    id: string;
    /** Tasten mit weisser Schrift, Symbole, Raender gewaehlter Tasten */
    strong: string;
    /** Ueberschriften und betonte Schrift */
    dark: string;
    /** Helle Flaechen hinter Abschnitten */
    soft: string;
}

export const VIEW_COLORS: readonly ViewColor[] = [
    { id: 'blue', strong: '#1f4fd1', dark: '#1a3a9e', soft: '#e8eefc' },
    { id: 'teal', strong: '#0b6e75', dark: '#08545a', soft: '#e3f3f4' },
    { id: 'green', strong: '#2d6a2f', dark: '#1f4d21', soft: '#e8f3e6' },
    { id: 'purple', strong: '#6a3fb5', dark: '#4f2d8a', soft: '#f0eafa' },
    { id: 'berry', strong: '#a3245e', dark: '#7d1a48', soft: '#fbe8f0' },
    { id: 'terracotta', strong: '#a8431c', dark: '#7e3214', soft: '#fbece4' },
    { id: 'brown', strong: '#7a5530', dark: '#5a3e22', soft: '#f5ede4' },
    { id: 'slate', strong: '#4a5568', dark: '#2f3747', soft: '#edf0f4' },
];

export const DEFAULT_VIEW_COLOR = VIEW_COLORS[0];

/** Farbe zur gespeicherten Kennung; unbekannt oder leer -> Blau. */
export function viewColorOf(id: string | null | undefined): ViewColor {
    return VIEW_COLORS.find((c) => c.id === id) ?? DEFAULT_VIEW_COLOR;
}

/**
 * Block L2: Farbe pro Medikament, eingestellt im Medikamentenplan
 * (medications.view_color, Kennungen auch in server/src/lib/viewColors.ts).
 * In der einfachen Ansicht bekommt die Karte des Medikaments die Flaeche soft,
 * das Symbol die Farbe strong. Die Farben folgen den Stabilo-Boss-Stiften, mit
 * denen der Dispenser markiert wird (Wunsch vom 12. November, Gruen bewusst dabei).
 * soft ist so hell wie noetig fuer 7:1 mit der Schrift, strong so dunkel wie noetig
 * fuer 3:1 (geprueft in tests/client/viewColors.test.ts). Farbtoene angenaehert.
 */
export const MEDICATION_COLORS: readonly ViewColor[] = [
    { id: 'pink', strong: '#9d3363', dark: '#401528', soft: '#f992c0' },
    { id: 'blue', strong: '#126086', dark: '#082838', soft: '#62bce9' },
    { id: 'green', strong: '#2a6720', dark: '#112b0d', soft: '#6ac75b' },
    { id: 'orange', strong: '#874a0e', dark: '#381f06', soft: '#ff9a35' },
];

/** Farbe eines Medikaments; leer oder unbekannt -> keine Farbe (neutrale Karte). */
export function medicationColorOf(id: string | null | undefined): ViewColor | null {
    return MEDICATION_COLORS.find((c) => c.id === id) ?? null;
}

/** Relative Leuchtdichte nach WCAG 2.1. */
function luminance(hex: string): number {
    const value = hex.replace('#', '');
    const channel = (i: number) => {
        const c = parseInt(value.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** Kontrastverhaeltnis zweier Farben nach WCAG 2.1 (1 bis 21). */
export function contrastRatio(a: string, b: string): number {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
