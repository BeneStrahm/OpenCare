/**
 * Wer einen Link zum Zuruecksetzen des Passworts erzeugen darf (E18).
 *
 * Ein solcher Link oeffnet das GANZE Konto, also alle seine Kreise. Duerfte der
 * Admin nur eines gemeinsamen Kreises ihn erzeugen, koennte er das Konto
 * uebernehmen und in Kreise gelangen, in die er nicht eingeladen ist. Regel: nur
 * ein Admin JEDES Kreises der Person; er gewinnt so keinen Kreis dazu, den er
 * nicht schon verwaltet. Gibt es keinen solchen Admin, hilft nur der Betreiber.
 */

export interface Membership {
    user_id: string;
    circle_id: string;
    role: string;
}

/**
 * Les admins autorises a relayer le lien de `targetUserId`.
 * `memberships` : toutes les adhesions des cercles dont la personne est membre.
 */
export function relayAdminIds(memberships: Membership[], targetUserId: string): string[] {
    const targetCircles = new Set(
        memberships.filter((m) => m.user_id === targetUserId).map((m) => m.circle_id)
    );
    if (targetCircles.size === 0) return [];

    const adminCircles = new Map<string, Set<string>>();
    for (const m of memberships) {
        if (m.role !== 'admin' || m.user_id === targetUserId || !targetCircles.has(m.circle_id)) continue;
        if (!adminCircles.has(m.user_id)) adminCircles.set(m.user_id, new Set());
        adminCircles.get(m.user_id)!.add(m.circle_id);
    }

    return [...adminCircles.entries()]
        .filter(([, circles]) => [...targetCircles].every((c) => circles.has(c)))
        .map(([userId]) => userId)
        .sort();
}
