// Meldung an die Admins, wenn die Sicherung fehlschlaegt (Fork, Roadmap Phase 4, E12).
//
// Das Sicherungsskript auf dem Server schreibt nach jedem Lauf eine Zeile in eine
// Statusdatei: "ok <Zeitpunkt>" oder "fehler <Zeitpunkt>" (ISO 8601 mit Zeitzone).
// Die Datei wird read-only in den Container eingebunden, BACKUP_STATUS_FILE nennt
// ihren Pfad. Ohne diese Variable ist die Funktion aus.
//
// Ein Durchlauf alle 15 Minuten. Problem = "fehler", letzter Erfolg aelter als
// BACKUP_STATUS_MAX_AGE_HOURS (Standard 26) oder Datei nicht lesbar. Pro Vorfall
// genau eine Meldung an alle Admins (Zeile in backup_alert_state). Beim naechsten
// "ok" wird die Markierung geloescht und eine kurze Entwarnung verschickt.

import fs from 'fs';
import { query } from '../db';
import logger from './logger';
import { createNotification } from './notifications';

export type BackupProblem = 'failed' | 'stale' | 'unreadable';
export type BackupState = { problem: BackupProblem | null; at: Date | null };

const DEFAULT_MAX_AGE_HOURS = 26;

/** Liest die letzte nicht leere Zeile ("ok ..." oder "fehler ..."). Null, wenn unbrauchbar. */
export function parseBackupStatus(text: string): { ok: boolean; at: Date } | null {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) return null;
    const match = /^(ok|fehler)\s+(\S+)$/i.exec(last);
    if (!match) return null;
    const at = new Date(match[2]);
    if (Number.isNaN(at.getTime())) return null;
    return { ok: match[1].toLowerCase() === 'ok', at };
}

/** Bewertet den Inhalt der Statusdatei (null = Datei nicht lesbar). */
export function evaluateBackup(text: string | null, now: Date, maxAgeHours: number): BackupState {
    if (text === null) return { problem: 'unreadable', at: null };
    const status = parseBackupStatus(text);
    if (!status) return { problem: 'unreadable', at: null };
    if (!status.ok) return { problem: 'failed', at: status.at };
    if (now.getTime() - status.at.getTime() > maxAgeHours * 3600_000) return { problem: 'stale', at: status.at };
    return { problem: null, at: status.at };
}

/** Was ein Durchlauf tun muss. Kein zweites Melden, solange kein "ok" kam. */
export function backupAction(problem: BackupProblem | null, alreadyAlerted: boolean): 'notify' | 'resolve' | 'none' {
    if (problem) return alreadyAlerted ? 'none' : 'notify';
    return alreadyAlerted ? 'resolve' : 'none';
}

export function maxAgeHours(raw: string | undefined): number {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_AGE_HOURS;
}

const LOCALES: Record<string, string> = { de: 'de-DE', en: 'en-GB', fr: 'fr-FR', es: 'es-ES' };

export function formatWhen(at: Date, lang: string, timeZone?: string): string {
    const opts: Intl.DateTimeFormatOptions = {
        weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    };
    try {
        return new Intl.DateTimeFormat(LOCALES[lang] ?? 'en-GB', { ...opts, timeZone }).format(at);
    } catch {
        return new Intl.DateTimeFormat(LOCALES[lang] ?? 'en-GB', opts).format(at);
    }
}

type Kind = BackupProblem | 'resolved';
type Text = { title: string; body: (when: string, hours: number) => string };

const TEXTS: Record<string, Record<Kind, Text>> = {
    de: {
        failed: {
            title: 'Sicherung fehlgeschlagen',
            body: (w) => `Die automatische Sicherung der Daten hat nicht geklappt (zuletzt versucht: ${w}). Die App läuft normal weiter. Bitte auf dem Server das Protokoll der Sicherung ansehen und die Sicherung danach von Hand starten.`,
        },
        stale: {
            title: 'Sicherung überfällig',
            body: (w, h) => `Seit über ${h} Stunden gab es keine erfolgreiche Sicherung (zuletzt: ${w}). Bitte auf dem Server prüfen, ob die Sicherung noch regelmäßig läuft.`,
        },
        unreadable: {
            title: 'Stand der Sicherung unbekannt',
            body: () => 'Der Server kann den Stand der Sicherung nicht lesen. Bitte auf dem Server prüfen, ob die Sicherung läuft und die Statusdatei eingebunden ist.',
        },
        resolved: {
            title: 'Sicherung läuft wieder',
            body: (w) => `Die Sicherung hat wieder geklappt (zuletzt: ${w}). Es ist nichts mehr zu tun.`,
        },
    },
    en: {
        failed: {
            title: 'Backup failed',
            body: (w) => `The automatic data backup did not succeed (last attempt: ${w}). The app keeps working normally. Please check the backup log on the server and then start the backup by hand.`,
        },
        stale: {
            title: 'Backup overdue',
            body: (w, h) => `There has been no successful backup for more than ${h} hours (last: ${w}). Please check on the server that the backup still runs regularly.`,
        },
        unreadable: {
            title: 'Backup status unknown',
            body: () => 'The server cannot read the backup status. Please check on the server that the backup runs and the status file is mounted.',
        },
        resolved: {
            title: 'Backup working again',
            body: (w) => `The backup succeeded again (last: ${w}). Nothing more to do.`,
        },
    },
    fr: {
        failed: {
            title: 'Échec de la sauvegarde',
            body: (w) => `La sauvegarde automatique des données a échoué (dernier essai : ${w}). L'application fonctionne normalement. Consultez le journal de sauvegarde sur le serveur, puis relancez la sauvegarde à la main.`,
        },
        stale: {
            title: 'Sauvegarde en retard',
            body: (w, h) => `Aucune sauvegarde réussie depuis plus de ${h} heures (dernière : ${w}). Vérifiez sur le serveur que la sauvegarde tourne toujours régulièrement.`,
        },
        unreadable: {
            title: 'État de la sauvegarde inconnu',
            body: () => "Le serveur ne peut pas lire l'état de la sauvegarde. Vérifiez sur le serveur que la sauvegarde tourne et que le fichier d'état est monté.",
        },
        resolved: {
            title: 'La sauvegarde fonctionne à nouveau',
            body: (w) => `La sauvegarde a de nouveau réussi (dernière : ${w}). Plus rien à faire.`,
        },
    },
    es: {
        failed: {
            title: 'La copia de seguridad ha fallado',
            body: (w) => `La copia de seguridad automática de los datos no ha funcionado (último intento: ${w}). La aplicación sigue funcionando con normalidad. Revise el registro de la copia en el servidor y después iníciela a mano.`,
        },
        stale: {
            title: 'Copia de seguridad atrasada',
            body: (w, h) => `No hay ninguna copia de seguridad correcta desde hace más de ${h} horas (última: ${w}). Compruebe en el servidor que la copia sigue funcionando con regularidad.`,
        },
        unreadable: {
            title: 'Estado de la copia de seguridad desconocido',
            body: () => 'El servidor no puede leer el estado de la copia de seguridad. Compruebe en el servidor que la copia funciona y que el archivo de estado está montado.',
        },
        resolved: {
            title: 'La copia de seguridad vuelve a funcionar',
            body: (w) => `La copia de seguridad ha vuelto a funcionar (última: ${w}). No hay nada más que hacer.`,
        },
    },
};

export function backupAlertTexts(lang: string, kind: Kind, at: Date | null, hours: number, timeZone?: string) {
    const key = TEXTS[lang] ? lang : 'en';
    const t = TEXTS[key][kind];
    const when = at ? formatWhen(at, key, timeZone) : '';
    return { title: t.title, body: t.body(when, hours) };
}

function readStatus(file: string): string | null {
    try {
        // Die Datei ist eine Zeile; mehr als 4 KB wird nicht gelesen.
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(4096);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            return buf.subarray(0, n).toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }
}

async function notifyAdmins(kind: Kind, at: Date | null, hours: number): Promise<number> {
    const tz = process.env.TZ;
    const { rows } = await query(
        `SELECT DISTINCT cm.user_id, COALESCE(u.language, 'fr') AS language
         FROM circle_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.role = 'admin'`
    );
    for (const admin of rows as Array<{ user_id: string; language: string }>) {
        const { title, body } = backupAlertTexts(admin.language, kind, at, hours, tz);
        await createNotification({
            userId: admin.user_id,
            title,
            message: body,
            type: kind === 'resolved' ? 'backup_ok' : 'backup_failed',
            tag: 'backup-status',
        });
    }
    return rows.length;
}

export function backupCheckEnabled(): boolean {
    return Boolean(process.env.BACKUP_STATUS_FILE?.trim());
}

export async function checkBackupStatus(): Promise<void> {
    const file = process.env.BACKUP_STATUS_FILE?.trim();
    if (!file) return;
    try {
        const hours = maxAgeHours(process.env.BACKUP_STATUS_MAX_AGE_HOURS);
        const state = evaluateBackup(readStatus(file), new Date(), hours);
        const current = await query(`SELECT problem FROM backup_alert_state WHERE id = 1`);
        const alerted = Boolean(current.rows[0]?.problem);
        const action = backupAction(state.problem, alerted);

        if (action === 'notify') {
            // Erst markieren, dann melden: ein zweiter Durchlauf meldet nie doppelt.
            const claimed = await query(
                `UPDATE backup_alert_state SET problem = $1, alerted_at = NOW()
                 WHERE id = 1 AND problem IS NULL RETURNING id`,
                [state.problem]
            );
            if (claimed.rows.length === 0) return;
            const recipients = await notifyAdmins(state.problem!, state.at, hours);
            logger.warn('backup.alert_sent', { problem: state.problem, recipients });
        } else if (action === 'resolve') {
            const cleared = await query(
                `UPDATE backup_alert_state SET problem = NULL, alerted_at = NULL
                 WHERE id = 1 AND problem IS NOT NULL RETURNING id`
            );
            if (cleared.rows.length === 0) return;
            const recipients = await notifyAdmins('resolved', state.at, hours);
            logger.info('backup.alert_resolved', { recipients });
        }
    } catch (err) {
        logger.error('backup.check_error', { error: err instanceof Error ? err.message : String(err) });
    }
}
