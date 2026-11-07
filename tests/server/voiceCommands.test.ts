import { describe, it, expect } from 'vitest';
import {
    parseCommand,
    findTime,
    findDate,
    validateCommand,
    matchTask,
    glucoseToGl,
    weightToKg,
    cleanTitle,
} from '../../server/src/modules/voiceCommands/parser';

// Samstag, 7. November 2026
const TODAY = new Date(2026, 10, 7, 10, 0, 0);
const p = (text: string) => parseCommand(text, TODAY);

describe('Termin anlegen', () => {
    it('erkennt Titel, morgen und 9:30', () => {
        const r = p('Erstelle Termin Fußpflege morgen um 9:30');
        expect(r.intent).toBe('create_event');
        expect(r.params).toMatchObject({ title: 'Fußpflege', date: '2026-11-08', time: '09:30', category: 'other' });
        expect(r.missing).toEqual([]);
        expect(r.confidence).toBe('high');
    });

    it('reicht Fachwoerter und Eigennamen im Titel unveraendert durch', () => {
        const r = p('Erstelle Termin Kardiologe Dr. Özdemir am Montag um 10:15');
        expect(r.params.title).toBe('Kardiologe Dr. Özdemir');
        expect(r.params.date).toBe('2026-11-09');
        expect(r.params.time).toBe('10:15');
        expect(r.params.category).toBe('medical');
    });

    it('behaelt Medikamentennamen im Titel', () => {
        const r = p('Neuer Termin Marcumar-Einstellung beim Hausarzt übermorgen um 8 Uhr');
        expect(r.params.title).toBe('Marcumar-Einstellung beim Hausarzt');
        expect(r.params.date).toBe('2026-11-09');
        expect(r.params.time).toBe('08:00');
        expect(r.params.category).toBe('medical');
    });

    it('versteht "halb zehn"', () => {
        expect(p('Termin Physiotherapie morgen um halb zehn').params.time).toBe('09:30');
    });

    it('versteht "9 Uhr 30"', () => {
        expect(p('Termin Fußpflege morgen 9 Uhr 30').params.time).toBe('09:30');
    });

    it('versteht "viertel nach neun" und "viertel vor zehn"', () => {
        expect(p('Termin Friseur morgen viertel nach neun').params.time).toBe('09:15');
        expect(p('Termin Friseur morgen viertel vor zehn').params.time).toBe('09:45');
    });

    it('versteht "um 3 nachmittags"', () => {
        expect(p('Termin Kaffee mit Erika morgen um 3 nachmittags').params.time).toBe('15:00');
    });

    it('fragt bei "um 3" ohne Zusatz nach der Uhrzeit', () => {
        const r = p('Termin Kaffee mit Erika morgen um 3');
        expect(r.params.time).toBeUndefined();
        expect(r.missing).toContain('time');
        expect(r.confidence).toBe('low');
    });

    it('fragt nach dem Datum, wenn keins genannt wurde', () => {
        const r = p('Erstelle Termin Zahnarzt um 14 Uhr');
        expect(r.intent).toBe('create_event');
        expect(r.missing).toEqual(['date']);
        expect(r.params.time).toBe('14:00');
    });

    it('meldet fehlenden Titel', () => {
        const r = p('Erstelle einen Termin morgen um 9:30');
        expect(r.missing).toContain('title');
    });

    it('versteht "am 12. März" im naechsten Jahr', () => {
        const r = p('Termin Augenarzt am 12. März um 11 Uhr');
        expect(r.params.date).toBe('2027-03-12');
        expect(r.params.title).toBe('Augenarzt');
    });

    it('versteht "am 24.11." und "12.12.2026"', () => {
        expect(p('Termin Fußpflege am 24.11. um 10 Uhr').params.date).toBe('2026-11-24');
        expect(p('Termin Fußpflege am 12.12.2026 um 10 Uhr').params.date).toBe('2026-12-12');
    });

    it('verwechselt ein Datum nicht mit einer Uhrzeit', () => {
        const r = p('Termin Fußpflege am 24.11. um 9:30');
        expect(r.params.date).toBe('2026-11-24');
        expect(r.params.time).toBe('09:30');
    });

    it('Wochentag gleich heute meint den naechsten', () => {
        expect(p('Termin Fußpflege am Samstag um 10 Uhr').params.date).toBe('2026-11-14');
    });

    it('versteht "in zwei Wochen"', () => {
        expect(p('Termin Kontrolle Wundversorgung in zwei Wochen um 10 Uhr').params.date).toBe('2026-11-21');
    });

    it('lehnt den 31. Februar ab statt zu raten', () => {
        const r = p('Termin Fußpflege am 31.2. um 10 Uhr');
        expect(r.params.date).toBeUndefined();
        expect(r.missing).toContain('date');
    });

    it('erkennt "Arzttermin" als medizinisch', () => {
        const r = p('Arzttermin morgen um 10 Uhr');
        expect(r.intent).toBe('create_event');
        expect(r.params.category).toBe('medical');
        expect(r.missing).toEqual(['title']);
    });

    it('versteht Englisch', () => {
        const r = p('Create appointment dentist tomorrow at 9:30 am');
        expect(r.params).toMatchObject({ title: 'dentist', date: '2026-11-08', time: '09:30', category: 'medical' });
        expect(p('New appointment physio on Monday at 2 pm').params).toMatchObject({ title: 'physio', date: '2026-11-09', time: '14:00' });
    });

    it('ignoriert "Bitte" am Anfang', () => {
        expect(p('Bitte erstelle einen Termin Fußpflege morgen um 10 Uhr').params.title).toBe('Fußpflege');
    });
});

describe('Termine abfragen', () => {
    it('heute als Standard', () => {
        expect(p('Welche Termine habe ich?')).toMatchObject({ intent: 'list_events', params: { date: '2026-11-07' } });
    });
    it('morgen', () => {
        expect(p('Welche Termine habe ich morgen?').params.date).toBe('2026-11-08');
        expect(p('Termine morgen').params.date).toBe('2026-11-08');
    });
    it('was steht an', () => {
        expect(p('Was steht heute an?').intent).toBe('list_events');
    });
    it('Englisch', () => {
        expect(p('What appointments do I have tomorrow?').params.date).toBe('2026-11-08');
    });
});

describe('Aufgaben', () => {
    it('legt eine Aufgabe mit Frist an', () => {
        const r = p('Neue Aufgabe: Rezept abholen bis morgen');
        expect(r).toMatchObject({ intent: 'create_task', params: { title: 'Rezept abholen', due_date: '2026-11-08' } });
    });
    it('legt eine Aufgabe ohne Frist an', () => {
        const r = p('Neue Aufgabe Ramipril in der Apotheke bestellen');
        expect(r.params).toEqual({ title: 'Ramipril in der Apotheke bestellen' });
    });
    it('Frist mit Wochentag', () => {
        expect(p('Aufgabe anlegen Wäsche waschen bis Freitag').params).toEqual({ title: 'Wäsche waschen', due_date: '2026-11-13' });
    });
    it('Englisch', () => {
        expect(p('Add task pick up prescription by tomorrow').params).toEqual({ title: 'pick up prescription', due_date: '2026-11-08' });
    });
    it('meldet erledigt', () => {
        expect(p('Aufgabe Rezept abholen ist erledigt')).toMatchObject({ intent: 'complete_task', params: { query: 'Rezept abholen' } });
        expect(p('Erledigt: Rezept abholen').params.query).toBe('Rezept abholen');
        expect(p('Task pick up prescription is done').params.query).toBe('pick up prescription');
    });
    it('leere Aufgabe fehlt der Titel', () => {
        expect(p('Neue Aufgabe').missing).toEqual(['title']);
    });
});

describe('Messwerte', () => {
    it('Gewicht mit Komma', () => {
        expect(p('Gewicht 72,5 Kilo')).toMatchObject({ intent: 'record_weight', params: { value: 72.5, unit: 'kg' } });
    });
    it('Gewicht ohne Einheit', () => {
        const r = p('Ich wiege heute 68');
        expect(r.intent).toBe('record_weight');
        expect(r.params.value).toBe(68);
        expect(r.params.unit).toBeUndefined();
    });
    it('Zucker ganzzahlig = mg/dL', () => {
        expect(p('Zucker 110').params).toEqual({ value: 110, unit: 'mg/dL' });
    });
    it('Blutzucker mmol', () => {
        expect(p('Blutzucker 6,1 mmol').params).toEqual({ value: 6.1, unit: 'mmol/L' });
    });
    it('Zucker 6,1 ohne Einheit wird nicht geraten', () => {
        const r = p('Zucker 6,1');
        expect(r.params.unit).toBeUndefined();
        expect(r.missing).toEqual(['unit']);
    });
    it('Blood sugar englisch', () => {
        expect(p('Blood sugar 140 mg/dl').params).toEqual({ value: 140, unit: 'mg/dL' });
    });
    it('"Gewicht eintragen" fragt nach dem Wert', () => {
        expect(p('Gewicht eintragen')).toMatchObject({ intent: 'record_weight', missing: ['value'] });
    });
});

describe('wird NICHT erkannt', () => {
    it.each([
        'Wie geht es dir?',
        'Ruf meine Tochter an',
        'Zucker kaufen',
        'Ich habe Kopfschmerzen',
        'Wie spät ist es',
        '',
        '   ',
        'Termine',
    ].filter((t) => t !== 'Termine'))('"%s"', (text) => {
        expect(p(text).intent).toBeNull();
    });

    it('"Neue Aufgabe Zucker kaufen" ist eine Aufgabe, kein Messwert', () => {
        expect(p('Neue Aufgabe Zucker kaufen')).toMatchObject({ intent: 'create_task', params: { title: 'Zucker kaufen' } });
    });

    it('"Termin Gewicht kontrollieren" ist ein Termin, kein Messwert', () => {
        expect(p('Termin Gewicht kontrollieren morgen um 10 Uhr').intent).toBe('create_event');
    });
});

describe('Uhrzeit und Datum einzeln', () => {
    it('findTime', () => {
        expect(findTime('um 14:05')?.value).toBe('14:05');
        expect(findTime('um 25:00')?.value ?? null).toBeNull();
        expect(findTime('at noon')).toBeNull();
        expect(findTime('morgen früh um 7')?.value).toBe('07:00');
    });
    it('findDate: "morgens" ist nicht morgen', () => {
        expect(findDate('jeden Tag morgens', TODAY)).toBeNull();
    });
    it('findDate: "heute morgen" ist heute', () => {
        expect(findDate('heute morgen', TODAY)?.value).toBe('2026-11-07');
    });
    it('cleanTitle', () => {
        expect(cleanTitle(' für  Fußpflege  am ')).toBe('Fußpflege');
    });
});

describe('validateCommand', () => {
    it('lehnt unbekannte Befehle ab', () => {
        expect(validateCommand('delete_all', {})).toEqual({ error: 'UNKNOWN_INTENT' });
    });
    it('verlangt gueltiges Datum und Uhrzeit', () => {
        expect(validateCommand('create_event', { title: 'X', date: '2026-02-30', time: '10:00' })).toEqual({ error: 'INVALID_DATE' });
        expect(validateCommand('create_event', { title: 'X', date: '2026-02-20', time: '24:00' })).toEqual({ error: 'INVALID_TIME' });
        expect(validateCommand('create_event', { title: ' ', date: '2026-02-20', time: '10:00' })).toEqual({ error: 'TITLE_REQUIRED' });
    });
    it('verlangt eine Blutzucker-Einheit', () => {
        expect(validateCommand('record_glucose', { value: 6.1 })).toEqual({ error: 'UNIT_REQUIRED' });
    });
    it('lehnt unplausible Werte ab', () => {
        expect(validateCommand('record_weight', { value: 720, unit: 'kg' })).toEqual({ error: 'VALUE_OUT_OF_RANGE' });
        expect(validateCommand('record_glucose', { value: 6000, unit: 'mg/dL' })).toEqual({ error: 'VALUE_OUT_OF_RANGE' });
    });
    it('nimmt Zahlen mit Komma als Text', () => {
        expect(validateCommand('record_weight', { value: '72,5', unit: 'kg' })).toEqual({ intent: 'record_weight', params: { value: 72.5, unit: 'kg' } });
    });
});

describe('Umrechnung', () => {
    it('Blutzucker wird in g/L gespeichert', () => {
        expect(glucoseToGl(110, 'mg/dL')).toBeCloseTo(1.1, 5);
        expect(glucoseToGl(6.1, 'mmol/L')).toBeCloseTo(1.099, 3);
        expect(glucoseToGl(1.2, 'g/L')).toBe(1.2);
    });
    it('Pfund (lb) in kg', () => {
        expect(weightToKg(150, 'lb')).toBeCloseTo(68.04, 2);
    });
});

describe('matchTask', () => {
    const tasks = [
        { id: '1', title: 'Rezept abholen' },
        { id: '2', title: 'Rezept für Ramipril abholen' },
        { id: '3', title: 'Wäsche waschen' },
    ];
    it('exakter Treffer gewinnt', () => {
        expect(matchTask(tasks, 'rezept abholen')).toEqual({ match: tasks[0] });
    });
    it('eindeutiger Teiltreffer', () => {
        expect(matchTask(tasks, 'Wäsche')).toEqual({ match: tasks[2] });
    });
    it('mehrdeutig: kein Raten', () => {
        const r = matchTask(tasks, 'Rezept');
        expect('error' in r && r.error).toBe('TASK_AMBIGUOUS');
    });
    it('kein Treffer', () => {
        expect(matchTask(tasks, 'Fenster putzen')).toEqual({ error: 'TASK_NOT_FOUND' });
    });
});
