import { Router, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { circleMiddleware, requireAdmin, CircleRequest, CIRCLE_ROLES } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';
import { buildUsername } from '../lib/normalize';
import { langFromRequest, t } from '../lib/i18n';

const router = Router();

const VALID_ROLES: string[] = CIRCLE_ROLES;

// Public preview of an invite (shown before signup). No auth.
router.get('/info/:token', async (req, res) => {
    const lang = langFromRequest(req);
    try {
        const result = await query(
            `SELECT i.role, i.invitee_username, i.expires_at,
                    c.name AS circle_name,
                    r.first_name AS recipient_first_name,
                    u.name AS inviter_name
             FROM circle_invites i
             JOIN care_circles c ON c.id = i.circle_id
             LEFT JOIN care_recipients r ON r.circle_id = i.circle_id
             LEFT JOIN users u ON u.id = i.created_by
             WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()
               AND i.invitee_username IS NOT NULL`,
            [req.params.token]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: t(lang, 'invites.invalidOrExpired') });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Invite info error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// An existing, logged-in account accepts an invite and joins the circle.
router.post('/accept/:token', authMiddleware, async (req: AuthRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const result = await query(
            `SELECT id, circle_id, invitee_username, role FROM circle_invites
             WHERE token = $1 AND status = 'pending' AND expires_at > NOW()
               AND invitee_username IS NOT NULL`,
            [req.params.token]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: t(lang, 'invites.invalidOrExpired') });
        }

        const invite = result.rows[0];

        // Die Einladung gilt nur fuer das Konto mit dem Benutzernamen aus der Einladung.
        const me = await query(
            'SELECT 1 FROM users WHERE id = $1 AND LOWER(username) = LOWER($2)',
            [req.userId, invite.invitee_username]
        );
        if (me.rows.length === 0) {
            return res.status(403).json({ success: false, error: t(lang, 'invites.reservedForOtherAccount') });
        }

        const existing = await query(
            'SELECT id FROM circle_members WHERE circle_id = $1 AND user_id = $2',
            [invite.circle_id, req.userId]
        );
        if (existing.rows.length > 0) {
            return res.status(400).json({ success: false, error: t(lang, 'invites.alreadyMember') });
        }

        await query(
            'INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, $3)',
            [invite.circle_id, req.userId, invite.role]
        );
        await query("UPDATE circle_invites SET status = 'accepted' WHERE id = $1", [invite.id]);

        await broadcastToCircle(invite.circle_id, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: { circle_id: invite.circle_id } });
    } catch (error) {
        console.error('Accept invite error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Management endpoints: scoped to the active circle, admin only.
router.use(authMiddleware, circleMiddleware, requireAdmin);

// List pending invites of the circle
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT i.id, i.token, i.invitee_username, i.role, i.status, i.expires_at, i.created_at,
                    u.name AS created_by_name
             FROM circle_invites i
             LEFT JOIN users u ON u.id = i.created_by
             WHERE i.circle_id = $1 AND i.status = 'pending' AND i.expires_at > NOW()
             ORDER BY i.created_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List invites error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Einladung anlegen (E18): Rolle, Vor- und Nachname (ergibt den Benutzernamen),
// Gueltigkeit 1 bis 30 Tage. Gibt es den Benutzernamen schon (Konto oder offene
// Einladung), kommt eine einfache Meldung.
router.post('/', async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const { role, first_name, last_name, expires_in_days } = req.body ?? {};

        const cleanedRole = typeof role === 'string' && VALID_ROLES.includes(role) ? role : 'family';
        const days = Number.parseInt(String(expires_in_days ?? 7), 10);
        const cleanedDays = Number.isNaN(days) ? 7 : Math.min(Math.max(days, 1), 30);
        const username = buildUsername(first_name, last_name);
        if (!username) {
            return res.status(400).json({ success: false, error: t(lang, 'auth.nameRequired') });
        }

        const taken = await query(
            `SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)
             UNION ALL
             SELECT 1 FROM circle_invites
             WHERE LOWER(invitee_username) = LOWER($1) AND status = 'pending' AND expires_at > NOW()
             LIMIT 1`,
            [username]
        );
        if (taken.rows.length > 0) {
            return res.status(409).json({ success: false, error: t(lang, 'invites.usernameTaken') });
        }

        const token = crypto.randomBytes(32).toString('hex');

        const result = await query(
            `INSERT INTO circle_invites (circle_id, created_by, token, invitee_username, role, expires_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' days')::interval)
             RETURNING id, token, invitee_username, role, status, expires_at, created_at`,
            [req.circleId, req.userId, token, username, cleanedRole, String(cleanedDays)]
        );

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create invite error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Revoke an invite
router.delete('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            "UPDATE circle_invites SET status = 'revoked' WHERE id = $1 AND circle_id = $2 RETURNING id",
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Invite not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Revoke invite error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
