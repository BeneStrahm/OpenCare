// Optionaler Rueckgriff auf das lokale Sprachmodell (Ollama), NUR um Datum
// und Uhrzeit aus einer freien Formulierung zu lesen, wenn die Regeln den
// Befehl erkannt haben, das Datum oder die Uhrzeit aber nicht.
//
// - Nur wenn die KI des Kreises eingeschaltet ist UND provider 'ollama' ist.
//   Andere Anbieter (Cloud) werden fuer die Sprachsteuerung nie benutzt.
// - Das Modell bestimmt nie den Befehl, den Titel oder einen Messwert.
// - Die Antwort wird streng geprueft. Was nicht passt, bleibt "fehlend".
// - Fehler des Modells sind nie fatal: dann fragt die App eben nach.

import { aiComplete, getAiSettings, DEFAULT_BASE_URLS } from '../../services/ai';
import { isLocalServiceUrl } from '../consultations/localOnly';
import { isValidDate, isValidTime, isoDate } from './parser';

/** Laenger wartet die Sprachsteuerung nicht auf das Modell: danach wird nachgefragt. */
export const LLM_TIMEOUT_MS = 15_000;

const HOUR_WORDS: Record<string, number> = {
    eins: 1, ein: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8,
    neun: 9, zehn: 10, elf: 11, zwölf: 12, zwoelf: 12,
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12,
};

/** Alle im Text genannten Zahlen (Ziffern und Zahlwoerter). */
function spokenNumbers(text: string): number[] {
    const out: number[] = [];
    for (const m of text.matchAll(/\d+/g)) out.push(Number(m[0]));
    for (const w of text.toLowerCase().split(/[^\p{L}]+/u)) if (w in HOUR_WORDS) out.push(HOUR_WORDS[w]);
    return out;
}

/**
 * Eine Uhrzeit des Modells gilt nur, wenn sie im gesprochenen Text belegt ist:
 * Die Stunde (oder bei "halb/viertel vor" die naechste Stunde) muss als Zahl
 * vorkommen, Mitternacht/noon als Wort. Ohne Beleg: nachfragen statt erfinden.
 */
export function timeIsSupported(text: string, time: string): boolean {
    const lower = text.toLowerCase();
    const [h, min] = time.split(':').map(Number);
    if (h === 0 && min === 0 && /mitternacht|midnight/.test(lower)) return true;
    if (h === 12 && min === 0 && /\bnoon\b/.test(lower)) return true;
    const numbers = spokenNumbers(text).filter((n) => n >= 0 && n <= 24);
    const h12 = h % 12;
    return numbers.some((n) => n % 12 === h12 || n % 12 === (h12 + 1) % 12);
}

const DATE_CUE = /\d|heute|morgen|übermorgen|uebermorgen|today|tomorrow|tonight|woche|week|tag|day|monat|month|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend|sonntag|monday|tuesday|wednesday|thursday|friday|saturday|sunday|januar|jänner|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|january|february|march|may|june|july|october|december/i;

/** Ein Datum des Modells gilt nur, wenn im Text ueberhaupt eine Datumsangabe steckt. */
export function dateIsSupported(text: string): boolean {
    return DATE_CUE.test(text);
}

const DATETIME_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['date', 'time'],
    properties: {
        // '' wenn nicht genannt
        date: { type: 'string' },
        time: { type: 'string' },
    },
};

const WEEKDAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

/** Hoechstens so viele Tage in der Zukunft darf ein erkanntes Datum liegen. */
const MAX_DAYS_AHEAD = 400;

export interface LlmDateTime {
    date: string | null;
    time: string | null;
}

export async function extractDateTimeWithLocalModel(
    circleId: string,
    text: string,
    today: Date
): Promise<LlmDateTime | null> {
    const settings = await getAiSettings(circleId);
    if (!settings || settings.provider !== 'ollama') return null;
    // Datenschutz: nur ein Modell im eigenen Netz bekommt den gesprochenen Satz.
    if (!(await isLocalServiceUrl(settings.base_url || DEFAULT_BASE_URLS.ollama))) return null;

    const todayIso = isoDate(today);
    const system = [
        'Du liest aus einem kurzen gesprochenen Satz nur Datum und Uhrzeit heraus.',
        `Heute ist ${WEEKDAY_NAMES[today.getDay()]}, der ${todayIso}.`,
        'Antworte nur mit JSON: {"date": "JJJJ-MM-TT", "time": "HH:MM"} im 24-Stunden-Format.',
        'Wenn kein Datum oder keine Uhrzeit eindeutig genannt ist, gib dafür einen leeren Text zurück.',
        'Rate nicht. Erfinde nichts.',
    ].join('\n');

    try {
        const raw = await aiComplete(settings, {
            system,
            user: text.slice(0, 300),
            jsonSchema: DATETIME_SCHEMA,
            timeoutMs: LLM_TIMEOUT_MS,
        });
        const rawDate = typeof raw.date === 'string' && isValidDate(raw.date.trim()) ? raw.date.trim() : null;
        const rawTime = typeof raw.time === 'string' && isValidTime(raw.time.trim()) ? raw.time.trim() : null;
        // Nichts uebernehmen, was im gesprochenen Satz nicht vorkommt.
        const date = rawDate && dateIsSupported(text) ? rawDate : null;
        const time = rawTime && timeIsSupported(text, rawTime) ? rawTime : null;
        let safeDate = date;
        if (safeDate) {
            const diffDays = (new Date(`${safeDate}T00:00:00`).getTime() - new Date(`${todayIso}T00:00:00`).getTime()) / 86_400_000;
            // Vergangenheit oder sehr weit weg: lieber nachfragen
            if (diffDays < 0 || diffDays > MAX_DAYS_AHEAD) safeDate = null;
        }
        return { date: safeDate, time };
    } catch {
        return null;
    }
}
