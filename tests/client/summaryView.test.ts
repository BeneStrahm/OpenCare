import { describe, it, expect, vi } from 'vitest';

// Ohne Browser: Sprache und Speicher der App ersetzen.
vi.mock('../../client/src/i18n', () => ({ default: { t: (_k: string, o: { time?: string }) => `${o?.time} Uhr` } }));
vi.mock('../../client/src/i18n/format', () => ({ intlLocale: () => 'de-DE', formatClock: () => '' }));
vi.mock('../../client/src/lib/api', () => ({ api: {} }));
vi.mock('../../client/src/lib/consultationStore', () => ({ localAudio: async () => null }));
import { summaryView, answerFor } from '../../client/src/lib/consultationView';
import { emptySummary } from '../../client/src/lib/consultationLogic';

/** B3 und B5: Zusammenfassung zum Lesen, gleich am Tablet und in der App. */
describe('summaryView', () => {
    const base = () => ({ ...emptySummary(['f1']) });

    it('Kurzfassung als eigener Absatz, gleiche Punkte nur einmal', () => {
        const v = summaryView({
            ...base(),
            overview: 'Ramipril wird reduziert.',
            findings: ['HbA1c liegt bei 7,2', 'HbA1c liegt bei 7,2.'],
            recommendations: ['Nach 18 Uhr weniger trinken'],
        });
        expect(v.overview).toBe('Ramipril wird reduziert.');
        expect(v.groups).toEqual([{ key: 'important', items: ['HbA1c liegt bei 7,2', 'Nach 18 Uhr weniger trinken'] }]);
    });

    it('naechste Schritte und Termine mit Tag, ohne "00:00 Uhr"', () => {
        const v = summaryView({
            ...base(),
            next_steps: [{ text: 'Nuechtern zur Kontrolle', due: null }],
            appointments: [{ title: 'Kontrolle', date: '2026-12-01', time: null, location: null }],
        });
        expect(v.groups.map((g) => g.key)).toEqual(['nextSteps', 'appointments']);
        expect(v.groups[0].items).toEqual(['Nuechtern zur Kontrolle']);
        expect(v.groups[1].items[0]).toMatch(/^Kontrolle, .*1\..*/);
        expect(v.groups[1].items[0]).not.toContain('00:00');
    });

    it('unsichere Stellen nur, wenn verlangt (App)', () => {
        const s = { ...base(), unclear: ['162 oder 108 zu 62?'] };
        expect(summaryView(s).groups).toEqual([]);
        expect(summaryView(s, { withUnclear: true }).groups).toEqual([{ key: 'unclear', items: ['162 oder 108 zu 62?'] }]);
    });

    it('ohne Zusammenfassung leer', () => {
        expect(summaryView(null)).toEqual({ overview: null, groups: [] });
    });
});

describe('answerFor', () => {
    it('freigegebene Antwort vor dem Entwurf, sonst Entwurf nach ID', () => {
        const s = { ...emptySummary(['f1']), question_answers: [{ question_id: 'f1', question_index: 0, answer: 'Ja' }] };
        expect(answerFor({ id: 'f1', answer: null }, 0, s)).toBe('Ja');
        expect(answerFor({ id: 'f1', answer: 'Ja, neuer Plan' }, 0, s)).toBe('Ja, neuer Plan');
        expect(answerFor({ id: 'f2', answer: null }, 1, s)).toBeNull();
        expect(answerFor({ id: 'f1', answer: null }, 0, null)).toBeNull();
    });
});
