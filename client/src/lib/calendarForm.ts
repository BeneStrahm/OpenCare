// Kleine, reine Helfer fuer das Terminformular (testbar ohne React).

/** Standard fuer NEUE Termine: kein Ende, Erinnerung 1 Stunde vorher an. */
export const NEW_EVENT_DEFAULTS = {
    endTime: '',
    reminder_30min: false,
    reminder_1hour: true,
} as const;

/** Fork: Neue Termine bekommen Hin- und Rückfahrt mit je 30 Minuten. */
export const NEW_EVENT_TRAVEL_MINUTES = 30;
export const TRAVEL_STEP_MINUTES = 15;
export const TRAVEL_MIN_MINUTES = 15;
export const TRAVEL_MAX_MINUTES = 240;

/** Fahrzeit um einen 15-Minuten-Schritt ändern, innerhalb von 15 bis 240 Minuten. */
export function stepTravel(minutes: number, direction: 1 | -1): number {
    const next = minutes + direction * TRAVEL_STEP_MINUTES;
    return Math.min(TRAVEL_MAX_MINUTES, Math.max(TRAVEL_MIN_MINUTES, next));
}

/** Uhrzeit "HH:mm" um Minuten verschieben (über Mitternacht hinweg). */
export function shiftClock(clock: string, minutes: number): string {
    const [h, m] = clock.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return clock;
    const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

interface PersonOption {
    id: string;
    name: string;
}

/**
 * Eine Person zu den Teilnehmenden hinzufügen. Passt der Name zu einem Mitglied
 * des Kreises, wird das Mitglied gewählt, sonst steht der Name frei am Termin.
 * Doppelte Einträge (Groß/klein egal) werden nicht angelegt.
 */
export function addParticipant(
    current: { member_ids: string[]; guests: string[] },
    rawName: string,
    members: PersonOption[]
): { member_ids: string[]; guests: string[] } {
    const name = rawName.trim().replace(/\s+/g, ' ');
    if (!name) return current;
    const key = name.toLocaleLowerCase('de');
    const member = members.find((m) => m.name.trim().toLocaleLowerCase('de') === key);
    if (member) {
        return current.member_ids.includes(member.id)
            ? current
            : { ...current, member_ids: [...current.member_ids, member.id] };
    }
    if (current.guests.some((g) => g.toLocaleLowerCase('de') === key)) return current;
    return { ...current, guests: [...current.guests, name] };
}

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
