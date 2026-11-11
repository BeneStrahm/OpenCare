export const CHART_COLOR_PRESETS = [
    'rgb(var(--primary))',
    'rgb(var(--peach))',
    'rgb(var(--plum))',
    'rgb(var(--warning))',
    'rgb(var(--success))',
    'rgb(var(--muted-foreground))',
];

export const DEFAULT_FAMILY_COLOR = '#DC4A60';

// Familienfarben: jede Farbe hat mind. 3:1 zu Weiss und zum Seitenhintergrund (Punkte, Balken, Ränder).
// Orange, Gelb und Cyan sind dafür im gleichen Farbton dunkler als im Original.
// Schrift auf einer Familienfarbe immer über familyColorStyle() wählen.
export const FAMILY_COLOR_PRESETS = [
    { value: '#FF4466', label: 'Corail' },
    { value: '#EE6506', label: 'Orange' },
    { value: '#B38906', label: 'Jaune' },
    { value: '#16A34A', label: 'Vert' },
    { value: '#059DB7', label: 'Cyan' },
    { value: '#2563EB', label: 'Bleu' },
    { value: '#7C3AED', label: 'Indigo' },
    { value: '#DB2777', label: 'Rose' },
];

// ── Lesbare Schrift auf Familienfarben (Phase 3b: Text mind. 4,5:1) ──

const LIGHT_TEXT = '#ffffff';
// Entspricht --foreground (38 35 31) im hellen Design.
const DARK_TEXT = '#26231f';

const parseHex = (hex: string): [number, number, number] | null => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const toHex = (rgb: [number, number, number]): string =>
    `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;

const luminance = ([r, g, b]: [number, number, number]): number => {
    const lin = (c: number) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

export const contrastRatio = (a: string, b: string): number => {
    const ra = parseHex(a);
    const rb = parseHex(b);
    if (!ra || !rb) return 1;
    const la = luminance(ra);
    const lb = luminance(rb);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const MIN_TEXT_CONTRAST = 4.5;

/**
 * Hintergrund und Schriftfarbe für eine Familienfarbe (z. B. Kreis mit Anfangsbuchstabe).
 * Weisse Schrift, wenn sie reicht, sonst dunkle Schrift. Reicht beides nicht,
 * wird die Farbe im gleichen Farbton dunkler, bis weisse Schrift mind. 4,5:1 hat.
 */
export const familyColorStyle = (color: string | null | undefined): { backgroundColor: string; color: string } => {
    const base = color && parseHex(color) ? color : DEFAULT_FAMILY_COLOR;
    if (contrastRatio(base, LIGHT_TEXT) >= MIN_TEXT_CONTRAST) return { backgroundColor: base, color: LIGHT_TEXT };
    if (contrastRatio(base, DARK_TEXT) >= MIN_TEXT_CONTRAST) return { backgroundColor: base, color: DARK_TEXT };
    let rgb = parseHex(base) as [number, number, number];
    for (let i = 0; i < 40 && contrastRatio(toHex(rgb), LIGHT_TEXT) < MIN_TEXT_CONTRAST; i++) {
        rgb = [rgb[0] * 0.95, rgb[1] * 0.95, rgb[2] * 0.95];
    }
    return { backgroundColor: toHex(rgb), color: LIGHT_TEXT };
};
