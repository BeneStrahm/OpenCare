// E64 Teambereich: gemeinsame Typen fuer die einfache Ansicht (Tablet) und die Einstellungen (admin).
// Rechte und Ablauf stehen auf dem Server (server/src/middleware/circle.ts, lib/teamAccess.ts).

/** Funktionen, die admin fuer den Teambereich freigeben kann (gleich TEAM_FUNCTIONS auf dem Server). */
export const TEAM_FUNCTIONS = ['journal', 'medplan', 'consultation'] as const;
export type TeamFunction = (typeof TEAM_FUNCTIONS)[number];

/** Das gemeinsame Passwort ist eine PIN aus 6 bis 12 Ziffern (gleich auf dem Server). */
export const TEAM_PIN_MIN = 6;
export const TEAM_PIN_MAX = 12;
export const isTeamPin = (value: string): boolean => new RegExp(`^[0-9]{${TEAM_PIN_MIN},${TEAM_PIN_MAX}}$`).test(value);
/** Nur Ziffern behalten (Eingabe am Tablet und in den Einstellungen). */
export const onlyDigits = (value: string): string => value.replace(/[^0-9]/g, '').slice(0, TEAM_PIN_MAX);

/** Antwort von GET /api/team-access */
export interface TeamAccessInfo {
    /** Passwort gesetzt und mindestens eine Funktion gewaehlt */
    configured: boolean;
    has_password: boolean;
    functions: TeamFunction[];
    idle_minutes: number;
    /** Nur mit Team-Token: ist der Teambereich noch offen? */
    open?: boolean;
}

/** Antwort von POST /api/team-access/unlock */
export interface TeamUnlockResult {
    token: string;
    functions: TeamFunction[];
    idle_minutes: number;
}

export const isTeamFunction = (value: unknown): value is TeamFunction =>
    typeof value === 'string' && (TEAM_FUNCTIONS as readonly string[]).includes(value);
