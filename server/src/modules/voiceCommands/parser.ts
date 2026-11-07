// Sprachsteuerung: Erkennung einer kleinen, festen Befehlsmenge.
//
// Reine Funktion ohne Datenbank und ohne KI. Grundsatz: zuverlaessig vor
// clever. Was die Regeln nicht sicher erkennen, wird NICHT geraten, sondern
// als fehlend gemeldet (missing). Die App fragt dann nach oder laesst den
// Wert im Bestaetigungsdialog eintragen.
//
// Unterstuetzt werden Deutsch und Englisch. Beide Regelsaetze werden immer
// probiert, die Sprache der Oberflaeche bestimmt nur die Reihenfolge.
//
// Titel (Termin, Aufgabe) werden aus dem Originaltext ausgeschnitten und
// sonst unveraendert durchgereicht: Fachwoerter, Medikamentennamen und
// Eigennamen wie "Kardiologe Dr. Özdemir" bleiben genau so stehen.

export type VoiceIntent =
    | 'create_event'
    | 'list_events'
    | 'create_task'
    | 'complete_task'
    | 'record_weight'
    | 'record_glucose';

export const VOICE_INTENTS: readonly VoiceIntent[] = [
    'create_event', 'list_events', 'create_task', 'complete_task', 'record_weight', 'record_glucose',
];

export type MissingField = 'title' | 'date' | 'time' | 'value' | 'unit' | 'task';

export type GlucoseUnit = 'mg/dL' | 'mmol/L' | 'g/L';
export type WeightUnit = 'kg' | 'lb';

export interface VoiceParams {
    title?: string;
    /** YYYY-MM-DD */
    date?: string;
    /** HH:MM, 24 Stunden */
    time?: string;
    /** Termin: 'medical' wenn Arzt, Praxis, Klinik... genannt wurde */
    category?: 'medical' | 'other';
    /** Aufgabe: Faelligkeit YYYY-MM-DD */
    due_date?: string;
    /** Aufgabe erledigt: gesuchter Titel */
    query?: string;
    /** Messwert, wie gesagt (vor Umrechnung) */
    value?: number;
    unit?: GlucoseUnit | WeightUnit;
}

export interface ParseResult {
    intent: VoiceIntent | null;
    params: VoiceParams;
    missing: MissingField[];
    /** 'high': alles Noetige sicher erkannt; 'low': Befehl erkannt, aber etwas fehlt. */
    confidence: 'high' | 'low' | 'none';
}

export type ParserLang = 'de' | 'en';

// JavaScript kennt \b nur fuer ASCII: "über" oder "Özdemir" haetten sonst
// falsche Wortgrenzen ("übermorgen" enthielte "morgen"). Alle Muster mit \b
// laufen deshalb durch U() bzw. R(), die eine Unicode-Wortgrenze einsetzen.
const UB = '(?:(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_]))';
const withU = (flags: string) => (flags.includes('u') ? flags : `${flags}u`);
const R = (source: string, flags = ''): RegExp => new RegExp(source.split('\\b').join(UB), withU(flags));
const U = (re: RegExp): RegExp => R(re.source, re.flags);

// ─── Kleine Hilfen ───────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

export const isoDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const addDays = (d: Date, days: number): Date => {
    const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    out.setDate(out.getDate() + days);
    return out;
};

export function isValidDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

export function isValidTime(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const m = value.match(/^(\d{2}):(\d{2})$/);
    return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

const NUMBER_WORDS: Record<string, number> = {
    // de
    ein: 1, eins: 1, eine: 1, einen: 1, einer: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5,
    sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, zwoelf: 12,
    // en
    one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const toNumber = (raw: string): number | null => {
    const lower = raw.toLowerCase();
    if (lower in NUMBER_WORDS) return NUMBER_WORDS[lower];
    const n = Number(raw.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
};

interface Span { start: number; end: number }

/** Entfernt die angegebenen Bereiche aus dem Text. */
const cutSpans = (text: string, spans: Span[]): string => {
    const sorted = [...spans].sort((a, b) => b.start - a.start);
    let out = text;
    for (const s of sorted) out = `${out.slice(0, s.start)} ${out.slice(s.end)}`;
    return out;
};

const WEEKDAYS: Record<string, number> = {
    sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6,
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const MONTHS: Record<string, number> = {
    januar: 1, jänner: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7,
    august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
    january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, october: 10, december: 12,
    jan: 1, feb: 2, mär: 3, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, okt: 10, oct: 10, nov: 11, dez: 12, dec: 12,
};

const WEEKDAY_RE = Object.keys(WEEKDAYS).join('|');
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const NUMWORD_RE = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|');

/** Naechstes Vorkommen eines Wochentags nach heute (heute selbst zaehlt nicht). */
const nextWeekday = (today: Date, name: string): string => {
    const target = WEEKDAYS[name.toLowerCase()];
    let diff = (target - today.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return isoDate(addDays(today, diff));
};

/** Naechstes Datum mit diesem Tag und Monat, heute eingeschlossen. */
const nextDayMonth = (today: Date, day: number, month: number, year?: number): string | null => {
    if (year !== undefined) {
        const candidate = `${year}-${pad(month)}-${pad(day)}`;
        return isValidDate(candidate) ? candidate : null;
    }
    for (const y of [today.getFullYear(), today.getFullYear() + 1]) {
        const candidate = `${y}-${pad(month)}-${pad(day)}`;
        if (!isValidDate(candidate)) continue;
        if (candidate >= isoDate(today)) return candidate;
    }
    return null;
};

interface Found<T> { value: T; span: Span }

// ─── Datum ───────────────────────────────────────────────────────────────────

/**
 * Sucht genau eine Datumsangabe. Wochentage: das naechste Vorkommen nach
 * heute (an einem Montag meint "Montag" also den naechsten Montag).
 */
export function findDate(text: string, today: Date): Found<string> | null {
    const tries: Array<[RegExp, (m: RegExpExecArray) => string | null]> = [
        [U(/\b(?:am\s+|on\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?!\d)/i), (m) => {
            const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
            return nextDayMonth(today, Number(m[1]), Number(m[2]), year);
        }],
        [R(`\\b(?:am\\s+|on\\s+(?:the\\s+)?)?(\\d{1,2})(?:\\.|st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\.?(?:\\s+(\\d{4}))?\\b`, 'iu'), (m) =>
            nextDayMonth(today, Number(m[1]), MONTHS[m[2].toLowerCase()], m[3] ? Number(m[3]) : undefined)],
        [R(`\\b(?:on\\s+)?(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'iu'), (m) =>
            nextDayMonth(today, Number(m[2]), MONTHS[m[1].toLowerCase()], m[3] ? Number(m[3]) : undefined)],
        [U(/\bübermorgen\b|\bday after tomorrow\b/iu), () => isoDate(addDays(today, 2))],
        [U(/\bheute\s+(?:morgen|früh|abend|nachmittag|mittag)\b|\bheute\b|\btoday\b|\btonight\b|\bthis (?:morning|afternoon|evening)\b/iu), () => isoDate(today)],
        // "Montag morgen", "am Dienstagmorgen", "Freitag abend": Tageszeit des
        // Wochentags, NICHT der naechste Tag. Muss vor der Regel fuer "morgen" stehen.
        [R(`\\b(?:am\\s+|nächsten?\\s+|naechsten?\\s+|kommenden?\\s+)?(${WEEKDAY_RE})\\s*(?:morgens?|früh|vormittags?|mittags?|nachmittags?|abends?|nachts?)\\b`, 'iu'), (m) => nextWeekday(today, m[1])],
        [U(/\bmorgen(?:\s+(?:früh|vormittags?|mittags?|nachmittags?|abends?))?\b|\btomorrow(?:\s+(?:morning|afternoon|evening))?\b/iu), () => isoDate(addDays(today, 1))],
        [R(`\\bin\\s+(\\d+|${NUMWORD_RE})\\s+(tag(?:en)?|days?|woche(?:n)?|weeks?)\\b`, 'iu'), (m) => {
            const n = toNumber(m[1]);
            if (n === null || n < 1 || n > 365) return null;
            const unit = m[2].toLowerCase();
            return isoDate(addDays(today, unit.startsWith('w') ? n * 7 : n));
        }],
        [R(`\\b(?:am\\s+|on\\s+|nächsten?\\s+|naechsten?\\s+|kommenden?\\s+|next\\s+|this\\s+)?(${WEEKDAY_RE})\\b`, 'iu'), (m) => nextWeekday(today, m[1])],
    ];
    for (const [re, toValue] of tries) {
        const m = re.exec(text);
        if (!m) continue;
        const value = toValue(m);
        if (!value) return null; // Datum genannt, aber ungueltig: nicht weitersuchen, nicht raten
        return { value, span: { start: m.index, end: m.index + m[0].length } };
    }
    return null;
}

// ─── Uhrzeit ─────────────────────────────────────────────────────────────────

const HOUR_WORDS_RE = `(\\d{1,2}|${['eins', 'ein', 'zwei', 'drei', 'vier', 'fünf', 'fuenf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'zwoelf', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'].join('|')})`;

export interface TimeFound { value: string | null; ambiguous: boolean; span: Span }

/**
 * Sucht eine Uhrzeit. Eine Stunde von 1 bis 6 ohne Zusatz (Uhr morgens,
 * nachmittags, am, pm, Minuten) gilt als mehrdeutig: 3 Uhr nachts oder
 * nachmittags? Dann wird nicht geraten (ambiguous = true, value = null).
 */
export function findTime(text: string): TimeFound | null {
    const result = (m: RegExpExecArray, hour: number, minute: number, explicit: boolean): TimeFound => {
        const after = text.slice(m.index + m[0].length);
        const before = text.slice(0, m.index);
        let h = hour;
        void explicit;
        let qualified = false;
        const pm = U(/^\s*(?:uhr\s+)?(?:nachmittags?|abends?|p\.?\s?m\.?|in the (?:afternoon|evening))\b/iu).test(after)
            || U(/\b(?:heute|morgen)\s+(?:nachmittag|abend)\b/iu).test(before) || U(/\b(?:tonight|this (?:afternoon|evening))\b/iu).test(text)
            || R(`\\b(?:${WEEKDAY_RE})\\s*(?:nachmittags?|abends?)\\b`, 'iu').test(before)
            || R(`\\b(?:${WEEKDAY_RE})\\s+(?:afternoon|evening)\\b`, 'iu').test(before);
        const am = U(/^\s*(?:uhr\s+)?(?:morgens|früh|vormittags?|nachts|in der nacht|a\.?\s?m\.?|in the morning|at night)\b/iu).test(after)
            || U(/\bheute\s+(?:morgen|früh)\b|\bmorgen\s+früh\b|\bthis morning\b|\btomorrow morning\b/iu).test(before)
            || R(`\\b(?:${WEEKDAY_RE})\\s*(?:morgens?|früh|vormittags?)\\b`, 'iu').test(before)
            || R(`\\b(?:${WEEKDAY_RE})\\s+morning\\b`, 'iu').test(before);
        if (pm && h >= 1 && h <= 11) { h += 12; qualified = true; }
        if (am) { if (h === 12) h = 0; qualified = true; }
        const end = m.index + m[0].length + (() => {
            const q = after.match(U(/^\s*(?:uhr\s+)?(?:nachmittags?|abends?|morgens|früh|vormittags?|nachts|in der nacht|a\.?\s?m\.?|p\.?\s?m\.?|in the (?:afternoon|evening|morning)|at night)\b/iu));
            return q ? q[0].length : 0;
        })();
        const span = { start: m.index, end };
        if (h > 23 || minute > 59) return { value: null, ambiguous: false, span };
        // Stunde 1 bis 6 ohne Zusatz: nachts oder nachmittags? Nicht raten.
        if (!qualified && h >= 1 && h <= 6) return { value: null, ambiguous: true, span };
        return { value: `${pad(h)}:${pad(minute)}`, ambiguous: false, span };
    };

    const hourOf = (raw: string): number | null => {
        const n = toNumber(raw);
        return n !== null && Number.isInteger(n) ? n : null;
    };

    let m: RegExpExecArray | null;
    // halb zehn = 9:30, viertel nach neun = 9:15, viertel vor zehn / dreiviertel zehn = 9:45
    if ((m = R(`\\b(?:um\\s+)?halb\\s+${HOUR_WORDS_RE}\\b`, 'iu').exec(text))) {
        const h = hourOf(m[1]);
        // "halb eins" meint 12:30 (mit "nachts" 0:30, siehe result()).
        if (h === 1) return result(m, 12, 30, true);
        if (h !== null && h >= 2 && h <= 24) return result(m, h - 1, 30, h - 1 > 6);
    }
    if ((m = R(`\\b(?:um\\s+)?viertel\\s+nach\\s+${HOUR_WORDS_RE}\\b`, 'iu').exec(text))) {
        const h = hourOf(m[1]);
        if (h !== null) return result(m, h, 15, h > 6);
    }
    if ((m = R(`\\b(?:um\\s+)?(?:viertel\\s+vor|dreiviertel)\\s+${HOUR_WORDS_RE}\\b`, 'iu').exec(text))) {
        const h = hourOf(m[1]);
        if (h === 1) return result(m, 12, 45, true);
        if (h !== null && h >= 2) return result(m, h - 1, 45, h - 1 > 6);
    }
    if ((m = R(`\\b(?:at\\s+)?half\\s+past\\s+${HOUR_WORDS_RE}\\b`, 'iu').exec(text))) {
        const h = hourOf(m[1]);
        if (h !== null) return result(m, h, 30, h > 6);
    }
    if ((m = R(`\\b(?:at\\s+)?quarter\\s+(past|to)\\s+${HOUR_WORDS_RE}\\b`, 'iu').exec(text))) {
        const h = hourOf(m[2]);
        if (h !== null) return m[1].toLowerCase() === 'past' ? result(m, h, 15, h > 6) : result(m, h - 1, 45, h - 1 > 6);
    }
    // Mitternacht / midnight = 0:00, noon = 12:00 ("Mittag" allein ist zu ungenau: nachfragen)
    if ((m = U(/\b(?:um\s+|at\s+|gegen\s+)?(?:mitternacht|midnight)\b/iu).exec(text))) {
        return { value: '00:00', ambiguous: false, span: { start: m.index, end: m.index + m[0].length } };
    }
    if ((m = U(/\b(?:at\s+)?noon\b/iu).exec(text))) {
        return { value: '12:00', ambiguous: false, span: { start: m.index, end: m.index + m[0].length } };
    }
    // 9:30, 9.30 Uhr, 14:05 ("12.03." ist ein Datum, keine Uhrzeit)
    for (const cm of text.matchAll(U(/\b(?:um\s+|at\s+|gegen\s+)?(\d{1,2})[:.](\d{2})(?:\s*uhr)?(?!\d|\.\d)/giu))) {
        const next = text[(cm.index ?? 0) + cm[0].length];
        const isColon = cm[0].includes(':');
        if (isColon || next !== '.' || /uhr\s*$/i.test(cm[0])) {
            return result(cm as unknown as RegExpExecArray, Number(cm[1]), Number(cm[2]), false);
        }
    }
    // 9 Uhr 30, 14 Uhr
    if ((m = U(/\b(?:um\s+|gegen\s+)?(\d{1,2})\s*uhr(?:\s+(\d{1,2})\b)?/iu).exec(text))) {
        return result(m, Number(m[1]), m[2] ? Number(m[2]) : 0, Boolean(m[2]) || Number(m[1]) > 6 || Number(m[1]) === 0);
    }
    // 9 am, 2 pm, 9am
    if ((m = U(/\b(?:at\s+)?(\d{1,2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?=\s|$|[,.!?])/iu).exec(text))) {
        let h = Number(m[1]);
        const isPm = m[2].toLowerCase().startsWith('p');
        if (h < 1 || h > 12) return { value: null, ambiguous: false, span: { start: m.index, end: m.index + m[0].length } };
        if (isPm && h < 12) h += 12;
        if (!isPm && h === 12) h = 0;
        return { value: `${pad(h)}:00`, ambiguous: false, span: { start: m.index, end: m.index + m[0].length } };
    }
    // um 9 / at 9 / um neun
    if ((m = R(`\\b(?:um|at|gegen)\\s+${HOUR_WORDS_RE}\\b(?![.,:]\\d)`, 'iu').exec(text))) {
        const h = hourOf(m[1]);
        if (h !== null) return result(m, h, 0, h > 6 || h === 0);
    }
    return null;
}

// ─── Titel aufraeumen ────────────────────────────────────────────────────────

const LEADING_FILLER = /^(?:[:,\-–\s]+|(?:für|fuer|for|einen|eine|ein|an|a|the|den|die|das)\s+)+/iu;
const TRAILING_FILLER = /(?:[\s,:\-–]+|\s+(?:am|um|on|at|bis|by|until|für|for|und|and)\s*)+$/iu;

export function cleanTitle(raw: string): string {
    let t = raw.replace(/\s+/g, ' ').trim();
    let prev = '';
    while (prev !== t) {
        prev = t;
        t = t.replace(LEADING_FILLER, '').replace(TRAILING_FILLER, '').trim();
    }
    return t.slice(0, 255);
}

const MEDICAL_RE = U(/\b(?:dr\.?|doktor|ärzt\w*|arzt\w*|hausarzt\w*|zahnarzt\w*|facharzt\w*|praxis|klinik\w*|krankenhaus\w*|kardiolog\w*|neurolog\w*|orthopäd\w*|urolog\w*|internist\w*|augenarzt\w*|hno|doctor|clinic|hospital|dentist|gp|physician|cardiolog\w*)/iu);

// ─── Messwerte ───────────────────────────────────────────────────────────────

const NUMBER_RE = /(\d+(?:[.,]\d+)?)/;

function parseWeight(text: string): { value?: number; unit?: WeightUnit; missing: MissingField[] } {
    const m = R(`${NUMBER_RE.source}\\s*(kg|kilo(?:gramm)?s?|kilograms?|lbs?|pounds?)?\\b`, 'iu').exec(text);
    if (!m) return { missing: ['value'] };
    const value = Number(m[1].replace(',', '.'));
    const unitRaw = (m[2] ?? '').toLowerCase();
    const unit: WeightUnit | undefined = unitRaw.startsWith('lb') || unitRaw.startsWith('pound') ? 'lb'
        : unitRaw ? 'kg' : undefined;
    return { value, unit, missing: [] };
}

function parseGlucose(text: string): { value?: number; unit?: GlucoseUnit; missing: MissingField[] } {
    const m = R(`${NUMBER_RE.source}\\s*(mg\\s*/?\\s*dl|milligramm|milligram|mmol(?:\\s*/?\\s*l)?|millimol|g\\s*/\\s*l|gramm pro liter)?`, 'iu').exec(text);
    if (!m) return { missing: ['value'] };
    const value = Number(m[1].replace(',', '.'));
    const unitRaw = (m[2] ?? '').toLowerCase().replace(/\s/g, '');
    let unit: GlucoseUnit | undefined;
    if (unitRaw.startsWith('mg') || unitRaw.startsWith('milligram')) unit = 'mg/dL';
    else if (unitRaw.startsWith('mmol') || unitRaw.startsWith('millimol')) unit = 'mmol/L';
    else if (unitRaw.startsWith('g/l') || unitRaw.startsWith('grammproliter')) unit = 'g/L';
    else if (value >= 40 && value <= 600 && Number.isInteger(value)) unit = 'mg/dL';
    // Ohne Einheit und unter 40: koennte mmol/L oder g/L sein. Nicht raten.
    return { value, unit, missing: unit ? [] : ['unit'] };
}

/** Grenzen fuer plausible Werte (in kg bzw. mg/dL). Ausserhalb wird nicht gespeichert. */
export const WEIGHT_RANGE_KG = { min: 20, max: 350 };
export const GLUCOSE_RANGE_MGDL = { min: 10, max: 1000 };
const LB_PER_KG = 2.2046226218;
const MGDL_PER_MMOL = 18.016;

export function weightToKg(value: number, unit: WeightUnit): number {
    return unit === 'lb' ? value / LB_PER_KG : value;
}

/** OpenCare speichert Blutzucker metrisch in g/L (siehe lib/units.ts). */
export function glucoseToGl(value: number, unit: GlucoseUnit): number {
    if (unit === 'g/L') return value;
    if (unit === 'mg/dL') return value / 100;
    return (value * MGDL_PER_MMOL) / 100;
}

export function glucoseToMgdl(value: number, unit: GlucoseUnit): number {
    return glucoseToGl(value, unit) * 100;
}

// ─── Befehle ─────────────────────────────────────────────────────────────────

const LIST_EVENTS_RE = U(/\b(?:welche|was für|was fuer|habe ich|hab ich|gibt es|stehen|steht)\b[^?]*\btermin|\btermine\b\s*(?:für\s+|fuer\s+|am\s+)?(?:heute|morgen|übermorgen)\s*\??$|^\s*(?:meine\s+)?termine\b|\bwas steht\b.*\ban\b|\b(?:what|which|any|do i have|show)\b[^?]*\b(?:appointments?|events?)\b|^\s*(?:my\s+)?(?:appointments?|schedule)\b|\bwhat'?s on\b/iu);

const COMPLETE_TASK_RES: RegExp[] = [
    U(/\baufgabe\s+(.+?)\s+(?:ist\s+|als\s+)?(?:erledigt|fertig|gemacht|abgehakt)\b/iu),
    U(/^\s*(?:erledigt|abhaken|hake\s+ab)\s*[:,]?\s*(?:die\s+)?(?:aufgabe\s+)?(.+?)\s*$/iu),
    U(/^\s*(.+?)\s+(?:ist\s+)?erledigt\s*$/iu),
    U(/\btask\s+(.+?)\s+(?:is\s+)?(?:done|completed|finished)\b/iu),
    U(/^\s*(?:mark|tick off|complete)\s+(?:the\s+)?(?:task\s+)?(.+?)(?:\s+as\s+(?:done|complete|completed))?\s*$/iu),
    U(/^\s*(.+?)\s+(?:is\s+)?done\s*$/iu),
];

const CREATE_TASK_RE = U(/^\s*(?:neue\s+aufgabe|aufgabe\s+(?:anlegen|erstellen|hinzufügen|hinzufuegen|eintragen)|(?:erstelle|lege|mach|mache|trage)\s+(?:eine\s+|neue\s+)*aufgabe(?:\s+an|\s+ein)?|aufgabe|new\s+task|add\s+(?:a\s+)?task|create\s+(?:a\s+)?task|task)\b\s*[:,]?\s*/iu);

const CREATE_EVENT_RE = U(/^\s*(?:(?:erstelle|erstell|lege|leg|mach|mache|trage|trag|plane|neuer|neuen|ein|einen)\s+)*(?:einen\s+|neuen\s+|ein\s+)*(?:arzt)?termin(?:\s+(?:an|ein|anlegen|erstellen|eintragen))?\b\s*[:,]?\s*|^\s*(?:(?:create|add|make|schedule|new)\s+)+(?:an?\s+|new\s+)*(?:appointment|event)\b\s*[:,]?\s*|^\s*(?:appointment|event)\b\s*[:,]?\s*/iu);

const WEIGHT_RE = U(/\b(?:gewicht|wiege|gewogen|weight|weigh(?:s|ed)?)\b/iu);
const GLUCOSE_RE = U(/\b(?:blutzucker\w*|zucker\w*|glukose|glucose|bz|blood\s+sugar|sugar)\b/iu);

const DUE_RE = U(/\s*\b(?:bis|by|until|due)\s+/iu);

function normalizeInput(text: string): string {
    return text
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(?:bitte|please|ok(?:ay)?|hallo|hey)[\s,]+/iu, '')
        .replace(/[\s,]+(?:bitte|please)$/iu, '')
        .replace(/[.!]+$/, '')
        .trim();
}

/** Messwert ohne Zahl ist nur ein Befehl, wenn ausdruecklich erfasst werden soll. */
const RECORD_VERB_RE = U(/\b(?:eintragen|erfassen|messen|gemessen|notieren|speichern|record|log|enter|measure)\b/iu);

/** Erkennt einen Befehl. today = aktuelles lokales Datum des Servers. */
export function parseCommand(input: string, today: Date, lang: ParserLang = 'de'): ParseResult {
    void lang; // Beide Regelsaetze sind gleichzeitig aktiv, siehe Kopfkommentar.
    const text = normalizeInput(typeof input === 'string' ? input.slice(0, 500) : '');
    const none: ParseResult = { intent: null, params: {}, missing: [], confidence: 'none' };
    if (!text) return none;

    // 1. Termine abfragen (nur lesen)
    if (LIST_EVENTS_RE.test(text) && !CREATE_EVENT_RE.test(text)) {
        const date = findDate(text, today);
        return {
            intent: 'list_events',
            params: { date: date?.value ?? isoDate(today) },
            missing: [],
            confidence: 'high',
        };
    }

    // 2. Messwerte (vor Aufgaben, damit "Zucker 110" nie eine Aufgabe wird)
    if (GLUCOSE_RE.test(text) && !CREATE_TASK_RE.test(text) && !CREATE_EVENT_RE.test(text)) {
        const g = parseGlucose(text.slice(text.search(GLUCOSE_RE)));
        const missing = g.missing;
        if (g.value === undefined && !RECORD_VERB_RE.test(text)) return none;
        return {
            intent: 'record_glucose',
            params: { ...(g.value !== undefined ? { value: g.value } : {}), ...(g.unit ? { unit: g.unit } : {}) },
            missing,
            confidence: missing.length ? 'low' : 'high',
        };
    }
    if (WEIGHT_RE.test(text) && !CREATE_TASK_RE.test(text) && !CREATE_EVENT_RE.test(text)) {
        const w = parseWeight(text.slice(text.search(WEIGHT_RE)));
        if (w.value === undefined && !RECORD_VERB_RE.test(text)) return none;
        return {
            intent: 'record_weight',
            params: { ...(w.value !== undefined ? { value: w.value } : {}), ...(w.unit ? { unit: w.unit } : {}) },
            missing: w.missing,
            confidence: w.missing.length ? 'low' : 'high',
        };
    }

    // 3. Aufgabe erledigt
    for (const re of COMPLETE_TASK_RES) {
        const m = re.exec(text);
        if (!m) continue;
        // "Termin ... erledigt" oder ein Befehl zum Anlegen ist keine Erledigt-Meldung
        if (U(/^\s*(?:neue|new|add|create|erstelle)\b/iu).test(text)) break;
        const q = cleanTitle(m[1].replace(/^(?:die|the|meine|my)\s+/iu, ''));
        if (!q) return { intent: 'complete_task', params: {}, missing: ['task'], confidence: 'low' };
        return { intent: 'complete_task', params: { query: q }, missing: [], confidence: 'high' };
    }

    // 4. Aufgabe anlegen
    const taskMatch = CREATE_TASK_RE.exec(text);
    if (taskMatch) {
        let rest = text.slice(taskMatch[0].length);
        let due_date: string | undefined;
        const dueMatch = DUE_RE.exec(rest);
        if (dueMatch) {
            const after = rest.slice(dueMatch.index + dueMatch[0].length);
            const d = findDate(after, today);
            if (d && d.span.start === 0) {
                due_date = d.value;
                rest = rest.slice(0, dueMatch.index) + after.slice(d.span.end);
            }
        }
        const title = cleanTitle(rest);
        return {
            intent: 'create_task',
            params: { ...(title ? { title } : {}), ...(due_date ? { due_date } : {}) },
            missing: title ? [] : ['title'],
            confidence: title ? 'high' : 'low',
        };
    }

    // 5. Termin anlegen
    const eventMatch = CREATE_EVENT_RE.exec(text);
    if (eventMatch) {
        const spans: Span[] = [{ start: eventMatch.index, end: eventMatch.index + eventMatch[0].length }];
        const date = findDate(text.slice(eventMatch[0].length), today);
        const offset = eventMatch[0].length;
        if (date) spans.push({ start: date.span.start + offset, end: date.span.end + offset });
        const time = findTime(text.slice(offset));
        if (time) spans.push({ start: time.span.start + offset, end: time.span.end + offset });
        const title = cleanTitle(cutSpans(text, spans));

        const missing: MissingField[] = [];
        if (!title) missing.push('title');
        if (!date) missing.push('date');
        if (!time || !time.value) missing.push('time');
        const params: VoiceParams = {
            ...(title ? { title, category: MEDICAL_RE.test(title) || /arzttermin/iu.test(eventMatch[0]) ? 'medical' : 'other' } : {}),
            ...(date ? { date: date.value } : {}),
            ...(time?.value ? { time: time.value } : {}),
        };
        if (!params.category) params.category = /arzttermin/iu.test(eventMatch[0]) ? 'medical' : 'other';
        return { intent: 'create_event', params, missing, confidence: missing.length ? 'low' : 'high' };
    }

    return none;
}

// ─── Strenge Pruefung vor dem Ausfuehren ─────────────────────────────────────

export interface ValidatedCommand {
    intent: VoiceIntent;
    params: VoiceParams;
}

/**
 * Prueft Befehl und Parameter, wie sie vom Geraet zurueckkommen (der Nutzer
 * kann im Bestaetigungsdialog Werte ergaenzt haben). Nie dem Client trauen.
 * Gibt einen Fehlercode zurueck, wenn etwas fehlt oder unplausibel ist.
 */
export function validateCommand(intentRaw: unknown, raw: unknown): ValidatedCommand | { error: string } {
    if (typeof intentRaw !== 'string' || !(VOICE_INTENTS as readonly string[]).includes(intentRaw)) {
        return { error: 'UNKNOWN_INTENT' };
    }
    const intent = intentRaw as VoiceIntent;
    const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const str = (v: unknown, max = 255) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
    const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN);

    switch (intent) {
        case 'list_events': {
            if (!isValidDate(p.date)) return { error: 'INVALID_DATE' };
            return { intent, params: { date: p.date } };
        }
        case 'create_event': {
            const title = str(p.title);
            if (!title) return { error: 'TITLE_REQUIRED' };
            if (!isValidDate(p.date)) return { error: 'INVALID_DATE' };
            if (!isValidTime(p.time)) return { error: 'INVALID_TIME' };
            const category = p.category === 'medical' ? 'medical' : 'other';
            return { intent, params: { title, date: p.date, time: p.time, category } };
        }
        case 'create_task': {
            const title = str(p.title);
            if (!title) return { error: 'TITLE_REQUIRED' };
            if (p.due_date !== undefined && p.due_date !== null && p.due_date !== '' && !isValidDate(p.due_date)) {
                return { error: 'INVALID_DATE' };
            }
            return { intent, params: { title, ...(isValidDate(p.due_date) ? { due_date: p.due_date } : {}) } };
        }
        case 'complete_task': {
            const query = str(p.query);
            if (!query) return { error: 'TASK_REQUIRED' };
            return { intent, params: { query } };
        }
        case 'record_weight': {
            const value = num(p.value);
            const unit: WeightUnit = p.unit === 'lb' ? 'lb' : 'kg';
            if (!Number.isFinite(value)) return { error: 'INVALID_VALUE' };
            const kg = weightToKg(value, unit);
            if (kg < WEIGHT_RANGE_KG.min || kg > WEIGHT_RANGE_KG.max) return { error: 'VALUE_OUT_OF_RANGE' };
            return { intent, params: { value, unit } };
        }
        case 'record_glucose': {
            const value = num(p.value);
            if (!Number.isFinite(value)) return { error: 'INVALID_VALUE' };
            if (p.unit !== 'mg/dL' && p.unit !== 'mmol/L' && p.unit !== 'g/L') return { error: 'UNIT_REQUIRED' };
            const mgdl = glucoseToMgdl(value, p.unit);
            if (mgdl < GLUCOSE_RANGE_MGDL.min || mgdl > GLUCOSE_RANGE_MGDL.max) return { error: 'VALUE_OUT_OF_RANGE' };
            return { intent, params: { value, unit: p.unit } };
        }
    }
}

// ─── Aufgabe zum Erledigen finden ────────────────────────────────────────────

const fold = (s: string) => s.toLocaleLowerCase('de').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Sucht unter den offenen Aufgaben genau eine passende. Erst exakt (ohne
 * Gross-/Kleinschreibung und Satzzeichen), dann "enthaelt". Mehrere Treffer
 * oder keiner: kein Raten, der Aufrufer meldet es zurueck.
 */
export function matchTask<T extends { id: string; title: string }>(tasks: T[], query: string):
    { match: T } | { error: 'TASK_NOT_FOUND' } | { error: 'TASK_AMBIGUOUS'; candidates: T[] } {
    const q = fold(query);
    if (!q) return { error: 'TASK_NOT_FOUND' };
    const exact = tasks.filter((t) => fold(t.title) === q);
    if (exact.length === 1) return { match: exact[0] };
    if (exact.length > 1) return { error: 'TASK_AMBIGUOUS', candidates: exact };
    const contains = tasks.filter((t) => {
        const title = fold(t.title);
        return title.includes(q) || (q.length >= 4 && q.includes(title) && title.length >= 4);
    });
    if (contains.length === 1) return { match: contains[0] };
    if (contains.length > 1) return { error: 'TASK_AMBIGUOUS', candidates: contains };
    return { error: 'TASK_NOT_FOUND' };
}
