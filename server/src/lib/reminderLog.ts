import { query } from '../db';

// Fork, Block E: Merkliste gesendeter Erinnerungen (Tabelle reminder_log, db.ts).
// Eine Erinnerung ist eindeutig durch Art, Bezug (Termin oder Kreis), Zeitpunkt
// (z. B. Datum des Vorkommens) und Person. claimReminder traegt atomar ein und
// sagt, ob diese Person die Erinnerung jetzt bekommen soll: so gibt es keine
// Doppel, auch nicht bei zwei Zeittakten gleichzeitig.

/** true, wenn die Erinnerung fuer diese Person neu ist und jetzt gesendet werden soll. */
export async function claimReminder(kind: string, refId: string, slot: string, userId: string): Promise<boolean> {
    const { rows } = await query(
        `INSERT INTO reminder_log (kind, ref_id, slot, user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING kind`,
        [kind, refId, slot, userId]
    );
    return rows.length > 0;
}

/** Eintraege aelter als 60 Tage entfernen (taeglich). */
export async function pruneReminderLog(): Promise<void> {
    await query(`DELETE FROM reminder_log WHERE created_at < NOW() - INTERVAL '60 days'`);
}
