// Arztgespraech-Modul: Prompts, Zerlegung langer Mitschriften und strenge
// Pruefung der Modellantwort. Reine Logik ohne Datenbank, damit sie getestet
// werden kann.
//
// Grundsaetze:
//  - Das Modell fasst NUR zusammen, was in der Mitschrift steht. Es erfindet
//    nichts, gibt keine eigenen medizinischen Ratschlaege und markiert
//    Unklares ausdruecklich.
//  - Die Antwort des Modells wird nie ungeprueft uebernommen: Laengen, Anzahl
//    und Formate werden hier begrenzt.
//  - Das Ergebnis ist immer ein Entwurf, den ein Mensch prueft und freigibt.

export type SummaryLang = 'de' | 'en' | 'fr' | 'es';

export const SUMMARY_LANGS: readonly SummaryLang[] = ['de', 'en', 'fr', 'es'];

export function toSummaryLang(value: unknown): SummaryLang {
    const tag = typeof value === 'string' ? value.trim().toLowerCase() : '';
    const found = SUMMARY_LANGS.find((l) => tag === l || tag.startsWith(`${l}-`));
    return found ?? 'de';
}

const LANG_NAMES: Record<SummaryLang, string> = {
    de: 'Deutsch',
    en: 'English',
    fr: 'Français',
    es: 'Español',
};

/** Ab dieser Laenge wird die Mitschrift in Abschnitten vorverdichtet. */
export const DIRECT_SUMMARY_MAX_CHARS = 12_000;
/** Groesse eines Abschnitts fuer die Vorverdichtung. */
export const SEGMENT_MAX_CHARS = 6_000;

const MAX_ITEMS = 20;
const MAX_ITEM_CHARS = 500;
const MAX_OVERVIEW_CHARS = 2_000;
const MAX_NOTES = 40;

export interface MedicationChange {
    name: string;
    change: string;
}

export interface NextStep {
    text: string;
    /** YYYY-MM-DD, nur wenn im Gespraech ausdruecklich ein Datum genannt wurde. */
    due: string | null;
}

export interface QuestionAnswer {
    /** Index der vorbereiteten Frage (0-basiert, Reihenfolge wie im Prompt). */
    question_index: number;
    /** null, wenn die Frage im Gespraech nicht beantwortet wurde. */
    answer: string | null;
}

export interface ConsultationSummary {
    overview: string;
    findings: string[];
    medication_changes: MedicationChange[];
    recommendations: string[];
    next_steps: NextStep[];
    question_answers: QuestionAnswer[];
    unclear: string[];
}

// ─── JSON-Schemata (gleiche Regeln wie services/ai/assistant.ts) ─────────────

export const SEGMENT_NOTES_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['notes'],
    properties: {
        notes: { type: 'array', items: { type: 'string' } },
    },
};

export const SUMMARY_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: [
        'overview', 'findings', 'medication_changes', 'recommendations',
        'next_steps', 'question_answers', 'unclear',
    ],
    properties: {
        overview: { type: 'string' },
        findings: { type: 'array', items: { type: 'string' } },
        medication_changes: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'change'],
                properties: {
                    name: { type: 'string' },
                    change: { type: 'string' },
                },
            },
        },
        recommendations: { type: 'array', items: { type: 'string' } },
        next_steps: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['text', 'due'],
                properties: {
                    text: { type: 'string' },
                    // '' wenn kein Datum genannt wurde
                    due: { type: 'string' },
                },
            },
        },
        question_answers: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['question_index', 'answer'],
                properties: {
                    question_index: { type: 'integer' },
                    // '' wenn die Frage nicht beantwortet wurde
                    answer: { type: 'string' },
                },
            },
        },
        unclear: { type: 'array', items: { type: 'string' } },
    },
};

// ─── Zerlegung ───────────────────────────────────────────────────────────────

/**
 * Teilt einen langen Text in Abschnitte von hoechstens maxChars Zeichen.
 * Geschnitten wird bevorzugt an Satzenden, sonst an Leerzeichen, nur im
 * Notfall mitten im Wort. Es geht kein Zeichen verloren ausser Leerraum an
 * den Schnittstellen.
 */
export function splitTranscript(text: string, maxChars = SEGMENT_MAX_CHARS): string[] {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    if (maxChars < 1) throw new Error('maxChars must be positive');
    const segments: string[] = [];
    let rest = clean;
    while (rest.length > maxChars) {
        const window = rest.slice(0, maxChars + 1);
        let cut = -1;
        const sentenceEnd = /[.!?…](\s)/g;
        let m: RegExpExecArray | null;
        while ((m = sentenceEnd.exec(window)) !== null) {
            if (m.index + 1 <= maxChars) cut = m.index + 1;
        }
        if (cut < maxChars * 0.5) {
            const space = window.lastIndexOf(' ', maxChars);
            if (space > 0) cut = Math.max(cut, space);
        }
        if (cut <= 0) cut = maxChars;
        segments.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) segments.push(rest);
    return segments;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const RULES = [
    'Du arbeitest mit der Mitschrift eines Arztgesprächs. Die Mitschrift stammt aus einer automatischen Spracherkennung und kann Fehler enthalten.',
    'Gib nur wieder, was im Text tatsächlich gesagt wurde. Erfinde nichts und ergänze nichts aus eigenem Wissen.',
    'Gib keine eigenen medizinischen Ratschläge, Bewertungen oder Diagnosen.',
    'Medikamentennamen, Dosierungen, Zahlen und Termine übernimmst du genau so, wie sie im Text stehen.',
    'Wenn etwas unklar, widersprüchlich oder vermutlich falsch erkannt ist, schreibst du es in die Liste "unclear" statt zu raten.',
    'Antworte ausschließlich mit JSON nach dem vorgegebenen Schema.',
];

export interface SummaryContext {
    lang: SummaryLang;
    /** Datum des Gespraechs, YYYY-MM-DD, damit relative Angaben ("in zwei Wochen") eingeordnet werden. */
    date: string | null;
    doctor: string | null;
    specialty: string | null;
    reason: string | null;
    questions: string[];
    /** Richtig geschriebene Fachwoerter des Kreises (Medikamente, Aerzte, eigene Woerter). */
    vocabulary?: string[];
}

export function buildSegmentPrompt(segment: string, index: number, total: number, lang: SummaryLang) {
    const system = [
        ...RULES,
        `Schreibe auf ${LANG_NAMES[lang]}.`,
        'Fasse diesen Abschnitt in kurzen Stichpunkten zusammen. Behalte alle Befunde, Medikamente, Dosierungen, Empfehlungen, Termine, Fragen und Antworten.',
    ].join('\n');
    const user = `Abschnitt ${index + 1} von ${total}:\n"""\n${segment}\n"""`;
    return { system, user, jsonSchema: SEGMENT_NOTES_SCHEMA };
}

export function buildSummaryPrompt(material: { transcript?: string; notes?: string[] }, ctx: SummaryContext) {
    const system = [
        ...RULES,
        `Schreibe auf ${LANG_NAMES[ctx.lang]}, in einfachen, kurzen Sätzen, die auch ältere Menschen gut verstehen.`,
        'Felder:',
        '- overview: Kurzfassung in 2 bis 5 Sätzen.',
        '- findings: genannte Befunde und Diagnosen.',
        '- medication_changes: jede genannte Änderung an Medikamenten (neu, abgesetzt, Dosis geändert), mit Name und Änderung.',
        '- recommendations: Empfehlungen und Hinweise des Arztes.',
        '- next_steps: konkrete nächste Schritte. "due" nur als Datum JJJJ-MM-TT, wenn ein Datum oder eine eindeutige Frist genannt wurde, sonst leerer Text.',
        '- question_answers: für jede vorbereitete Frage ein Eintrag mit ihrer Nummer (question_index, beginnend bei 0) und der Antwort aus dem Gespräch. Wurde sie nicht beantwortet, ist answer ein leerer Text.',
        '- unclear: Stellen, die unklar oder vermutlich falsch erkannt sind.',
        'Leere Listen sind erlaubt. Lieber weniger und richtig als mehr und geraten.',
    ].join('\n');

    const lines: string[] = [];
    if (ctx.date) lines.push(`Datum des Gesprächs: ${ctx.date}`);
    if (ctx.doctor) lines.push(`Arzt oder Ärztin: ${ctx.doctor}`);
    if (ctx.specialty) lines.push(`Fachrichtung: ${ctx.specialty}`);
    if (ctx.reason) lines.push(`Anlass: ${ctx.reason}`);
    if (ctx.questions.length > 0) {
        lines.push('Vorbereitete Fragen:');
        ctx.questions.forEach((q, i) => lines.push(`${i}. ${q}`));
    } else {
        lines.push('Vorbereitete Fragen: keine');
    }
    if (ctx.vocabulary && ctx.vocabulary.length > 0) {
        lines.push(
            'Bekannte Fachwörter in richtiger Schreibweise (nur verwenden, wenn im Text eindeutig dasselbe Wort gemeint ist, sonst unter "unclear" nennen):',
            ctx.vocabulary.join(', ')
        );
    }
    if (material.notes) {
        lines.push('', 'Stichpunkte aus der Mitschrift, in Reihenfolge:', ...material.notes.map((n) => `- ${n}`));
    } else {
        lines.push('', 'Mitschrift:', '"""', material.transcript ?? '', '"""');
    }
    return { system, user: lines.join('\n'), jsonSchema: SUMMARY_SCHEMA };
}

// ─── Pruefung der Modellantwort ──────────────────────────────────────────────

const cleanText = (value: unknown, max = MAX_ITEM_CHARS): string => {
    if (typeof value !== 'string') return '';
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

const cleanList = (value: unknown, maxItems = MAX_ITEMS): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        const text = cleanText(item);
        if (text && !out.includes(text)) out.push(text);
        if (out.length >= maxItems) break;
    }
    return out;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
    if (!DATE_RE.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function validateSegmentNotes(raw: Record<string, unknown>): string[] {
    return cleanList(raw.notes, MAX_NOTES);
}

/**
 * Prueft und begrenzt die Zusammenfassung. Wirft einen Fehler, wenn gar nichts
 * Brauchbares zurueckkam, damit die Verarbeitung als fehlgeschlagen gilt und
 * wiederholt werden kann.
 */
export function validateSummary(raw: Record<string, unknown>, questionCount: number): ConsultationSummary {
    const overview = cleanText(raw.overview, MAX_OVERVIEW_CHARS);

    const medication_changes: MedicationChange[] = [];
    if (Array.isArray(raw.medication_changes)) {
        for (const item of raw.medication_changes) {
            if (!item || typeof item !== 'object') continue;
            const name = cleanText((item as Record<string, unknown>).name, 120);
            const change = cleanText((item as Record<string, unknown>).change);
            if (name && change) medication_changes.push({ name, change });
            if (medication_changes.length >= MAX_ITEMS) break;
        }
    }

    const next_steps: NextStep[] = [];
    if (Array.isArray(raw.next_steps)) {
        for (const item of raw.next_steps) {
            if (!item || typeof item !== 'object') continue;
            const text = cleanText((item as Record<string, unknown>).text);
            const dueRaw = cleanText((item as Record<string, unknown>).due, 10);
            if (!text) continue;
            next_steps.push({ text, due: isValidIsoDate(dueRaw) ? dueRaw : null });
            if (next_steps.length >= MAX_ITEMS) break;
        }
    }

    // Eine Antwort je vorbereiteter Frage, in der Reihenfolge der Fragen.
    const answers = new Map<number, string>();
    if (Array.isArray(raw.question_answers)) {
        for (const item of raw.question_answers) {
            if (!item || typeof item !== 'object') continue;
            const index = (item as Record<string, unknown>).question_index;
            if (typeof index !== 'number' || !Number.isInteger(index)) continue;
            if (index < 0 || index >= questionCount || answers.has(index)) continue;
            const answer = cleanText((item as Record<string, unknown>).answer);
            if (answer) answers.set(index, answer);
        }
    }
    const question_answers: QuestionAnswer[] = Array.from({ length: questionCount }, (_, i) => ({
        question_index: i,
        answer: answers.get(i) ?? null,
    }));

    const summary: ConsultationSummary = {
        overview,
        findings: cleanList(raw.findings),
        medication_changes,
        recommendations: cleanList(raw.recommendations),
        next_steps,
        question_answers,
        unclear: cleanList(raw.unclear),
    };

    const empty = !summary.overview
        && summary.findings.length === 0
        && summary.medication_changes.length === 0
        && summary.recommendations.length === 0
        && summary.next_steps.length === 0
        && answers.size === 0;
    if (empty) {
        throw new Error('EMPTY_SUMMARY');
    }
    return summary;
}

/**
 * Prueft eine vom Menschen bearbeitete Zusammenfassung (gleiche Grenzen wie
 * beim Modell). Leere Inhalte sind hier erlaubt.
 */
export function sanitizeEditedSummary(raw: unknown, questionCount: number): ConsultationSummary {
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    try {
        return validateSummary(obj, questionCount);
    } catch {
        return {
            overview: '',
            findings: [],
            medication_changes: [],
            recommendations: [],
            next_steps: [],
            question_answers: Array.from({ length: questionCount }, (_, i) => ({ question_index: i, answer: null })),
            unclear: [],
        };
    }
}
