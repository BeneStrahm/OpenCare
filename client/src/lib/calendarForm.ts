// Kleine, reine Helfer fuer das Terminformular (testbar ohne React).

/** Standard fuer NEUE Termine: kein Ende, Erinnerung 1 Stunde vorher an. */
export const NEW_EVENT_DEFAULTS = {
    endTime: '',
    reminder_30min: false,
    reminder_1hour: true,
} as const;

interface ExtraFields {
    endTime: string;
    location: string;
    member_ids: string[];
    notes: string;
    reminder_30min: boolean;
    reminder_1hour: boolean;
    recurrence: { freq: string };
}

/**
 * true, wenn ein Termin Angaben ausserhalb der drei Grundfelder (Name, Beginn,
 * Kategorie) hat. Dann oeffnet das Formular "Weitere Angaben" gleich aufgeklappt,
 * damit beim Bearbeiten nichts versteckt ist.
 */
export function hasExtraDetails(form: ExtraFields): boolean {
    return Boolean(
        form.endTime
        || form.location.trim()
        || form.member_ids.length > 0
        || form.notes.trim()
        || form.reminder_30min
        || !form.reminder_1hour
        || form.recurrence.freq
    );
}

/**
 * date-fns-Muster fuer ein ausgeschriebenes Datum mit Wochentag, je Sprache.
 * Deutsch: "Freitag, 20. November 2026", Englisch: "Friday, November 20, 2026",
 * Franzoesisch/Spanisch: "vendredi 20 novembre 2026".
 */
export function longDatePattern(lang: string, withYear: boolean): string {
    const l = (lang || '').slice(0, 2).toLowerCase();
    if (l === 'de') return withYear ? 'EEEE, d. MMMM yyyy' : 'EEEE, d. MMMM';
    if (l === 'en') return withYear ? 'EEEE, MMMM d, yyyy' : 'EEEE, MMMM d';
    return withYear ? 'EEEE d MMMM yyyy' : 'EEEE d MMMM';
}
