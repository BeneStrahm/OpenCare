// E64 (E59, Figma A12 und A14): Mitschrift und Zusammenfassung pruefen und freigeben.
// Die Zusammenfassung wird in Textfeldern bearbeitet, eine Zeile je Punkt, am Tablet und seit
// E67 auch in der App. Unveraenderte Abschnitte bleiben genau so, wie sie waren (auch
// Faelligkeiten, Termin-Daten und die Aufteilung in Befunde und Empfehlungen). Termine und
// unsichere Stellen bearbeitet nur die App (am Tablet bleiben sie unveraendert).
import { answerForQuestion, normalizeSummary, type ConsultationSummary } from './consultationLogic';

export interface SummaryDraft {
    overview: string;
    important: string;
    medications: string;
    nextSteps: string;
    /** Folgetermine, ein Titel je Zeile (nur App) */
    appointments: string;
    /** Unsicher erkannte Stellen (nur App) */
    unclear: string;
    /** Antwort je Frage (Fragen-ID) */
    answers: Record<string, string>;
}

const lines = (text: string): string[] => text.split('\n').map((s) => s.trim()).filter(Boolean);

export function summaryToDraft(summary: ConsultationSummary, questions: ReadonlyArray<{ id: string }>): SummaryDraft {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => { answers[q.id] = answerForQuestion(summary.question_answers ?? [], q.id, i) ?? ''; });
    return {
        overview: summary.overview ?? '',
        important: [...(summary.findings ?? []), ...(summary.recommendations ?? [])].join('\n'),
        medications: (summary.medication_changes ?? []).map((m) => `${m.name}: ${m.change}`).join('\n'),
        nextSteps: (summary.next_steps ?? []).map((s) => s.text).join('\n'),
        appointments: (summary.appointments ?? []).map((a) => a.title).join('\n'),
        unclear: (summary.unclear ?? []).join('\n'),
        answers,
    };
}

/** Zeilen bei den Medikamenten ohne "Name: Änderung" (sonst fielen sie beim Speichern weg). */
export function invalidMedicationLines(text: string): string[] {
    return lines(text).filter((line) => {
        const at = line.indexOf(':');
        return at <= 0 || !line.slice(at + 1).trim();
    });
}

const same = (a: string, b: string) => lines(a).join('\n') === lines(b).join('\n');

export function draftToSummary(
    original: ConsultationSummary,
    initial: SummaryDraft,
    draft: SummaryDraft,
    questions: ReadonlyArray<{ id: string }>
): ConsultationSummary {
    const next: ConsultationSummary = { ...original };
    if (draft.overview.trim() !== initial.overview.trim()) next.overview = draft.overview.trim();
    if (!same(draft.important, initial.important)) {
        next.findings = lines(draft.important);
        next.recommendations = [];
    }
    if (!same(draft.medications, initial.medications)) {
        next.medication_changes = lines(draft.medications).map((line) => {
            const at = line.indexOf(':');
            return { name: line.slice(0, at).trim(), change: line.slice(at + 1).trim() };
        });
    }
    if (!same(draft.nextSteps, initial.nextSteps)) {
        const old = original.next_steps ?? [];
        next.next_steps = lines(draft.nextSteps).map((text) => ({ text, due: old.find((s) => s.text.trim() === text)?.due ?? null }));
    }
    if (!same(draft.appointments, initial.appointments)) {
        // Datum, Uhrzeit und Ort bleiben bei gleichem Titel erhalten, neue Zeilen nur mit Titel.
        const old = original.appointments ?? [];
        next.appointments = lines(draft.appointments).map((title) =>
            old.find((a) => a.title.trim() === title) ?? { title, date: null, time: null, location: null });
    }
    if (!same(draft.unclear, initial.unclear)) next.unclear = lines(draft.unclear);
    next.question_answers = questions.map((q, i) => ({ question_id: q.id, question_index: i, answer: (draft.answers[q.id] ?? '').trim() || null }));
    return normalizeSummary(next, questions.map((q) => q.id));
}
