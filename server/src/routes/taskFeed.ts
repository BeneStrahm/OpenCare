import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { featureEnabledForCircle } from '../lib/features';
import { publicSettings, WeekStart } from '../lib/circleSettings';

// E62: Aufgaben-Link (JSON) für Abrufe von außen, etwa eine Morgen-Mail über n8n.
// Aufbau wie das Kalender-Abo (routes/calendar.ts): geheimer Link pro Nutzer, nur lesen.
// Nur Kreise, in denen der Nutzer die Rolle admin oder family hat. Keine Beschreibung, keine IDs.
const router = Router();

const TOKEN_RE = /^[a-f0-9]{64}$/;

const pad2 = (n: number): string => String(n).padStart(2, '0');
const localDate = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Letzter Tag der laufenden Woche (YYYY-MM-DD), wie endOfWeek auf der Aufgabenseite. */
export const weekEndOf = (today: Date, weekStart: WeekStart): string => {
    const lastDay = weekStart === 'sunday' ? 6 : 0; // getDay(): 0 = Sonntag
    const diff = (lastDay - today.getDay() + 7) % 7;
    return localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + diff));
};

const canUseTaskFeed = async (userId: string): Promise<boolean> => {
    const result = await query(
        `SELECT 1 FROM circle_members WHERE user_id = $1 AND role IN ('admin', 'family') LIMIT 1`,
        [userId]
    );
    return result.rows.length > 0;
};

// GET /api/task-feed/token: Link-Token des angemeldeten Nutzers (null, wenn noch keiner)
router.get('/token', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const allowed = await canUseTaskFeed(req.userId!);
        const result = await query('SELECT tasks_token FROM users WHERE id = $1', [req.userId]);
        res.json({ success: true, data: { allowed, token: allowed ? (result.rows[0]?.tasks_token ?? null) : null } });
    } catch (error) {
        console.error('Get task feed token error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/task-feed/token: Token erzeugen oder erneuern (der alte Link wird ungültig)
router.post('/token', authMiddleware, async (req: AuthRequest, res) => {
    try {
        if (!(await canUseTaskFeed(req.userId!))) {
            return res.status(403).json({ success: false, error: 'FORBIDDEN' });
        }
        const token = crypto.randomBytes(32).toString('hex');
        await query('UPDATE users SET tasks_token = $1 WHERE id = $2', [token, req.userId]);
        res.json({ success: true, data: { token } });
    } catch (error) {
        console.error('Generate task feed token error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/task-feed/feed/:token.json (ohne Anmeldung, geschützt durch den geheimen Token)
// Offene Aufgaben, die überfällig sind oder bis Ende dieser Woche fällig werden, früheste zuerst.
router.get('/feed/:token.json', async (req, res) => {
    try {
        const token = req.params.token;
        if (!token || !TOKEN_RE.test(token)) {
            return res.status(404).send('Not found');
        }
        const userResult = await query('SELECT id FROM users WHERE tasks_token = $1', [token]);
        if (userResult.rows.length === 0) {
            return res.status(404).send('Not found');
        }
        const userId = userResult.rows[0].id;

        const circlesResult = await query(
            `SELECT c.id, c.settings,
                    (SELECT r.first_name FROM care_recipients r WHERE r.circle_id = c.id LIMIT 1) AS first_name
             FROM circle_members m
             JOIN care_circles c ON c.id = m.circle_id
             WHERE m.user_id = $1 AND m.role IN ('admin', 'family')`,
            [userId]
        );

        const now = new Date();
        const today = localDate(now);
        const circles = new Map<string, { weekEnd: string; name: string | null }>();
        for (const row of circlesResult.rows) {
            if (!(await featureEnabledForCircle(row.id, 'tasks'))) continue;
            circles.set(row.id, {
                weekEnd: weekEndOf(now, publicSettings(row.settings).week_start),
                name: row.first_name ?? null,
            });
        }

        const tasks: { title: string; due_date: string; overdue: boolean; assignees: string[]; recipient: string | null }[] = [];
        if (circles.size > 0) {
            const tasksResult = await query(
                `SELECT circle_id, title, due_date, assigned_to, assigned_names
                 FROM tasks
                 WHERE circle_id = ANY($1::uuid[]) AND is_completed = false AND due_date IS NOT NULL
                 ORDER BY due_date ASC, created_at ASC`,
                [[...circles.keys()]]
            );

            const memberIds = [...new Set(tasksResult.rows.flatMap((t: any) => (Array.isArray(t.assigned_to) ? t.assigned_to : [])))];
            const names = new Map<string, string>();
            if (memberIds.length > 0) {
                const membersResult = await query(
                    `SELECT m.id, u.name FROM circle_members m JOIN users u ON u.id = m.user_id
                     WHERE m.id = ANY($1::uuid[])`,
                    [memberIds]
                );
                for (const m of membersResult.rows) names.set(m.id, m.name);
            }

            for (const t of tasksResult.rows) {
                const circle = circles.get(t.circle_id);
                const due = String(t.due_date).slice(0, 10);
                if (!circle || due > circle.weekEnd) continue;
                const members: string[] = (Array.isArray(t.assigned_to) ? t.assigned_to : [])
                    .map((id: string) => names.get(id))
                    .filter((n: string | undefined): n is string => Boolean(n));
                const guests: string[] = Array.isArray(t.assigned_names) ? t.assigned_names : [];
                tasks.push({
                    title: t.title,
                    due_date: due,
                    overdue: due < today,
                    assignees: [...members, ...guests],
                    recipient: circle.name,
                });
            }
        }

        res.setHeader('Cache-Control', 'no-store');
        res.json({ today, tasks });
    } catch (error) {
        console.error('Task feed error:', error);
        res.status(500).send('Internal server error');
    }
});

export default router;
