// Saetze, die der Server fuer die Sprachsteuerung baut: Rueckfrage vor dem
// Speichern und gesprochene Antworten. Eigene kleine Tabelle, damit das
// Modul nicht von lib/i18n.ts abhaengt. Fehlt eine Sprache, gilt Deutsch.

import type { VoiceIntent, VoiceParams } from './parser';

export type VoiceLang = 'de' | 'en' | 'fr' | 'es';

export function toVoiceLang(value: unknown): VoiceLang {
    const raw = typeof value === 'string' ? value : '';
    const first = raw.split(',')[0]?.trim().toLowerCase() ?? '';
    if (first.startsWith('en')) return 'en';
    if (first.startsWith('fr')) return 'fr';
    if (first.startsWith('es')) return 'es';
    return 'de';
}

const LOCALES: Record<VoiceLang, string> = { de: 'de-DE', en: 'en-GB', fr: 'fr-FR', es: 'es-ES' };

/** "Montag, 9. November" */
export function spokenDate(date: string, lang: VoiceLang): string {
    const [y, m, d] = date.split('-').map(Number);
    return new Intl.DateTimeFormat(LOCALES[lang], { weekday: 'long', day: 'numeric', month: 'long' })
        .format(new Date(y, m - 1, d, 12));
}

/** "9:30 Uhr" (de), "09:30" (en/fr/es, 24 Stunden) */
export function spokenTime(time: string, lang: VoiceLang): string {
    const [h, min] = time.split(':').map(Number);
    if (lang === 'de') return `${h}:${String(min).padStart(2, '0')} Uhr`;
    if (lang === 'fr') return `${h} h ${String(min).padStart(2, '0')}`;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function spokenNumber(value: number, lang: VoiceLang): string {
    return new Intl.NumberFormat(LOCALES[lang], { maximumFractionDigits: 2 }).format(value);
}

const q = (lang: VoiceLang, s: string) => (lang === 'fr' ? `« ${s} »` : lang === 'es' ? `«${s}»` : lang === 'de' ? `„${s}“` : `"${s}"`);

/** Die Rueckfrage vor dem Speichern. Nur fuer vollstaendige Befehle. */
export function confirmationText(intent: VoiceIntent, p: VoiceParams & { task_title?: string }, lang: VoiceLang): string {
    switch (intent) {
        case 'create_event': {
            const when = `${spokenDate(p.date!, lang)}, ${spokenTime(p.time!, lang)}`;
            return {
                de: `Termin ${q(lang, p.title!)} am ${when} speichern?`,
                en: `Save appointment ${q(lang, p.title!)} on ${when}?`,
                fr: `Enregistrer le rendez-vous ${q(lang, p.title!)} le ${when} ?`,
                es: `¿Guardar la cita ${q(lang, p.title!)} el ${when}?`,
            }[lang];
        }
        case 'create_task': {
            const due = p.due_date ? spokenDate(p.due_date, lang) : null;
            return {
                de: `Aufgabe ${q(lang, p.title!)} anlegen${due ? `, zu erledigen bis ${due}` : ''}?`,
                en: `Add task ${q(lang, p.title!)}${due ? `, due ${due}` : ''}?`,
                fr: `Ajouter la tâche ${q(lang, p.title!)}${due ? `, pour le ${due}` : ''} ?`,
                es: `¿Añadir la tarea ${q(lang, p.title!)}${due ? `, para el ${due}` : ''}?`,
            }[lang];
        }
        case 'complete_task': {
            const title = p.task_title ?? p.query ?? '';
            return {
                de: `Aufgabe ${q(lang, title)} als erledigt abhaken?`,
                en: `Mark task ${q(lang, title)} as done?`,
                fr: `Cocher la tâche ${q(lang, title)} comme faite ?`,
                es: `¿Marcar la tarea ${q(lang, title)} como hecha?`,
            }[lang];
        }
        case 'record_weight': {
            const v = `${spokenNumber(p.value!, lang)} ${p.unit === 'lb' ? 'lb' : 'kg'}`;
            return {
                de: `Gewicht ${v} eintragen?`,
                en: `Record weight ${v}?`,
                fr: `Enregistrer le poids ${v} ?`,
                es: `¿Registrar el peso ${v}?`,
            }[lang];
        }
        case 'record_glucose': {
            const v = `${spokenNumber(p.value!, lang)} ${p.unit}`;
            return {
                de: `Blutzucker ${v} eintragen?`,
                en: `Record blood sugar ${v}?`,
                fr: `Enregistrer la glycémie ${v} ?`,
                es: `¿Registrar la glucemia ${v}?`,
            }[lang];
        }
        case 'list_events':
            return '';
    }
}

export function doneText(intent: VoiceIntent, lang: VoiceLang): string {
    const table: Record<Exclude<VoiceIntent, 'list_events'>, Record<VoiceLang, string>> = {
        create_event: { de: 'Der Termin ist gespeichert.', en: 'The appointment is saved.', fr: 'Le rendez-vous est enregistré.', es: 'La cita está guardada.' },
        create_task: { de: 'Die Aufgabe ist angelegt.', en: 'The task is added.', fr: 'La tâche est ajoutée.', es: 'La tarea está añadida.' },
        complete_task: { de: 'Die Aufgabe ist abgehakt.', en: 'The task is marked as done.', fr: 'La tâche est cochée.', es: 'La tarea está marcada como hecha.' },
        record_weight: { de: 'Das Gewicht ist eingetragen.', en: 'The weight is recorded.', fr: 'Le poids est enregistré.', es: 'El peso está registrado.' },
        record_glucose: { de: 'Der Blutzucker ist eingetragen.', en: 'The blood sugar is recorded.', fr: 'La glycémie est enregistrée.', es: 'La glucemia está registrada.' },
    };
    return intent === 'list_events' ? '' : table[intent][lang];
}

/** Gesprochene Liste der Termine eines Tages. */
export function eventsSpoken(date: string, events: Array<{ title: string; time: string }>, isToday: boolean, isTomorrow: boolean, lang: VoiceLang): string {
    const day = isToday
        ? { de: 'Heute', en: 'Today', fr: "Aujourd'hui", es: 'Hoy' }[lang]
        : isTomorrow
            ? { de: 'Morgen', en: 'Tomorrow', fr: 'Demain', es: 'Mañana' }[lang]
            : { de: `Am ${spokenDate(date, lang)}`, en: `On ${spokenDate(date, lang)}`, fr: `Le ${spokenDate(date, lang)}`, es: `El ${spokenDate(date, lang)}` }[lang];
    if (events.length === 0) {
        return {
            de: `${day} sind keine Termine eingetragen.`,
            en: `${day} there are no appointments.`,
            fr: `${day}, aucun rendez-vous n'est prévu.`,
            es: `${day} no hay citas.`,
        }[lang];
    }
    const list = events.map((e) => `${spokenTime(e.time, lang)} ${e.title}`).join('. ');
    const count = events.length;
    return {
        de: `${day} ${count === 1 ? 'ist ein Termin' : `sind ${count} Termine`} eingetragen. ${list}.`,
        en: `${day} there ${count === 1 ? 'is one appointment' : `are ${count} appointments`}. ${list}.`,
        fr: `${day}, ${count === 1 ? 'un rendez-vous est prévu' : `${count} rendez-vous sont prévus`}. ${list}.`,
        es: `${day} ${count === 1 ? 'hay una cita' : `hay ${count} citas`}. ${list}.`,
    }[lang];
}

/** Vermerk an Eintraegen, die am Tablet der betreuten Person entstanden sind. */
export function deviceNote(deviceName: string, lang: VoiceLang): string {
    return {
        de: `Per Sprache am Gerät „${deviceName}“ angelegt.`,
        en: `Added by voice on the device "${deviceName}".`,
        fr: `Ajouté à la voix sur l'appareil « ${deviceName} ».`,
        es: `Añadido por voz en el dispositivo «${deviceName}».`,
    }[lang];
}
