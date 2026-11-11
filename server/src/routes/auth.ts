import { Router } from 'express';
import bcrypt from 'bcrypt';
import { query, getClient } from '../db';
import { authMiddleware, AuthRequest, generateToken } from '../middleware/auth';
import { buildUsername, normalizeUsername } from '../lib/normalize';
import { langFromRequest, t } from '../lib/i18n';

const router = Router();

const USER_FIELDS = 'id, username, name, language, avatar_url, view_color';

// Dummy bcrypt hash (cost 12) generated once at startup. When the username does not
// exist we still run a bcrypt.compare against it so the response time matches the
// "user found but wrong password" path, removing the account-enumeration timing oracle.
// Generated at load (rather than hardcoded) to guarantee a well-formed hash.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('opencare-timing-equalizer', 12);

const MIN_PASSWORD_LENGTH = 10;

// Sperre fuer die Einrichtung des allerersten Kontos: zwei gleichzeitige Anfragen
// auf einem leeren Server duerfen nicht beide Administrator werden.
const BOOTSTRAP_LOCK_KEY = 4180018;

router.get('/me', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const result = await query(
            `SELECT ${USER_FIELDS} FROM users WHERE id = $1`,
            [req.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        return res.json({ success: true, data: { user: result.rows[0] } });
    } catch (error) {
        console.error('Get current user error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Leer = keine Konten und kein Kreis. Nach der Voreinrichtung (scripts/voreinrichtung.ts)
// gibt es noch keine Konten, aber schon den Kreis: dann geht es nur per Einladungslink.
const NOT_EMPTY_SQL = 'SELECT 1 FROM users UNION ALL SELECT 1 FROM care_circles LIMIT 1';

// Oeffentlich: Ist der Server noch leer? Dann zeigt die Anmeldeseite das Anlegen
// des ersten Kontos (wird Administrator). Sonst gibt es Konten nur per Einladung.
router.get('/setup-status', async (_req, res) => {
    try {
        const result = await query(NOT_EMPTY_SQL);
        return res.json({ success: true, data: { firstAccount: result.rows.length === 0 } });
    } catch (error) {
        console.error('Setup status error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Registrieren (E18), nur in zwei Faellen:
//  - mit Einladungslink: Benutzername und Rolle kommen aus der Einladung, die
//    Person waehlt nur ihr Passwort;
//  - das allererste Konto auf einem leeren Server, mit Vor- und Nachname. Es legt
//    danach in der Einrichtung den Kreis an und ist dort Administrator.
// Oeffentliches Registrieren gibt es nicht mehr.
router.post('/register', async (req, res) => {
    const lang = langFromRequest(req);
    const { password, inviteToken, firstName, lastName } = req.body ?? {};
    const hasInviteToken = typeof inviteToken === 'string' && inviteToken.length > 0;

    if (typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ success: false, error: t(lang, 'auth.passwordRequired') });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ success: false, error: t(lang, 'auth.passwordTooShort') });
    }

    const client = await getClient();
    try {
        await client.query('BEGIN');

        let username: string;
        let invite: { id: string; circle_id: string; role: string } | null = null;

        if (hasInviteToken) {
            // FOR UPDATE: derselbe Link kann nicht zweimal gleichzeitig eingeloest werden.
            const inviteResult = await client.query(
                `SELECT id, circle_id, invitee_username, role FROM circle_invites
                 WHERE token = $1 AND status = 'pending' AND expires_at > NOW()
                   AND invitee_username IS NOT NULL
                 FOR UPDATE`,
                [inviteToken]
            );
            if (inviteResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: t(lang, 'invites.invalidOrExpired') });
            }
            const row = inviteResult.rows[0] as { id: string; circle_id: string; invitee_username: string; role: string };
            username = normalizeUsername(row.invitee_username);
            invite = { id: row.id, circle_id: row.circle_id, role: row.role };
        } else {
            await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);
            const userCount = await client.query(NOT_EMPTY_SQL);
            if (userCount.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({ success: false, error: t(lang, 'auth.registrationClosed') });
            }
            const built = buildUsername(firstName, lastName);
            if (!built) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: t(lang, 'auth.nameRequired') });
            }
            username = built;
        }

        const existingUser = await client.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (existingUser.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: t(lang, 'invites.usernameTaken') });
        }

        const password_hash = await bcrypt.hash(password, 12);

        // Das Konto startet in der Sprache der Anmeldeseite (Accept-Language).
        // Der Anzeigename ist zunaechst der Benutzername und in den Einstellungen aenderbar.
        const result = await client.query(
            `INSERT INTO users (username, password_hash, name, language) VALUES ($1, $2, $1, $3) RETURNING ${USER_FIELDS}`,
            [username, password_hash, lang]
        );
        const user = result.rows[0];

        // Die Rolle kommt NIE vom Client, sondern aus der Einladung.
        if (invite) {
            await client.query(
                'INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (circle_id, user_id) DO NOTHING',
                [invite.circle_id, user.id, invite.role]
            );
            await client.query("UPDATE circle_invites SET status = 'accepted' WHERE id = $1", [invite.id]);
        }

        await client.query('COMMIT');

        const token = generateToken(user.id);
        return res.json({ success: true, data: { user, token } });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error('Register error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Anmelden mit Benutzername (VornameNachname, ohne Leerzeichen und Gross-/Kleinschreibung) und Passwort.
router.post('/login', async (req, res) => {
    const lang = langFromRequest(req);
    try {
        const { username, password } = req.body ?? {};
        const cleanedUsername = typeof username === 'string' ? normalizeUsername(username) : '';

        if (!cleanedUsername || typeof password !== 'string' || !password) {
            return res.status(400).json({ success: false, error: t(lang, 'auth.loginMissing') });
        }

        const result = await query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [cleanedUsername]);
        if (result.rows.length === 0) {
            // Equalize the response time with the "wrong password" path so the
            // endpoint cannot be used to enumerate usernames by timing.
            await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
            return res.status(401).json({ success: false, error: t(lang, 'auth.invalidCredentials') });
        }

        const user = result.rows[0];
        const isValid = await bcrypt.compare(password, user.password_hash);

        if (!isValid) {
            return res.status(401).json({ success: false, error: t(lang, 'auth.invalidCredentials') });
        }

        const token = generateToken(user.id);

        res.json({
            success: true,
            data: {
                user: {
                    id: user.id,
                    username: user.username,
                    name: user.name,
                    language: user.language || 'fr',
                    avatar_url: user.avatar_url ?? null,
                },
                token,
            },
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Refresh the JWT (kept for client compatibility; memberships are resolved per request)
router.post('/refresh', authMiddleware, async (req: AuthRequest, res) => {
    try {
        const result = await query(
            `SELECT ${USER_FIELDS} FROM users WHERE id = $1`,
            [req.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const token = generateToken(result.rows[0].id);
        return res.json({ success: true, data: { token, user: result.rows[0] } });
    } catch (error) {
        console.error('Refresh token error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update user profile (display name and/or avatar). The avatar is stored as a
// compact data URL (the client resizes/compresses the image before upload).
router.put('/profile', authMiddleware, async (req: AuthRequest, res) => {
    const lang = langFromRequest(req);
    try {
        const { name, avatar_url } = req.body as { name?: unknown; avatar_url?: unknown };

        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (typeof name === 'string') {
            const cleaned = name.trim();
            if (cleaned.length === 0 || cleaned.length > 255) {
                return res.status(400).json({ success: false, error: 'Invalid name' });
            }
            fields.push(`name = $${idx++}`);
            values.push(cleaned);
        }

        if (avatar_url === null) {
            fields.push(`avatar_url = $${idx++}`);
            values.push(null);
        } else if (typeof avatar_url === 'string') {
            // Accept only data-URL images and cap the size (~1.5 MB of base64).
            if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(avatar_url)) {
                return res.status(400).json({ success: false, error: 'Invalid image format' });
            }
            if (avatar_url.length > 1_500_000) {
                return res.status(400).json({ success: false, error: t(lang, 'auth.imageTooLarge') });
            }
            fields.push(`avatar_url = $${idx++}`);
            values.push(avatar_url);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.userId);
        const result = await query(
            `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${USER_FIELDS}`,
            values
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        return res.json({ success: true, data: { user: result.rows[0] } });
    } catch (error) {
        console.error('Update profile error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
