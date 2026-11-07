// Fachwoerter fuer die Spracherkennung.
//
// Whisper nimmt einen kurzen Text ("prompt") als Kontext an. Stehen dort die
// richtig geschriebenen Fachwoerter, erkennt es sie deutlich zuverlaessiger.
// Der Kontext ist auf etwa 224 Tokens begrenzt, deshalb gilt eine feste
// Reihenfolge: eigene Woerter des Kreises, dann Medikamente, Aerzte und
// Fachrichtungen aus dem Kreis, zuletzt die allgemeine Grundliste.

import { query } from '../../db';

/** Haeufige deutsche Begriffe aus Arztgespraechen in der Altenpflege. */
export const BASE_VOCABULARY_DE: readonly string[] = [
    'Blutdruck', 'Bluthochdruck', 'Hypertonie', 'Blutzucker', 'Diabetes mellitus', 'HbA1c', 'Insulin',
    'Unterzuckerung', 'Herzinsuffizienz', 'Vorhofflimmern', 'EKG', 'Langzeit-EKG', 'Echokardiographie',
    'Ultraschall', 'Sonographie', 'Röntgen', 'MRT', 'CT', 'Blutbild', 'Hämoglobin', 'Kreatinin', 'eGFR',
    'Niereninsuffizienz', 'Kalium', 'Natrium', 'TSH', 'Schilddrüse', 'Cholesterin', 'Thrombose',
    'Blutverdünner', 'Antikoagulation', 'Ödeme', 'Wassertabletten', 'Diuretikum', 'Demenz', 'Alzheimer',
    'Parkinson', 'Schlaganfall', 'Arthrose', 'Osteoporose', 'COPD', 'Inhalator', 'Dekubitus',
    'Inkontinenz', 'Harnwegsinfekt', 'Antibiotikum', 'Schmerzmittel', 'Überweisung', 'Rezept',
    'Folgerezept', 'Dosierung', 'Tagesdosis', 'nüchtern', 'Kontrolltermin', 'Pflegegrad',
    'Physiotherapie', 'Ergotherapie', 'Logopädie', 'Krankenhauseinweisung', 'Facharzt', 'Hausarzt',
];

/** Obergrenze fuer den Whisper-Kontext in Zeichen (grob 224 Tokens). */
export const WHISPER_PROMPT_MAX_CHARS = 600;
export const MAX_TERM_LENGTH = 80;

export function normalizeTerm(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM_LENGTH);
}

const INTRO: Record<string, string> = {
    de: 'Arztgespräch. Fachbegriffe: ',
    en: 'Doctor visit. Terms: ',
    fr: 'Consultation médicale. Termes : ',
    es: 'Consulta médica. Términos: ',
};

/**
 * Baut den Whisper-Kontext. Doppelte Woerter (ohne Gross/Klein) fallen weg,
 * es wird nie mitten in einem Wort abgeschnitten.
 */
export function buildWhisperPrompt(
    groups: { custom: string[]; automatic: string[] },
    lang: string,
    maxChars = WHISPER_PROMPT_MAX_CHARS,
    introOverride?: string
): string {
    const intro = introOverride ?? INTRO[lang] ?? INTRO.de;
    const ordered = [
        ...groups.custom,
        ...groups.automatic,
        ...(lang === 'de' ? BASE_VOCABULARY_DE : []),
    ];
    const seen = new Set<string>();
    const picked: string[] = [];
    let length = intro.length + 1; // abschliessender Punkt
    for (const raw of ordered) {
        const term = normalizeTerm(raw);
        const key = term.toLocaleLowerCase();
        if (!term || seen.has(key)) continue;
        const add = (picked.length ? 2 : 0) + term.length;
        if (length + add > maxChars) continue;
        seen.add(key);
        picked.push(term);
        length += add;
    }
    if (picked.length === 0) return '';
    return `${intro}${picked.join(', ')}.`;
}

/** Woerter fuer die Zusammenfassung: alle eigenen und automatischen, ohne Grundliste. */
export function vocabularyForSummary(groups: { custom: string[]; automatic: string[] }, max = 80): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of [...groups.custom, ...groups.automatic]) {
        const term = normalizeTerm(raw);
        const key = term.toLocaleLowerCase();
        if (!term || seen.has(key)) continue;
        seen.add(key);
        out.push(term);
        if (out.length >= max) break;
    }
    return out;
}

export interface VocabularyRow {
    id: string;
    term: string;
    created_at: string;
}

/** Eigene Woerter und automatisch gesammelte Woerter eines Kreises. */
export async function loadVocabulary(circleId: string): Promise<{ custom: VocabularyRow[]; automatic: string[] }> {
    const custom = await query(
        `SELECT id, term, created_at FROM consultation_vocabulary
         WHERE circle_id = $1 ORDER BY lower(term)`,
        [circleId]
    );
    const meds = await query(
        `SELECT DISTINCT name FROM medications WHERE circle_id = $1 AND name IS NOT NULL ORDER BY name`,
        [circleId]
    );
    const doctors = await query(
        `SELECT DISTINCT v FROM (
            SELECT doctor_name AS v FROM consultations WHERE circle_id = $1
            UNION SELECT specialty AS v FROM consultations WHERE circle_id = $1
            UNION SELECT prescriber AS v FROM medications WHERE circle_id = $1
         ) t WHERE v IS NOT NULL ORDER BY v`,
        [circleId]
    );
    const automatic = [
        ...meds.rows.map((r: { name: string }) => r.name),
        ...doctors.rows.map((r: { v: string }) => r.v),
    ].map(normalizeTerm).filter(Boolean);
    return { custom: custom.rows as VocabularyRow[], automatic: [...new Set(automatic)] };
}

const DICTATION_INTRO: Record<string, string> = {
    de: 'Fachbegriffe: ',
    en: 'Terms: ',
    fr: 'Termes : ',
    es: 'Términos: ',
};

/**
 * Whisper-Kontext fuer kurze Diktate (Sprachtagebuch, Sprachsteuerung).
 * Fehler beim Laden duerfen das Diktat nie verhindern: dann ohne Kontext.
 */
export async function dictationPromptFor(circleId: string, lang: string): Promise<string> {
    try {
        const v = await loadVocabulary(circleId);
        return buildWhisperPrompt(
            { custom: v.custom.map((t) => t.term), automatic: v.automatic },
            lang,
            WHISPER_PROMPT_MAX_CHARS,
            DICTATION_INTRO[lang] ?? DICTATION_INTRO.de
        );
    } catch {
        return '';
    }
}
