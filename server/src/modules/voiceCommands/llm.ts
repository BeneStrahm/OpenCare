// Optionaler Rueckgriff auf das lokale Sprachmodell (Ollama), NUR um Datum
// und Uhrzeit aus einer freien Formulierung zu lesen, wenn die Regeln den
// Befehl erkannt haben, das Datum oder die Uhrzeit aber nicht.
//
// - Nur wenn die KI des Kreises eingeschaltet ist UND provider 'ollama' ist.
//   Andere Anbieter (Cloud) werden fuer die Sprachsteuerung nie benutzt.
// - Das Modell bestimmt nie den Befehl, den Titel oder einen Messwert.
// - Die Antwort wird streng geprueft. Was nicht passt, bleibt "fehlend".
// - Fehler des Modells sind nie fatal: dann fragt die App eben nach.

import { aiComplete, getAiSettings } from '../../services/ai';
import { isValidDate, isValidTime, isoDate } from './parser';

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
        });
        const date = typeof raw.date === 'string' && isValidDate(raw.date.trim()) ? raw.date.trim() : null;
        const time = typeof raw.time === 'string' && isValidTime(raw.time.trim()) ? raw.time.trim() : null;
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
