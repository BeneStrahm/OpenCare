import { Router } from 'express';
import { query } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { LANGS } from '../lib/i18n';
import { VIEW_COLOR_IDS } from '../lib/viewColors';

const router = Router();

const SUPPORTED_LANGUAGES: readonly string[] = LANGS;

// Per-account settings only: anything circle-wide lives in care_circles.settings
// and is managed through the circles routes.

// Update the authenticated user's preferred language (used for the UI and for
// server-generated notifications such as reminders).
// PUT /api/auth/language. Body: { "language": "fr" | "en" | "es" | "de" }
router.put('/language', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const { language } = req.body as { language?: unknown };

        if (typeof language !== 'string' || !SUPPORTED_LANGUAGES.includes(language)) {
            return res.status(400).json({ success: false, error: `Invalid language. Supported values: ${LANGS.join(', ')}` });
        }

        const result = await query(
            'UPDATE users SET language = $1 WHERE id = $2 RETURNING id, username, name, language, avatar_url, view_color',
            [language, req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        return res.json({ success: true, data: { user: result.rows[0] } });
    } catch (error) {
        console.error('Update language error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Hitze-Meldung der einfachen Ansicht: mit OK fuer einen Tag weggetippt, gilt am Konto (alle Geraete).
// GET /api/auth/heat-dismissed -> { day: "YYYY-MM-DD" | null }
// PUT /api/auth/heat-dismissed. Body: { "day": "YYYY-MM-DD" } (Tag des Geraets)
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
router.get('/heat-dismissed', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const result = await query('SELECT heat_dismissed_on FROM users WHERE id = $1', [req.userId]);
        return res.json({ success: true, data: { day: result.rows[0]?.heat_dismissed_on ?? null } });
    } catch (error) {
        console.error('Read heat dismissed error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});
router.put('/heat-dismissed', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const { day } = req.body as { day?: unknown };
        if (typeof day !== 'string' || !DAY_RE.test(day)) {
            return res.status(400).json({ success: false, error: 'Invalid day. Expected YYYY-MM-DD' });
        }
        await query('UPDATE users SET heat_dismissed_on = $1 WHERE id = $2', [day, req.userId]);
        return res.json({ success: true, data: { day } });
    } catch (error) {
        console.error('Update heat dismissed error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Farbe der einfachen Ansicht (Block D, lib/viewColors.ts).
// PUT /api/auth/view-color. Body: { "color": "<Kennung>" | null } (null = Standard)
// Jedes Konto stellt nur die eigene Farbe ein, auch die betreute Person.
router.put('/view-color', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const { color } = req.body as { color?: unknown };
        if (color !== null && (typeof color !== 'string' || !VIEW_COLOR_IDS.includes(color))) {
            return res.status(400).json({ success: false, error: `Invalid color. Supported values: ${VIEW_COLOR_IDS.join(', ')}` });
        }
        const result = await query(
            'UPDATE users SET view_color = $1 WHERE id = $2 RETURNING id, username, name, language, avatar_url, view_color',
            [color, req.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        return res.json({ success: true, data: { user: result.rows[0] } });
    } catch (error) {
        console.error('Update view color error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
