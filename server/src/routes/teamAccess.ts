import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import {
    circleMiddleware,
    requireRole,
    requireRoleOrTeam,
    TEAM_FUNCTIONS,
    CircleRequest,
} from '../middleware/circle';
import {
    TEAM_IDLE_MINUTES,
    TEAM_LOCK_MINUTES,
    TEAM_MAX_FAILED_ATTEMPTS,
    TEAM_PIN_PATTERN,
    hashTeamToken,
    newTeamToken,
} from '../lib/teamAccess';

/*
 * Teambereich (E64), siehe lib/teamAccess.ts und middleware/circle.ts.
 * GET    /api/team-access         admin, recipient: eingerichtet? welche Funktionen? mit Token: noch offen?
 * PUT    /api/team-access         admin: PIN (6 bis 12 Ziffern) setzen oder entfernen, Funktionen waehlen
 * POST   /api/team-access/unlock  recipient: mit Passwort freischalten, liefert das Token
 * POST   /api/team-access/lock    recipient: wieder schliessen
 * GET    /api/team-access/names   offener Teambereich (Pflegetagebuch): Namensvorschlaege
 */

const router = Router();
router.use(authMiddleware, circleMiddleware);

interface TeamAccessRow {
    password_hash: string | null;
    functions: string[] | null;
    failed_attempts: number;
    locked_until: string | null;
    locked_ms_left: number | string | null;
}

const loadTeamAccess = async (circleId: string): Promise<TeamAccessRow | null> => {
    const result = await query(
        `SELECT password_hash, functions, failed_attempts, locked_until,
                GREATEST(0, EXTRACT(EPOCH FROM (locked_until - CURRENT_TIMESTAMP)) * 1000) AS locked_ms_left
         FROM team_access WHERE circle_id = $1`,
        [circleId]
    );
    return (result.rows[0] as TeamAccessRow | undefined) ?? null;
};

const publicState = (row: TeamAccessRow | null) => ({
    configured: !!row?.password_hash && (row?.functions ?? []).length > 0,
    has_password: !!row?.password_hash,
    functions: row?.functions ?? [],
    idle_minutes: TEAM_IDLE_MINUTES,
});

router.get('/', requireRole('admin', 'recipient'), async (req: CircleRequest, res: Response) => {
    try {
        // Mit Team-Token: ist der Teambereich noch offen? Wenn ja, bleibt er weitere
        // TEAM_IDLE_MINUTES offen (das Tablet fragt so, solange jemand es bedient).
        let open = false;
        const token = req.headers['x-team-token'];
        if (req.circleRole === 'recipient' && typeof token === 'string' && token) {
            const result = await query(
                `UPDATE team_access_sessions SET expires_at = CURRENT_TIMESTAMP + make_interval(mins => $4)
                 WHERE token_hash = $1 AND circle_id = $2 AND user_id = $3 AND expires_at > CURRENT_TIMESTAMP
                 RETURNING id`,
                [hashTeamToken(token), req.circleId, req.userId, TEAM_IDLE_MINUTES]
            );
            open = result.rows.length > 0;
        }
        res.json({ success: true, data: { ...publicState(await loadTeamAccess(req.circleId!)), open } });
    } catch (error) {
        console.error('Get team access error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.put('/', requireRole('admin'), async (req: CircleRequest, res: Response) => {
    const { password, functions } = req.body ?? {};

    if (!Array.isArray(functions) || functions.some((fn) => !(TEAM_FUNCTIONS as readonly unknown[]).includes(fn))) {
        return res.status(400).json({ success: false, error: 'Invalid functions' });
    }
    const cleanFunctions = [...new Set(functions as string[])];

    // undefined: Passwort bleibt; null: Passwort entfernen (Teambereich aus); Text: neues Passwort
    let passwordHash: string | null | undefined;
    if (password === null) {
        passwordHash = null;
    } else if (password !== undefined) {
        if (typeof password !== 'string' || !TEAM_PIN_PATTERN.test(password)) {
            return res.status(400).json({ success: false, error: 'TEAM_PIN_FORMAT' });
        }
        passwordHash = await bcrypt.hash(password, 12);
    }

    try {
        await query(
            `INSERT INTO team_access (circle_id, password_hash, functions, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (circle_id) DO UPDATE SET
                password_hash = CASE WHEN $5 THEN EXCLUDED.password_hash ELSE team_access.password_hash END,
                functions = EXCLUDED.functions,
                failed_attempts = CASE WHEN $5 THEN 0 ELSE team_access.failed_attempts END,
                locked_until = CASE WHEN $5 THEN NULL ELSE team_access.locked_until END,
                updated_by = EXCLUDED.updated_by,
                updated_at = CURRENT_TIMESTAMP`,
            [req.circleId, passwordHash ?? null, cleanFunctions, req.userId, passwordHash !== undefined]
        );
        // Jede Aenderung schliesst offene Teambereiche: die neue Auswahl gilt sofort.
        await query('DELETE FROM team_access_sessions WHERE circle_id = $1', [req.circleId]);
        res.json({ success: true, data: publicState(await loadTeamAccess(req.circleId!)) });
    } catch (error) {
        console.error('Update team access error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.post('/unlock', requireRole('recipient'), async (req: CircleRequest, res: Response) => {
    const { password } = req.body ?? {};
    // Falsches Format zaehlt wie eine falsche PIN, ohne Fehlversuch (der Server vergleicht nichts).
    if (typeof password !== 'string' || !TEAM_PIN_PATTERN.test(password)) {
        return res.status(403).json({ success: false, error: 'WRONG_PASSWORD' });
    }
    try {
        const row = await loadTeamAccess(req.circleId!);
        if (!publicState(row).configured || !row?.password_hash) {
            return res.status(404).json({ success: false, error: 'TEAM_ACCESS_OFF' });
        }
        const lockedMs = Number(row.locked_ms_left ?? 0);
        if (lockedMs > 0) {
            return res.status(429).json({ success: false, error: 'TEAM_LOCKED', retry_after_seconds: Math.ceil(lockedMs / 1000) });
        }

        // Kein 401: der Client meldet bei 401 das ganze Konto ab.
        if (!(await bcrypt.compare(password, row.password_hash))) {
            const failed = row.failed_attempts + 1;
            if (failed >= TEAM_MAX_FAILED_ATTEMPTS) {
                await query(
                    `UPDATE team_access SET failed_attempts = 0,
                        locked_until = CURRENT_TIMESTAMP + make_interval(mins => $2)
                     WHERE circle_id = $1`,
                    [req.circleId, TEAM_LOCK_MINUTES]
                );
                return res.status(429).json({ success: false, error: 'TEAM_LOCKED', retry_after_seconds: TEAM_LOCK_MINUTES * 60 });
            }
            await query('UPDATE team_access SET failed_attempts = $2 WHERE circle_id = $1', [req.circleId, failed]);
            return res.status(403).json({ success: false, error: 'WRONG_PASSWORD' });
        }

        const token = newTeamToken();
        await query('UPDATE team_access SET failed_attempts = 0, locked_until = NULL WHERE circle_id = $1', [req.circleId]);
        // Alte und abgelaufene Teambereiche dieses Kontos aufraeumen, dann den neuen anlegen.
        await query(
            'DELETE FROM team_access_sessions WHERE expires_at <= CURRENT_TIMESTAMP OR (circle_id = $1 AND user_id = $2)',
            [req.circleId, req.userId]
        );
        await query(
            `INSERT INTO team_access_sessions (circle_id, user_id, token_hash, expires_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP + make_interval(mins => $4))`,
            [req.circleId, req.userId, hashTeamToken(token), TEAM_IDLE_MINUTES]
        );
        res.json({ success: true, data: { token, functions: row.functions ?? [], idle_minutes: TEAM_IDLE_MINUTES } });
    } catch (error) {
        console.error('Unlock team access error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.post('/lock', requireRole('recipient'), async (req: CircleRequest, res: Response) => {
    try {
        const token = req.headers['x-team-token'];
        if (typeof token === 'string' && token) {
            await query(
                'DELETE FROM team_access_sessions WHERE token_hash = $1 AND circle_id = $2 AND user_id = $3',
                [hashTeamToken(token), req.circleId, req.userId]
            );
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Lock team access error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Namensvorschlaege fuer "Ihr Name" im Pflegetagebuch: Mitglieder des Kreises (ohne die
// betreute Person) und Namen, die schon im Tagebuch stehen (ohne Einnahmen und Messungen).
// Neue Namen sind erlaubt.
router.get('/names', requireRoleOrTeam('admin', 'family', 'professional'), async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT name FROM (
                SELECT u.name FROM circle_members m JOIN users u ON u.id = m.user_id
                WHERE m.circle_id = $1 AND m.role <> 'recipient'
                UNION
                SELECT author_name AS name FROM journal_entries
                WHERE circle_id = $1 AND type <> ALL(ARRAY['medication', 'vital'])
             ) n
             WHERE name IS NOT NULL AND TRIM(name) <> ''
             ORDER BY name
             LIMIT 200`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows.map((row: { name: string }) => row.name) });
    } catch (error) {
        console.error('Team names error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
