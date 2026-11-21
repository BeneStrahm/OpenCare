import { createHash, randomBytes } from 'crypto';
import { query } from '../db';

/*
 * Teambereich (E64): gemeinsames Passwort des Pflegeteams am Tablet der betreuten Person.
 * - team_access: pro Kreis Passwort (bcrypt) und freigegebene Funktionen, von admin gesetzt,
 *   dazu Fehlversuche und Sperre.
 * - team_access_sessions: offene Teambereiche. Das Token geht nur an das Tablet, gespeichert
 *   wird sein SHA-256-Hash. Jede erlaubte Anfrage verlaengert die Zeit um TEAM_IDLE_MINUTES.
 * Welche Anfragen zu welcher Funktion gehoeren, steht in middleware/circle.ts.
 */

/** Ohne Anfrage schliesst sich der Teambereich nach dieser Zeit (auch am Tablet). */
export const TEAM_IDLE_MINUTES = 5;
/** Nach so vielen falschen Passwoertern hintereinander ... */
export const TEAM_MAX_FAILED_ATTEMPTS = 5;
/** ... ist das Freischalten so lange gesperrt. */
export const TEAM_LOCK_MINUTES = 5;
/** Das gemeinsame Passwort ist eine PIN aus 6 bis 12 Ziffern (Wunsch vom 22. November). */
export const TEAM_PIN_MIN = 6;
export const TEAM_PIN_MAX = 12;
export const TEAM_PIN_PATTERN = new RegExp(`^[0-9]{${TEAM_PIN_MIN},${TEAM_PIN_MAX}}$`);
/** Laengster Name im Pflegetagebuch (journal_entries.author_name ist VARCHAR(100)). */
export const TEAM_AUTHOR_NAME_MAX = 100;

export const hashTeamToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export const newTeamToken = (): string => randomBytes(32).toString('hex');

/**
 * Ist der Teambereich mit diesem Token offen und die Funktion freigegeben?
 * Wenn ja, verlaengert sich die Zeit bis zum Schliessen.
 */
export async function teamSessionAllows(
    circleId: string,
    userId: string | undefined,
    token: string,
    fn: string
): Promise<boolean> {
    if (!userId || !/^[0-9a-f]{64}$/.test(token)) return false;
    const result = await query(
        `UPDATE team_access_sessions s
         SET expires_at = CURRENT_TIMESTAMP + make_interval(mins => $5)
         FROM team_access a
         WHERE s.token_hash = $1 AND s.circle_id = $2 AND s.user_id = $3
           AND s.expires_at > CURRENT_TIMESTAMP
           AND a.circle_id = s.circle_id AND a.password_hash IS NOT NULL
           AND $4 = ANY(a.functions)
         RETURNING s.id`,
        [hashTeamToken(token), circleId, userId, fn, TEAM_IDLE_MINUTES]
    );
    return result.rows.length > 0;
}
