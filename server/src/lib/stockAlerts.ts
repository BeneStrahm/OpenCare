// Erinnerung, wenn ein Medikament zur Neige geht (Fork).
//
// Einfach und robust: Ein Durchlauf jede Minute prueft alle Medikamente mit
// Vorrat. Die Schwelle wird aus dem Plan berechnet: Reicht der Vorrat laut Plan
// noch STOCK_REMINDER_DAYS Tage oder weniger (oder ist er leer), bekommen
// Admins und Familie EINE Benachrichtigung (stock_alert_sent_at wird gesetzt).
// Steigt der Vorrat wieder ueber die Schwelle (aufgefuellt), wird die Markierung
// geloescht, damit das naechste Absinken wieder meldet.
// Das deckt jede Aenderung ab (Einnahme, Rueckgaengig, manuelle Eingabe),
// ohne in die Transaktionen der einzelnen Routen einzugreifen.

import { query } from '../db';
import logger from './logger';
import { createNotification } from './notifications';

export type StockState = 'low' | 'ok' | 'untracked';

/** Erinnerung, sobald der Vorrat laut Plan nur noch so viele Tage reicht. */
export const STOCK_REMINDER_DAYS = 7;

/**
 * Tagesmenge laut Plan (SQL, Medikament als `m`). Einnahmen an einzelnen
 * Wochentagen zaehlen anteilig. Bei Bedarf (prn) gibt es keinen Plan: 0.
 */
export const DAILY_DOSE_SQL = `(CASE WHEN m.prn THEN 0 ELSE (
    SELECT COALESCE(SUM(s.quantity * jsonb_array_length(s.days_of_week) / 7.0), 0)
    FROM medication_schedules s WHERE s.medication_id = m.id) END)`;

/** Bedingung "Vorrat geht zur Neige" (SQL, Medikament als `m`), passend zu stockState. */
export const STOCK_LOW_SQL = `(m.active = TRUE AND m.stock_quantity IS NOT NULL
    AND (m.stock_quantity <= 0 OR m.stock_quantity <= ${STOCK_REMINDER_DAYS} * ${DAILY_DOSE_SQL}))`;

/** Reiner Vergleich: low = leer oder reicht laut Plan hoechstens STOCK_REMINDER_DAYS Tage. */
export function stockState(quantity: unknown, dailyDose: unknown): StockState {
    const q = quantity === null || quantity === undefined ? NaN : Number(quantity);
    if (!Number.isFinite(q)) return 'untracked';
    if (q <= 0) return 'low';
    const d = dailyDose === null || dailyDose === undefined ? NaN : Number(dailyDose);
    if (!Number.isFinite(d) || d <= 0) return 'ok';
    return q <= STOCK_REMINDER_DAYS * d ? 'low' : 'ok';
}

/** Was ein Durchlauf tun muss: melden, Markierung loeschen oder nichts. */
export function stockAction(state: StockState, alreadySent: boolean): 'notify' | 'reset' | 'none' {
    if (state === 'low') return alreadySent ? 'none' : 'notify';
    return alreadySent ? 'reset' : 'none';
}

/** Menge ohne unnoetige Nachkommastellen, mit Komma auf Deutsch, Franzoesisch, Spanisch. */
export function formatAmount(value: number, lang: string): string {
    const rounded = Math.round(value * 100) / 100;
    const text = String(rounded);
    return lang === 'en' ? text : text.replace('.', ',');
}

const TEXTS: Record<string, { title: (name: string) => string; body: (name: string, amount: string, unit: string) => string }> = {
    de: {
        title: (n) => `${n} geht zur Neige`,
        body: (n, a, u) => `${n} geht zur Neige: noch ${a} ${u || 'Stück'}. Bitte Rezept oder Nachschub besorgen.`,
    },
    en: {
        title: (n) => `${n} is running low`,
        body: (n, a, u) => `${n} is running low: ${a} ${u || 'units'} left. Please get a prescription or a refill.`,
    },
    fr: {
        title: (n) => `${n} bientôt épuisé`,
        body: (n, a, u) => `${n} bientôt épuisé : il reste ${a} ${u || 'unité(s)'}. Pensez à l'ordonnance ou au renouvellement.`,
    },
    es: {
        title: (n) => `Queda poco ${n}`,
        body: (n, a, u) => `Queda poco ${n}: ${a} ${u || 'unidad(es)'}. Consigue la receta o la reposición.`,
    },
};

/** Zaehl-Einheiten (Tablette, Kapsel ...) werden zu "Stück", damit "noch 5 Tablette" nicht vorkommt. */
const COUNT_UNITS = /^(stück|stk\.?|tablette[n]?|tabl?\.?|kapsel[n]?|dragees?|zäpfchen|beutel|tablet[s]?|capsule[s]?|pill[s]?|comprimés?|gélules?|comprimidos?|cápsulas?)$/i;

export function stockAlertTexts(lang: string, name: string, amount: number, unit: string | null) {
    const key = TEXTS[lang] ? lang : 'en';
    if (unit && COUNT_UNITS.test(unit.trim())) unit = null;
    const amountText = formatAmount(amount, key);
    return { title: TEXTS[key].title(name), body: TEXTS[key].body(name, amountText, unit ?? '') };
}

interface StockRow {
    id: string;
    circle_id: string;
    name: string;
    active: boolean;
    stock_quantity: string | null;
    daily_dose: string | null;
    stock_alert_sent_at: string | null;
    unit: string | null;
}

export async function checkLowStock(): Promise<void> {
    try {
        const { rows } = await query(
            `SELECT m.id, m.circle_id, m.name, m.active, m.stock_quantity, m.stock_alert_sent_at,
                    ${DAILY_DOSE_SQL} AS daily_dose,
                    (SELECT s.unit FROM medication_schedules s WHERE s.medication_id = m.id ORDER BY s.time_of_day LIMIT 1) AS unit
             FROM medications m
             WHERE m.stock_alert_sent_at IS NOT NULL OR ${STOCK_LOW_SQL}`
        );
        for (const med of rows as StockRow[]) {
            // Archivierte Medikamente gelten als nicht verfolgt: Markierung wird geloescht,
            // damit nach dem Wiederaktivieren erneut gemeldet werden kann.
            const state = med.active ? stockState(med.stock_quantity, med.daily_dose) : 'untracked';
            const action = stockAction(state, med.stock_alert_sent_at !== null);
            if (action === 'reset') {
                await query(`UPDATE medications SET stock_alert_sent_at = NULL WHERE id = $1`, [med.id]);
                continue;
            }
            if (action !== 'notify') continue;
            // Erst markieren, dann melden: ein zweiter Durchlauf meldet nie doppelt.
            const claimed = await query(
                `UPDATE medications SET stock_alert_sent_at = NOW() WHERE id = $1 AND stock_alert_sent_at IS NULL RETURNING id`,
                [med.id]
            );
            if (claimed.rows.length === 0) continue;
            const members = await query(
                `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
                 FROM circle_members cm JOIN users u ON u.id = cm.user_id
                 WHERE cm.circle_id = $1 AND cm.role IN ('admin', 'family')`,
                [med.circle_id]
            );
            for (const member of members.rows as Array<{ user_id: string; language: string }>) {
                const { title, body } = stockAlertTexts(member.language, med.name, Number(med.stock_quantity), med.unit);
                await createNotification({
                    userId: member.user_id,
                    circleId: med.circle_id,
                    title,
                    message: body,
                    type: 'medication_stock',
                    relatedId: med.id,
                    url: '/medications',
                    tag: `stock-${med.id}`,
                });
            }
            logger.info('reminder.stock_sent', { medicationId: med.id, recipients: members.rows.length });
        }
    } catch (err) {
        logger.error('reminder.stock_error', { error: err instanceof Error ? err.message : String(err) });
    }
}
