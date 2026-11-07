import { describe, it, expect } from 'vitest';
import {
    splitTranscript,
    validateSummary,
    sanitizeEditedSummary,
    buildSummaryPrompt,
    isValidIsoDate,
    toSummaryLang,
} from '../../server/src/modules/consultations/summary';
import {
    buildWhisperPrompt,
    vocabularyForSummary,
    normalizeTerm,
    BASE_VOCABULARY_DE,
} from '../../server/src/modules/consultations/vocabulary';

describe('splitTranscript', () => {
    it('laesst kurze Texte unveraendert', () => {
        expect(splitTranscript('Guten Tag. Wie geht es Ihnen?', 100)).toEqual(['Guten Tag. Wie geht es Ihnen?']);
    });

    it('gibt fuer leeren Text nichts zurueck', () => {
        expect(splitTranscript('   \n ')).toEqual([]);
    });

    it('schneidet an Satzenden und haelt die Grenze ein', () => {
        const sentence = 'Der Blutdruck ist heute gut. ';
        const text = sentence.repeat(50);
        const parts = splitTranscript(text, 100);
        expect(parts.length).toBeGreaterThan(1);
        for (const p of parts) {
            expect(p.length).toBeLessThanOrEqual(100);
            expect(p.endsWith('.')).toBe(true);
        }
    });

    it('verliert keine Woerter', () => {
        const words = Array.from({ length: 500 }, (_, i) => `wort${i}`);
        const parts = splitTranscript(words.join(' '), 120);
        expect(parts.join(' ').split(' ')).toEqual(words);
    });

    it('schneidet sehr lange Woerter notfalls hart', () => {
        const parts = splitTranscript('x'.repeat(250), 100);
        expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
    });
});

describe('isValidIsoDate', () => {
    it('erkennt echte Daten', () => {
        expect(isValidIsoDate('2026-11-07')).toBe(true);
        expect(isValidIsoDate('2028-02-29')).toBe(true);
    });
    it('lehnt ungueltige ab', () => {
        expect(isValidIsoDate('2026-02-30')).toBe(false);
        expect(isValidIsoDate('07.11.2026')).toBe(false);
        expect(isValidIsoDate('')).toBe(false);
    });
});

describe('toSummaryLang', () => {
    it('ordnet Sprachkennungen zu und faellt auf Deutsch zurueck', () => {
        expect(toSummaryLang('de-DE')).toBe('de');
        expect(toSummaryLang('en')).toBe('en');
        expect(toSummaryLang('fr-FR')).toBe('fr');
        expect(toSummaryLang('it')).toBe('de');
        expect(toSummaryLang(undefined)).toBe('de');
    });
});

describe('validateSummary', () => {
    const base = {
        overview: '  Der Blutdruck ist gut eingestellt.  ',
        findings: ['Blutdruck 130/80', 'Blutdruck 130/80', '', 42],
        medication_changes: [{ name: 'Ramipril', change: 'von 5 mg auf 2,5 mg' }, { name: '', change: 'x' }],
        recommendations: ['Viel trinken'],
        next_steps: [
            { text: 'Kontrolle beim Hausarzt', due: '2026-11-21' },
            { text: 'Blutbild', due: 'naechste Woche' },
            { text: '', due: '' },
        ],
        question_answers: [
            { question_index: 0, answer: 'Ja, weiter so.' },
            { question_index: 0, answer: 'Doppelt' },
            { question_index: 5, answer: 'Gibt es nicht' },
            { question_index: 1.5, answer: 'kaputt' },
        ],
        unclear: ['Name des Medikaments am Ende unklar'],
    };

    it('bereinigt und begrenzt die Modellantwort', () => {
        const s = validateSummary(base, 2);
        expect(s.overview).toBe('Der Blutdruck ist gut eingestellt.');
        expect(s.findings).toEqual(['Blutdruck 130/80']);
        expect(s.medication_changes).toEqual([{ name: 'Ramipril', change: 'von 5 mg auf 2,5 mg' }]);
        expect(s.next_steps).toEqual([
            { text: 'Kontrolle beim Hausarzt', due: '2026-11-21' },
            { text: 'Blutbild', due: null },
        ]);
        expect(s.question_answers).toEqual([
            { question_index: 0, answer: 'Ja, weiter so.' },
            { question_index: 1, answer: null },
        ]);
        expect(s.unclear).toEqual(['Name des Medikaments am Ende unklar']);
    });

    it('wirft bei leerer Antwort, damit die Verarbeitung wiederholt wird', () => {
        expect(() => validateSummary({ overview: '', findings: [] }, 0)).toThrow('EMPTY_SUMMARY');
    });

    it('kuerzt ueberlange Texte', () => {
        const s = validateSummary({ overview: 'a'.repeat(5000) }, 0);
        expect(s.overview.length).toBeLessThanOrEqual(2000);
    });

    it('akzeptiert beim Bearbeiten auch leere Inhalte', () => {
        const s = sanitizeEditedSummary({}, 3);
        expect(s.overview).toBe('');
        expect(s.question_answers).toHaveLength(3);
        expect(sanitizeEditedSummary(null, 0).findings).toEqual([]);
    });
});

describe('buildSummaryPrompt', () => {
    it('nummeriert die Fragen ab 0 und gibt Fachwoerter mit', () => {
        const p = buildSummaryPrompt(
            { transcript: 'Text' },
            { lang: 'de', date: '2026-11-07', doctor: 'Dr. Özdemir', specialty: null, reason: null,
              questions: ['Muss die Dosis angepasst werden?', 'Wann ist die naechste Kontrolle?'], vocabulary: ['Ramipril'] }
        );
        expect(p.user).toContain('0. Muss die Dosis angepasst werden?');
        expect(p.user).toContain('1. Wann ist die naechste Kontrolle?');
        expect(p.user).toContain('Ramipril');
        expect(p.user).toContain('Dr. Özdemir');
        expect(p.system).toContain('Erfinde nichts');
    });
});

describe('Fachwoerter', () => {
    it('bereinigt Woerter', () => {
        expect(normalizeTerm('  L-Thyroxin\n 50 ')).toBe('L-Thyroxin 50');
        expect(normalizeTerm(12)).toBe('');
        expect(normalizeTerm('x'.repeat(200))).toHaveLength(80);
    });

    it('stellt eigene Woerter vor automatische und die Grundliste', () => {
        const prompt = buildWhisperPrompt({ custom: ['Eliquis'], automatic: ['Ramipril', 'eliquis'] }, 'de');
        expect(prompt.startsWith('Arztgespräch. Fachbegriffe: Eliquis, Ramipril, ')).toBe(true);
        expect(prompt.match(/eliquis/gi)).toHaveLength(1);
        expect(prompt.endsWith('.')).toBe(true);
    });

    it('haelt die Laengengrenze ein und schneidet nie mitten im Wort', () => {
        const prompt = buildWhisperPrompt({ custom: [], automatic: [] }, 'de', 200);
        expect(prompt.length).toBeLessThanOrEqual(200);
        const terms = prompt.replace(/^Arztgespräch\. Fachbegriffe: /, '').replace(/\.$/, '').split(', ');
        for (const t of terms) expect(BASE_VOCABULARY_DE).toContain(t);
    });

    it('nutzt die deutsche Grundliste nur auf Deutsch', () => {
        expect(buildWhisperPrompt({ custom: [], automatic: [] }, 'en')).toBe('');
        expect(buildWhisperPrompt({ custom: ['Apixaban'], automatic: [] }, 'en')).toBe('Doctor visit. Terms: Apixaban.');
    });

    it('gibt der Zusammenfassung nur Kreis-Woerter ohne Doppel', () => {
        expect(vocabularyForSummary({ custom: ['A', 'b'], automatic: ['B', 'c'] })).toEqual(['A', 'b', 'c']);
    });
});
