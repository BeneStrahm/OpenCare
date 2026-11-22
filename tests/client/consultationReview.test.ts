import { describe, it, expect } from 'vitest';
import { draftToSummary, invalidMedicationLines, summaryToDraft } from '../../client/src/lib/consultationReview';
import { withDefaults } from '../../client/src/lib/consultationLogic';

// E67: Zusammenfassung in Feldern je Abschnitt (App und Tablet). Fiktive Testdaten.
const questions = [{ id: 'frage-1' }];
const original = withDefaults({
    overview: 'Kontrolltermin.',
    findings: ['Blutdruck 138 zu 82'],
    recommendations: ['Weniger Salz'],
    medication_changes: [{ name: 'Ramipril', change: 'von 5 auf 2,5 mg' }],
    next_steps: [{ text: 'Blutzucker messen', due: '2026-12-01' }],
    appointments: [{ title: 'Kontrolle', date: '2027-02-20', time: '09:30', location: 'Praxis' }],
    unclear: ['Name des Medikaments unsicher'],
    question_answers: [{ question_id: 'frage-1', question_index: 0, answer: 'Ja' }],
}, ['frage-1']);

describe('Zusammenfassung in Abschnittsfeldern', () => {
    it('laesst unveraenderte Abschnitte genau so', () => {
        const initial = summaryToDraft(original, questions);
        const next = draftToSummary(original, initial, { ...initial }, questions);
        expect(next.findings).toEqual(['Blutdruck 138 zu 82']);
        expect(next.recommendations).toEqual(['Weniger Salz']);
        expect(next.next_steps).toEqual([{ text: 'Blutzucker messen', due: '2026-12-01' }]);
        expect(next.appointments).toEqual(original.appointments);
        expect(next.unclear).toEqual(['Name des Medikaments unsicher']);
    });

    it('behaelt Datum und Ort eines Termins mit gleichem Titel, neue Zeilen nur mit Titel', () => {
        const initial = summaryToDraft(original, questions);
        const next = draftToSummary(original, initial, { ...initial, appointments: 'Kontrolle\nAugenarzt' }, questions);
        expect(next.appointments).toEqual([
            { title: 'Kontrolle', date: '2027-02-20', time: '09:30', location: 'Praxis' },
            { title: 'Augenarzt', date: null, time: null, location: null },
        ]);
    });

    it('nimmt geaenderte unsichere Stellen und Antworten zeilenweise', () => {
        const initial = summaryToDraft(original, questions);
        const next = draftToSummary(original, initial, { ...initial, unclear: '', answers: { 'frage-1': 'Ja, neuer Plan' } }, questions);
        expect(next.unclear).toEqual([]);
        expect(next.question_answers[0].answer).toBe('Ja, neuer Plan');
    });

    it('erkennt Medikamente ohne Name: Änderung', () => {
        expect(invalidMedicationLines('Ramipril: 2,5 mg\nMetformin')).toEqual(['Metformin']);
        expect(invalidMedicationLines('Ramipril: 2,5 mg')).toEqual([]);
    });
});
