import { describe, it, expect } from 'vitest';
import {
    missingChunks,
    isRecordingInProgress,
    recordingBadgeVariant,
    summaryBadgeVariant,
    errorCodeKey,
    emptySummary,
    isSummaryEmpty,
    normalizeSummary,
    isIsoDate,
    moveItem,
    toNaiveLocal,
    toDateTimeInput,
    fromDateTimeInput,
    formatDuration,
    cleanVocabularyTerm,
    pickMimeType,
    backoffDelay,
    type ConsultationSummary,
} from '../../client/src/lib/consultationLogic';

describe('missingChunks', () => {
    it('liefert alle Indizes, wenn der Server nichts hat', () => {
        expect(missingChunks(3, [])).toEqual([0, 1, 2]);
    });
    it('liefert nur die Luecken, aufsteigend', () => {
        expect(missingChunks(5, [4, 0, 2])).toEqual([1, 3]);
    });
    it('ignoriert Indizes ausserhalb und Unsinn', () => {
        expect(missingChunks(2, [0, 1, 7, -1, 1.5 as number])).toEqual([]);
    });
    it('liefert nichts bei 0 oder ungueltiger Gesamtzahl', () => {
        expect(missingChunks(0, [])).toEqual([]);
        expect(missingChunks(Number.NaN, [])).toEqual([]);
    });
});

describe('Status', () => {
    it('erkennt laufende Verarbeitung', () => {
        expect(isRecordingInProgress('queued')).toBe(true);
        expect(isRecordingInProgress('summarizing')).toBe(true);
        expect(isRecordingInProgress('done')).toBe(false);
        expect(isRecordingInProgress('failed')).toBe(false);
    });
    it('waehlt passende Farben', () => {
        expect(recordingBadgeVariant('done')).toBe('success');
        expect(recordingBadgeVariant('failed')).toBe('danger');
        expect(summaryBadgeVariant('draft')).toBe('warning');
        expect(summaryBadgeVariant('approved')).toBe('success');
        expect(summaryBadgeVariant('none')).toBe('secondary');
    });
    it('ordnet Fehlercodes Texten zu, Unbekanntes faellt auf INTERNAL', () => {
        expect(errorCodeKey('LOCAL_AI_REQUIRED')).toBe('consultations:errors.LOCAL_AI_REQUIRED');
        expect(errorCodeKey('SOMETHING_NEW')).toBe('consultations:errors.INTERNAL');
        expect(errorCodeKey(null)).toBeNull();
    });
});

describe('Zusammenfassung', () => {
    const filled: ConsultationSummary = {
        overview: '  Blutdruck gut eingestellt.  ',
        findings: ['', ' Leichte Anämie '],
        medication_changes: [{ name: 'Ramipril', change: '5 mg statt 2,5 mg' }, { name: '', change: 'x' }],
        recommendations: [],
        next_steps: [{ text: 'Blutbild', due: '2026-12-01' }, { text: 'Kontrolle', due: '2026-02-31' }, { text: ' ', due: null }],
        question_answers: [{ question_index: 1, answer: ' Ja ' }, { question_index: 5, answer: 'zu viel' }],
        unclear: ['Name des Medikaments unklar'],
    };

    it('leere Vorlage hat eine Antwort je Frage', () => {
        const s = emptySummary(2);
        expect(s.question_answers).toEqual([
            { question_index: 0, answer: null },
            { question_index: 1, answer: null },
        ]);
        expect(isSummaryEmpty(s)).toBe(true);
        expect(isSummaryEmpty(null)).toBe(true);
    });

    it('erkennt Inhalt, auch wenn nur eine Antwort da ist', () => {
        const s = emptySummary(1);
        s.question_answers[0].answer = 'Ja';
        expect(isSummaryEmpty(s)).toBe(false);
    });

    it('bereinigt vor dem Speichern', () => {
        const n = normalizeSummary(filled, 2);
        expect(n.overview).toBe('Blutdruck gut eingestellt.');
        expect(n.findings).toEqual(['Leichte Anämie']);
        expect(n.medication_changes).toEqual([{ name: 'Ramipril', change: '5 mg statt 2,5 mg' }]);
        expect(n.next_steps).toEqual([
            { text: 'Blutbild', due: '2026-12-01' },
            { text: 'Kontrolle', due: null },
        ]);
        expect(n.question_answers).toEqual([
            { question_index: 0, answer: null },
            { question_index: 1, answer: 'Ja' },
        ]);
        expect(n.unclear).toEqual(['Name des Medikaments unklar']);
    });
});

describe('Datum und Zeit', () => {
    it('prueft echte Kalenderdaten', () => {
        expect(isIsoDate('2026-02-28')).toBe(true);
        expect(isIsoDate('2026-02-29')).toBe(false);
        expect(isIsoDate('2028-02-29')).toBe(true);
        expect(isIsoDate('26-1-1')).toBe(false);
        expect(isIsoDate(null)).toBe(false);
    });
    it('schreibt naive lokale Zeitstempel', () => {
        expect(toNaiveLocal(new Date(2026, 10, 7, 9, 5, 3))).toBe('2026-11-07T09:05:03');
    });
    it('wandelt fuer datetime-local hin und zurueck', () => {
        expect(toDateTimeInput('2026-11-07T09:30:00')).toBe('2026-11-07T09:30');
        expect(toDateTimeInput(null)).toBe('');
        expect(fromDateTimeInput('2026-11-07T09:30')).toBe('2026-11-07T09:30:00');
        expect(fromDateTimeInput('')).toBeNull();
    });
    it('formatiert die Laufzeit', () => {
        expect(formatDuration(0)).toBe('00:00');
        expect(formatDuration(65)).toBe('01:05');
        expect(formatDuration(3725)).toBe('1:02:05');
    });
});

describe('Hilfsfunktionen', () => {
    it('verschiebt Fragen um eine Stelle', () => {
        expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
        expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
        expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
        expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
    });
    it('prueft Fachwoerter', () => {
        expect(cleanVocabularyTerm('  L-Thyroxin  ')).toBe('L-Thyroxin');
        expect(cleanVocabularyTerm('   ')).toBeNull();
        expect(cleanVocabularyTerm('x'.repeat(81))).toBeNull();
        expect(cleanVocabularyTerm('x'.repeat(80))).toBe('x'.repeat(80));
    });
    it('waehlt den ersten unterstuetzten MIME-Typ', () => {
        expect(pickMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4');
        expect(pickMimeType(() => true)).toBe('audio/webm;codecs=opus');
        expect(pickMimeType(() => false)).toBe('');
    });
    it('wartet nach Serverfehlern immer laenger, hoechstens 15 Minuten', () => {
        expect(backoffDelay(0)).toBe(60_000);
        expect(backoffDelay(1)).toBe(120_000);
        expect(backoffDelay(3)).toBe(480_000);
        expect(backoffDelay(10)).toBe(15 * 60_000);
    });
});

import {
    appliedKey,
    taskKey,
    eventKey,
    noteKey,
    isApplied,
    canSelectAppointment,
    canSelectTask,
    canSelectNote,
    buildApplyPayload,
    payloadSize,
    applyErrorKey,
    withDefaults,
    isValidTime,
    normalizeProposalText,
    toAppointmentDraft,
} from '../../client/src/lib/consultationLogic';

describe('Vorschlaege: Schluessel wie auf dem Server', () => {
    it('normalisiert Leerraum und Gross/Klein', () => {
        expect(normalizeProposalText('  Kontrolle   beim\nHausarzt ')).toBe('kontrolle beim hausarzt');
        expect(appliedKey('task', 'Rezept  ABHOLEN')).toBe('task:rezept abholen');
    });

    it('baut Termin-Schluessel mit Datum und Uhrzeit, sonst null', () => {
        expect(eventKey('Kontrolle Kardiologie', '2026-11-24', '09:30')).toBe('event:kontrolle kardiologie 2026-11-24t09:30:00');
        expect(eventKey('Kontrolle', null, '09:30')).toBeNull();
        expect(eventKey('Kontrolle', '2026-11-24', '')).toBeNull();
    });

    it('kuerzt wie der Server', () => {
        expect(taskKey('x'.repeat(300))).toBe(`task:${'x'.repeat(255)}`);
        expect(noteKey(` ${'a'.repeat(600)} `)).toBe(`note:${'a'.repeat(500)}`);
    });

    it('erkennt uebernommene Vorschlaege, auch nach Bearbeitung des Texts', () => {
        const applied = { 'task:rezept abholen': 'id1' };
        expect(isApplied(applied, taskKey('Rezept abholen'))).toBe(true);
        expect(isApplied(applied, taskKey('Rezept abholen beim Hausarzt'))).toBe(false);
        expect(isApplied(applied, null)).toBe(false);
        expect(isApplied(null, 'task:x')).toBe(false);
    });
});

describe('Vorschlaege: Auswahl und Body', () => {
    it('erlaubt Termine nur mit Titel, Datum und Uhrzeit', () => {
        expect(canSelectAppointment({ title: 'Kontrolle', date: '2026-11-24', time: '09:30', location: '' })).toBe(true);
        expect(canSelectAppointment({ title: 'Kontrolle', date: '', time: '09:30', location: '' })).toBe(false);
        expect(canSelectAppointment({ title: 'Kontrolle', date: '2026-11-24', time: '', location: '' })).toBe(false);
        expect(canSelectAppointment({ title: ' ', date: '2026-11-24', time: '09:30', location: '' })).toBe(false);
        expect(canSelectAppointment({ title: 'K', date: '2026-02-30', time: '09:30', location: '' })).toBe(false);
    });

    it('prueft Aufgaben und Notizen', () => {
        expect(canSelectTask({ text: 'Blutbild', due: '' })).toBe(true);
        expect(canSelectTask({ text: 'Blutbild', due: 'morgen' })).toBe(false);
        expect(canSelectTask({ text: '', due: '' })).toBe(false);
        expect(canSelectNote({ content: 'Ramipril jetzt 2,5 mg' })).toBe(true);
        expect(canSelectNote({ content: 'x'.repeat(501) })).toBe(false);
    });

    it('nimmt nur ausgewaehlte und gueltige Vorschlaege in den Body', () => {
        const p = buildApplyPayload(
            [{ draft: { text: ' Blutbild ', due: '' }, selected: true }, { draft: { text: 'Nein', due: '' }, selected: false }],
            [
                { draft: { title: 'Kontrolle', date: '2026-11-24', time: '09:30', location: ' ' }, selected: true },
                { draft: { title: 'Ohne Zeit', date: '2026-11-24', time: '', location: '' }, selected: true },
            ],
            [{ draft: { content: 'Notiz' }, selected: true }]
        );
        expect(p).toEqual({
            tasks: [{ text: 'Blutbild', due: null }],
            appointments: [{ title: 'Kontrolle', date: '2026-11-24', time: '09:30', location: null }],
            notes: [{ content: 'Notiz' }],
        });
        expect(payloadSize(p)).toBe(3);
    });

    it('legt keine Werte an, die nicht im Vorschlag stehen', () => {
        expect(toAppointmentDraft({ title: 'Kontrolle', date: null, time: null, location: null }))
            .toEqual({ title: 'Kontrolle', date: '', time: '', location: '' });
    });
});

describe('Vorschlaege: Sonstiges', () => {
    it('ordnet Fehlercodes zu', () => {
        expect(applyErrorKey('APPOINTMENT_DATE_TIME_REQUIRED')).toBe('consultations:proposals.errors.APPOINTMENT_DATE_TIME_REQUIRED');
        expect(applyErrorKey('HTTP 500')).toBe('consultations:proposals.errors.generic');
        expect(applyErrorKey(undefined)).toBe('consultations:proposals.errors.generic');
    });

    it('ergaenzt aeltere Entwuerfe ohne neue Felder', () => {
        const s = withDefaults({ overview: 'x', findings: ['a'] } as never, 2);
        expect(s.appointments).toEqual([]);
        expect(s.family_notes).toEqual([]);
        expect(s.question_answers).toHaveLength(2);
        expect(withDefaults(null, 0).overview).toBe('');
    });

    it('prueft Uhrzeiten', () => {
        expect(isValidTime('09:30')).toBe(true);
        expect(isValidTime('23:59')).toBe(true);
        expect(isValidTime('24:00')).toBe(false);
        expect(isValidTime('9:30')).toBe(false);
        expect(isValidTime(null)).toBe(false);
    });
});
