import { describe, it, expect } from 'vitest';
import {
    parseBackupStatus, evaluateBackup, backupAction, backupAlertTexts, maxAgeHours,
} from '../../server/src/lib/backupAlerts';

const now = new Date('2026-11-09T18:00:00+01:00');

describe('Meldung bei fehlgeschlagener Sicherung', () => {
    it('liest ok und fehler mit Zeitpunkt', () => {
        expect(parseBackupStatus('ok 2026-11-09T17:40:24+01:00\n')).toEqual({ ok: true, at: new Date('2026-11-09T17:40:24+01:00') });
        expect(parseBackupStatus('fehler 2026-11-09T17:40:24+01:00')?.ok).toBe(false);
        expect(parseBackupStatus('ok 2026-11-08T03:00:00+01:00\nfehler 2026-11-09T17:00:00+01:00\n')?.ok).toBe(false);
    });

    it('erkennt unbrauchbare Inhalte', () => {
        expect(parseBackupStatus('')).toBeNull();
        expect(parseBackupStatus('ok')).toBeNull();
        expect(parseBackupStatus('ok gestern')).toBeNull();
        expect(evaluateBackup(null, now, 26).problem).toBe('unreadable');
        expect(evaluateBackup('quatsch', now, 26).problem).toBe('unreadable');
    });

    it('bewertet fehler, veraltet und ok', () => {
        expect(evaluateBackup('fehler 2026-11-09T17:00:00+01:00', now, 26).problem).toBe('failed');
        expect(evaluateBackup('ok 2026-11-08T15:00:00+01:00', now, 26).problem).toBe('stale');
        expect(evaluateBackup('ok 2026-11-08T17:00:00+01:00', now, 26).problem).toBeNull();
        expect(evaluateBackup('ok 2026-11-09T17:40:24+01:00', now, 26).problem).toBeNull();
    });

    it('meldet pro Vorfall einmal und entwarnt beim naechsten ok', () => {
        expect(backupAction('failed', false)).toBe('notify');
        expect(backupAction('failed', true)).toBe('none');
        expect(backupAction('stale', true)).toBe('none');
        expect(backupAction(null, true)).toBe('resolve');
        expect(backupAction(null, false)).toBe('none');
    });

    it('nimmt 26 Stunden, wenn nichts Gueltiges gesetzt ist', () => {
        expect(maxAgeHours(undefined)).toBe(26);
        expect(maxAgeHours('abc')).toBe(26);
        expect(maxAgeHours('0')).toBe(26);
        expect(maxAgeHours('30')).toBe(30);
    });

    it('hat Texte auf Deutsch, Englisch, Franzoesisch und Spanisch', () => {
        const at = new Date('2026-11-09T17:40:00+01:00');
        const de = backupAlertTexts('de', 'failed', at, 26, 'Europe/Berlin');
        expect(de.title).toBe('Sicherung fehlgeschlagen');
        expect(de.body).toContain('Montag, 9. November');
        expect(de.body).toContain('17:40');
        expect(backupAlertTexts('de', 'stale', at, 26, 'Europe/Berlin').body).toContain('26 Stunden');
        expect(backupAlertTexts('de', 'resolved', at, 26, 'Europe/Berlin').title).toBe('Sicherung läuft wieder');
        for (const lang of ['en', 'fr', 'es']) {
            for (const kind of ['failed', 'stale', 'unreadable', 'resolved'] as const) {
                const t = backupAlertTexts(lang, kind, at, 26, 'Europe/Berlin');
                expect(t.title.length).toBeGreaterThan(0);
                expect(t.body).not.toContain('undefined');
            }
        }
        expect(backupAlertTexts('xx', 'failed', at, 26).title).toBe('Backup failed');
    });
});
