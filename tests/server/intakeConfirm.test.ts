import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import type { Response } from 'express';
import {
    confirmIntakesTaken,
    intakeSourceForRole,
    parseConfirmIntakeIds,
} from '../../server/src/lib/intakes';
import {
    CIRCLE_ROLES,
    CONTENT_WRITER_ROLES,
    INTAKE_CONFIRMER_ROLES,
    requireRole,
    type CircleRequest,
    type CircleRole,
} from '../../server/src/middleware/circle';

/**
 * POST /api/medications/intakes/confirm (Taste "alle genommen").
 * Ohne Datenbank: die Logik in intakes.ts laeuft gegen einen Ersatz-Client,
 * die Rollenpruefung der Route (requireRole mit INTAKE_CONFIRMER_ROLES) direkt.
 */

type Row = { id: string; status: 'pending' | 'taken' | 'skipped' | 'missed'; source: string | null };

const fakeClient = (rows: Row[]) => {
    const byId = new Map(rows.map((r) => [r.id, { ...r }]));
    const journal: { source: string; status: string }[] = [];
    const client = {
        query: async (sql: string, params: unknown[] = []) => {
            if (sql.includes('FROM medication_intakes i')) {
                const row = byId.get(params[0] as string);
                if (!row || params[1] !== 'kreis-1') return { rows: [] };
                return {
                    rows: [{
                        id: row.id, circle_id: 'kreis-1', medication_id: 'med-1', journal_entry_id: null,
                        status: row.status, medication_name: 'Testmittel', medication_dosage: '5 mg',
                        quantity: null, unit: null,
                    }],
                };
            }
            if (sql.includes('INSERT INTO journal_entries')) {
                const data = JSON.parse(params[5] as string);
                journal.push({ source: data.source, status: data.status });
                return { rows: [{ id: `eintrag-${journal.length}` }] };
            }
            if (sql.includes('UPDATE medication_intakes')) {
                const row = byId.get(params[5] as string)!;
                row.status = params[0] as Row['status'];
                row.source = params[3] as string;
                return { rows: [row] };
            }
            return { rows: [] };
        },
    } as unknown as PoolClient;
    return { client, byId, journal };
};

const runGuard = (role: CircleRole | undefined) => {
    let status = 200;
    let passed = false;
    const res = {
        status(code: number) { status = code; return this; },
        json() { return this; },
    } as unknown as Response;
    requireRole(...INTAKE_CONFIRMER_ROLES)({ circleRole: role } as CircleRequest, res, () => { passed = true; });
    return { status, passed };
};

describe('POST /intakes/confirm: Rollen', () => {
    it('laesst die betreute Person bestaetigen', () => {
        expect(runGuard('recipient')).toEqual({ status: 200, passed: true });
    });

    it('lehnt ohne Rolle im Kreis ab (403)', () => {
        expect(runGuard(undefined)).toEqual({ status: 403, passed: false });
    });

    it('lehnt Freunde (neighbor) ab (403)', () => {
        expect(runGuard('neighbor')).toEqual({ status: 403, passed: false });
    });

    it('laesst admin, family und professional bestaetigen', () => {
        for (const role of CIRCLE_ROLES.filter((r) => r !== 'neighbor' && r !== 'recipient')) {
            expect(runGuard(role), role).toEqual({ status: 200, passed: true });
        }
    });

    it('gibt recipient sonst keine Schreibrechte fuer Inhalte', () => {
        expect(CONTENT_WRITER_ROLES).not.toContain('recipient');
    });
});

describe('POST /intakes/confirm: Quelle', () => {
    it('vermerkt self, wenn die betreute Person bestaetigt', () => {
        expect(intakeSourceForRole('recipient')).toBe('self');
    });

    it('vermerkt caregiver fuer alle anderen Rollen', () => {
        for (const role of CIRCLE_ROLES.filter((r) => r !== 'recipient')) {
            expect(intakeSourceForRole(role)).toBe('caregiver');
        }
    });
});

describe('parseConfirmIntakeIds', () => {
    it('nimmt nur Texte, ohne Doppel', () => {
        expect(parseConfirmIntakeIds(['a', 'a', 3, null, 'b'])).toEqual(['a', 'b']);
    });

    it('gibt ohne Liste nichts zurueck (Route antwortet dann 400)', () => {
        expect(parseConfirmIntakeIds(undefined)).toEqual([]);
        expect(parseConfirmIntakeIds('a')).toEqual([]);
    });

    it('begrenzt auf 50 Einnahmen', () => {
        expect(parseConfirmIntakeIds(Array.from({ length: 60 }, (_, i) => `id-${i}`))).toHaveLength(50);
    });
});

describe('confirmIntakesTaken', () => {
    const author = { userId: 'konto-1', name: 'Testperson' };

    it('bestaetigt offene Einnahmen mit Quelle self und einem Journaleintrag je Einnahme', async () => {
        const { client, byId, journal } = fakeClient([
            { id: 'morgens-1', status: 'pending', source: null },
            { id: 'morgens-2', status: 'missed', source: null },
        ]);
        const n = await confirmIntakesTaken(client, 'kreis-1', ['morgens-1', 'morgens-2'], author, 'self');
        expect(n).toBe(2);
        expect(byId.get('morgens-1')).toMatchObject({ status: 'taken', source: 'self' });
        expect(byId.get('morgens-2')).toMatchObject({ status: 'taken', source: 'self' });
        expect(journal).toEqual([{ source: 'self', status: 'taken' }, { source: 'self', status: 'taken' }]);
    });

    it('legt beim zweiten Bestaetigen keine Doppel an', async () => {
        const { client, journal } = fakeClient([{ id: 'morgens-1', status: 'pending', source: null }]);
        expect(await confirmIntakesTaken(client, 'kreis-1', ['morgens-1'], author, 'self')).toBe(1);
        expect(await confirmIntakesTaken(client, 'kreis-1', ['morgens-1'], author, 'self')).toBe(0);
        expect(journal).toHaveLength(1);
    });

    it('laesst ausgelassene Einnahmen und fremde IDs unveraendert', async () => {
        const { client, byId, journal } = fakeClient([{ id: 'ausgelassen', status: 'skipped', source: 'caregiver' }]);
        const n = await confirmIntakesTaken(client, 'kreis-1', ['ausgelassen', 'gibt-es-nicht'], author, 'self');
        expect(n).toBe(0);
        expect(byId.get('ausgelassen')).toMatchObject({ status: 'skipped', source: 'caregiver' });
        expect(journal).toHaveLength(0);
    });

    it('bestaetigt nichts aus einem anderen Kreis', async () => {
        const { client, journal } = fakeClient([{ id: 'morgens-1', status: 'pending', source: null }]);
        expect(await confirmIntakesTaken(client, 'kreis-2', ['morgens-1'], author, 'self')).toBe(0);
        expect(journal).toHaveLength(0);
    });
});
