import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { query } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { createNotification } from '../lib/notifications';
import { decryptCredentials, encryptCredentials } from '../utils/crypto';
import logger from '../lib/logger';
import { langFromRequest, pickLang, t } from '../lib/i18n';
import { relayAdminIds, type Membership } from '../lib/resetRelay';

/**
 * Passwort vergessen (E18).
 *
 * Konten haben keine E-Mail-Adresse. Ein Administrator erzeugt auf der Seite
 * Kreis einen Link zum Zuruecksetzen und gibt ihn der Person weiter (persoenlich
 * oder auf einem sicheren Weg). Der Link gilt 24 Stunden und nur einmal.
 *
 * Nur ein Admin ALLER Kreise der Person darf einen Link erzeugen (lib/resetRelay):
 * der Link oeffnet das ganze Konto, ein Admin nur eines gemeinsamen Kreises
 * koennte sonst in fremde Kreise gelangen. Fuer das eigene Konto erzeugt niemand
 * selbst einen Link.
 *
 * Ist das Passwort geaendert, wird die Person benachrichtigt (in der App und per
 * Push), damit ein Zuruecksetzen, das sie nicht wollte, nicht unbemerkt bleibt.
 *
 * Der Jeton liegt fuer die Pruefung nur als Hash (SHA-256) vor. Eine verschluesselte
 * Kopie (AES-256-GCM, gleicher Schluessel wie die Integrationen) bleibt bis zur
 * Nutzung erhalten, damit der Admin den Link erneut kopieren kann.
 */

const router = Router();

const TOKEN_TTL_MINUTES = 24 * 60;
const MIN_PASSWORD_LENGTH = 10;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const resetPath = (token: string): string => `/reset-password?token=${token}`;

// Spalte password_resets.delivery: neue Links sind immer 'admin' (vom Admin weitergegeben).
type Delivery = 'email' | 'admin';

function ownerNotificationTexts(language: string): { title: string; message: string } {
    const lang = pickLang(language);
    if (lang === 'de') {
        return {
            title: 'Ihr Passwort wurde geändert',
            message: 'Ihr OpenCare-Passwort wurde mit einem Link zurückgesetzt, den ein Administrator des Kreises weitergegeben hat. Wenn Sie das nicht waren, informieren Sie sofort die Administratoren des Kreises.',
        };
    }
    if (lang === 'es') {
        return {
            title: 'Su contraseña ha cambiado',
            message: 'Su contraseña de OpenCare se ha restablecido con un enlace transmitido por un administrador del círculo. Si no ha sido usted, avise enseguida a los administradores del círculo.',
        };
    }
    if (lang === 'en') {
        return {
            title: 'Your password was changed',
            message: 'Your OpenCare password was reset with a link passed on by a circle admin. If this was not you, tell your circle admins right away.',
        };
    }
    return {
        title: 'Votre mot de passe a été changé',
        message: "Votre mot de passe OpenCare a été réinitialisé avec un lien transmis par un administrateur du cercle. Si ce n'est pas vous, prévenez aussitôt les administrateurs du cercle.",
    };
}

/** Alle Mitgliedschaften der Kreise, in denen die Person Mitglied ist (fuer lib/resetRelay). */
async function membershipsAround(userId: string): Promise<Membership[]> {
    const result = await query(
        `SELECT cm.user_id, cm.circle_id, cm.role
         FROM circle_members cm
         WHERE cm.circle_id IN (SELECT circle_id FROM circle_members WHERE user_id = $1)`,
        [userId]
    );
    return result.rows as Membership[];
}

// Ein Admin erzeugt einen Link fuer ein Mitglied. Ein frueherer, noch nicht
// genutzter Link derselben Person wird dabei ungueltig.
router.post('/password-resets', authMiddleware, async (req: AuthRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const { user_id: targetId } = req.body as { user_id?: unknown };
        if (typeof targetId !== 'string' || targetId === req.userId) {
            return res.status(400).json({ success: false, error: t(lang, 'auth.resetNotAllowed') });
        }
        const allowed = relayAdminIds(await membershipsAround(targetId), targetId).includes(req.userId!);
        if (!allowed) {
            return res.status(403).json({ success: false, error: t(lang, 'auth.resetNotAllowed') });
        }

        await query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [targetId]);

        const token = randomBytes(32).toString('hex');
        const result = await query(
            `INSERT INTO password_resets (user_id, token_hash, token_encrypted, delivery, expires_at)
             VALUES ($1, $2, $3, 'admin', NOW() + ($4 || ' minutes')::interval)
             RETURNING id, expires_at`,
            [targetId, hashToken(token), encryptCredentials({ token }), String(TOKEN_TTL_MINUTES)]
        );

        logger.info('password_reset.created_by_admin', { userId: targetId, adminId: req.userId });
        return res.json({
            success: true,
            data: { id: result.rows[0].id, expires_at: result.rows[0].expires_at, url: resetPath(token) },
        });
    } catch (error) {
        logger.error('password_reset.create_failed', { error: error instanceof Error ? error.message : String(error) });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Validite d'un jeton (page "nouveau mot de passe"). 200 dans tous les cas.
router.get('/reset-password/:token', async (req, res: Response) => {
    try {
        const token = String(req.params.token || '');
        if (!/^[a-f0-9]{64}$/.test(token)) {
            return res.json({ success: true, data: { valid: false } });
        }
        const result = await query(
            `SELECT u.name, u.username FROM password_resets pr
             JOIN users u ON u.id = pr.user_id
             WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > NOW()`,
            [hashToken(token)]
        );
        if (result.rows.length === 0) {
            return res.json({ success: true, data: { valid: false } });
        }
        return res.json({ success: true, data: { valid: true, name: result.rows[0].name, username: result.rows[0].username } });
    } catch (error) {
        logger.error('password_reset.check_failed', { error: error instanceof Error ? error.message : String(error) });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Nouveau mot de passe. Invalide le jeton et les sessions ouvertes du compte.
router.post('/reset-password', async (req, res: Response) => {
    try {
        const { token, password } = req.body as { token?: unknown; password?: unknown };
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || typeof password !== 'string') {
            return res.status(400).json({ success: false, error: 'Invalid or expired link' });
        }
        if (password.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ success: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }

        const result = await query(
            `SELECT pr.id, pr.user_id, pr.delivery, COALESCE(u.language, 'fr') AS language
             FROM password_resets pr
             JOIN users u ON u.id = pr.user_id
             WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > NOW()`,
            [hashToken(token)]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, error: 'Invalid or expired link' });
        }
        const reset = result.rows[0] as { id: string; user_id: string; delivery: Delivery; language: string };

        const passwordHash = await bcrypt.hash(password, 12);
        await query(
            'UPDATE users SET password_hash = $1, password_changed_at = NOW(), updated_at = NOW() WHERE id = $2',
            [passwordHash, reset.user_id]
        );
        // Jeton consomme, copie chiffree effacee, autres demandes annulees.
        await query('UPDATE password_resets SET used_at = NOW(), token_encrypted = NULL WHERE id = $1', [reset.id]);
        await query('DELETE FROM password_resets WHERE user_id = $1 AND id <> $2', [reset.user_id, reset.id]);

        // La personne est prevenue sur ses appareils : une reinitialisation qu'elle
        // n'a pas demandee (lien relaye par un admin) ne doit pas passer inapercue.
        const texts = ownerNotificationTexts(reset.language);
        await createNotification({
            userId: reset.user_id,
            title: texts.title,
            message: texts.message,
            type: 'password_changed',
            relatedId: reset.user_id,
            url: '/settings',
        });

        logger.info('password_reset.completed', { userId: reset.user_id, delivery: reset.delivery });
        return res.json({ success: true, data: {} });
    } catch (error) {
        logger.error('password_reset.failed', { error: error instanceof Error ? error.message : String(error) });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Offene Links, die ein Administrator sieht: Mitglieder der Kreise, die er verwaltet
// (er selbst ausgenommen), nur wenn er Admin aller ihrer Kreise ist, mit dem Link.
router.get('/password-resets', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT pr.id, pr.expires_at, pr.created_at, pr.token_encrypted,
                    u.id AS user_id, u.name, u.username,
                    cm.circle_id
             FROM password_resets pr
             JOIN users u ON u.id = pr.user_id
             JOIN circle_members cm ON cm.user_id = pr.user_id
             JOIN circle_members me ON me.circle_id = cm.circle_id AND me.user_id = $1 AND me.role = 'admin'
             WHERE pr.delivery = 'admin' AND pr.used_at IS NULL AND pr.expires_at > NOW()
               AND pr.token_encrypted IS NOT NULL AND pr.user_id <> $1
             ORDER BY pr.created_at DESC`,
            [req.userId]
        );

        // Un lien n'est montre qu'a un admin de tous les cercles de la personne.
        const rows = result.rows as {
            id: string; expires_at: string; created_at: string; token_encrypted: string;
            user_id: string; name: string; username: string; circle_id: string;
        }[];
        const allowed = new Map<string, boolean>();
        for (const targetId of new Set(rows.map((row) => row.user_id))) {
            allowed.set(targetId, relayAdminIds(await membershipsAround(targetId), targetId).includes(req.userId!));
        }

        const data = rows.filter((row) => allowed.get(row.user_id)).map((row) => {
            let url: string | null = null;
            try {
                url = resetPath(decryptCredentials(row.token_encrypted).token);
            } catch (err) {
                logger.warn('password_reset.decrypt_failed', { id: row.id, error: err instanceof Error ? err.message : String(err) });
            }
            return {
                id: row.id,
                user_id: row.user_id,
                name: row.name,
                username: row.username,
                circle_id: row.circle_id,
                expires_at: row.expires_at,
                created_at: row.created_at,
                url,
            };
        });

        return res.json({ success: true, data });
    } catch (error) {
        logger.error('password_reset.list_failed', { error: error instanceof Error ? error.message : String(error) });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Annulation d'une demande : meme regle que la liste (lib/resetRelay), seul un
// admin de tous les cercles de la personne peut l'annuler. L'admin d'un seul
// cercle partage ne voit pas la demande, il ne doit pas pouvoir l'effacer non plus.
router.delete('/password-resets/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const pending = await query(
            'SELECT user_id FROM password_resets WHERE id = $1 AND used_at IS NULL',
            [req.params.id]
        );
        const targetId = pending.rows[0]?.user_id as string | undefined;
        const allowed = targetId !== undefined
            && relayAdminIds(await membershipsAround(targetId), targetId).includes(req.userId!);
        const result = allowed
            ? await query('DELETE FROM password_resets WHERE id = $1 AND used_at IS NULL RETURNING id', [req.params.id])
            : { rows: [] };
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }
        return res.json({ success: true, data: {} });
    } catch (error) {
        logger.error('password_reset.cancel_failed', { error: error instanceof Error ? error.message : String(error) });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
