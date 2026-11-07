import { describe, it, expect } from 'vitest';
import { pickLang, pick, intlLocale, t, MESSAGES, LANGS } from '../../server/src/lib/i18n';
import { detectIntent, hasDistressSignal, answerIntent, describeIntake, CompanionFactsInput } from '../../server/src/lib/companionAnswers';
import { journalContent } from '../../server/src/lib/visits';
import { validateSettingsPatch } from '../../server/src/lib/circleSettings';
import { validateRules } from '../../server/src/lib/escalation';
import { numberLocale } from '../../server/src/lib/units';

/**
 * Le serveur ecrit lui-meme des textes : notifications, rappels, e-mails,
 * reponses du compagnon. Il ne connaissait que le francais et l'anglais, si bien
 * qu'un membre hispanophone recevait tout en francais, et que son choix de
 * langue etait meme refuse a l'enregistrement.
 */

describe('langue du serveur', () => {
    it('reconnait les trois langues, sous toutes leurs formes', () => {
        expect(pickLang('es')).toBe('es');
        expect(pickLang('es-419')).toBe('es');
        expect(pickLang('ES')).toBe('es');
        expect(pickLang('en-US')).toBe('en');
        expect(pickLang('fr')).toBe('fr');
    });

    it('retombe sur le francais pour le reste', () => {
        expect(pickLang('it')).toBe('fr');
        expect(pickLang('')).toBe('fr');
        expect(pickLang(null)).toBe('fr');
        expect(pickLang(42)).toBe('fr');
    });

    it('donne une locale de nombres a chaque langue', () => {
        expect(intlLocale('es')).toBe('es-ES');
        expect(numberLocale('es')).toBe('es-ES');
        expect(numberLocale('en')).toBe('en-US');
        expect(numberLocale(null)).toBe('fr-FR');
    });

    it('choisit la bonne variante', () => {
        expect(pick('es', { fr: 'a', en: 'b', es: 'c', de: 'd' })).toBe('c');
        expect(pick('de', { fr: 'a', en: 'b', es: 'c', de: 'd' })).toBe('d');
    });
});

// Construit depuis son code : le caractere lui-meme n'a pas sa place dans le depot.
const EM_DASH = String.fromCharCode(0x2014);

describe('messages du serveur', () => {
    it('ont exactement les memes cles dans les trois langues', () => {
        const reference = Object.keys(MESSAGES.fr).sort();
        for (const lang of LANGS) {
            expect(Object.keys(MESSAGES[lang]).sort(), lang).toEqual(reference);
        }
    });

    it('gardent les memes variables dans chaque traduction', () => {
        // L'ensemble des noms, pas leur nombre : "calendrier{{s}} trouvé{{s}}" accorde
        // deux mots en francais, "calendar{{s}} found" un seul en anglais.
        // {{s}} est un suffixe de pluriel ("calendrier{{s}}") : l'allemand forme
        // ses pluriels autrement et tourne la phrase sans lui ("Kalender gefunden: 3").
        const vars = (s: string, lang?: string) => [...new Set(s.match(/\{\{\w+\}\}/g) ?? [])]
            .filter((v) => !(lang === 'de' && v === '{{s}}'))
            .sort();
        for (const key of Object.keys(MESSAGES.fr)) {
            for (const lang of LANGS) {
                expect(vars(MESSAGES[lang][key]), `${lang} ${key}`).toEqual(vars(MESSAGES.fr[key], lang));
            }
        }
    });

    it('ne contiennent aucun tiret long', () => {
        for (const lang of LANGS) {
            for (const [key, text] of Object.entries(MESSAGES[lang])) {
                expect(text.includes(EM_DASH), `${lang} ${key}`).toBe(false);
            }
        }
    });

    it('traduisent en espagnol, avec interpolation', () => {
        expect(t('es', 'medications.nameRequired')).toBe('El nombre del medicamento es obligatorio');
        expect(t('es', 'events.move_too_far', { days: 30 })).toBe('Una repetición solo puede moverse 30 días como máximo.');
    });
});

describe('validations en espagnol', () => {
    it('reglages du cercle', () => {
        expect(validateSettingsPatch({ unit_system: 'lunaire' }, 'es').error).toBe('unit_system debe ser metric o imperial');
        expect(validateSettingsPatch({ inconnue: 1 }, 'es').error).toBe('Ajuste desconocido: inconnue');
    });

    it('regles d escalade', () => {
        expect(validateRules(null, 'es').error).toBe('Las reglas deben ser un objeto');
        expect(validateRules({ help_ack_min: -1 }, 'es').error).toMatch(/número entero de minutos/);
    });
});

describe('visites en espagnol', () => {
    it('ecrit l entree de journal, avec le bon article devant l heure', () => {
        const at = (h: number, m: number) => new Date(2026, 9, 1, h, m);
        expect(journalContent({ visitor_name: 'Lucía', visitor_type: 'nurse', checked_in_at: at(10, 30) }, 'es', 'Carmen'))
            .toBe('Lucía (enfermero/a) llegó a las 10:30 a casa de Carmen');
        expect(journalContent({ visitor_name: 'Pablo', visitor_type: 'family', checked_in_at: at(13, 0), checked_out_at: at(14, 5) }, 'es', ''))
            .toBe('Pablo (familia) llegó a las 13:00, se fue a las 14:05');
        expect(journalContent({ visitor_name: 'Ana', visitor_type: 'friend', checked_in_at: at(1, 15) }, 'es', ''))
            .toBe('Ana (amigo o vecino) llegó a la 1:15');
    });
});

const facts: CompanionFactsInput = {
    recipientFirstName: 'Carmen',
    medications: {
        due_now: [{ medication_name: 'Metformina', quantity: 2, unit: 'tablet', due_at: '2026-10-01T08:00:00' }],
        done: [],
        next_due_at: null,
    },
    events_today: [{ title: 'Cardiólogo', category: 'medical', start_time: '2026-10-01T15:30:00', location: 'Hospital' }],
    visits_today: [],
    contacts_key: [{ name: 'Dra. Ruiz', category: 'doctor', phone: '912 345 678' }],
    heatwave: null,
};

describe('compagnon en espagnol', () => {
    it('reconnait les questions du quotidien', () => {
        expect(detectIntent('¿Qué tengo que tomar?')).toBe('medications');
        expect(detectIntent('¿Quién viene hoy?')).toBe('visitors');
        expect(detectIntent('¿Tengo cita con el médico?')).toBe('appointments');
        expect(detectIntent('¿Qué hora es?')).toBe('datetime');
        expect(detectIntent('¿A quién puedo llamar?')).toBe('contacts');
        expect(detectIntent('¿Hace calor?')).toBe('weather');
    });

    it('fait passer la demande d aide avant tout le reste', () => {
        expect(detectIntent('Ayúdame, ¿qué tengo que tomar?')).toBe('help');
        expect(detectIntent('Necesito ayuda')).toBe('help');
    });

    it('ne prend pas un prenom pour une question de medicaments', () => {
        expect(detectIntent('¿Viene Tomás hoy?')).not.toBe('medications');
        expect(detectIntent('¿Quién viene hoy, Tomás?')).toBe('visitors');
    });

    it('repere une plainte', () => {
        expect(hasDistressSignal('Me duele mucho la cabeza')).toBe(true);
        expect(hasDistressSignal('Me he caído en el baño')).toBe(true);
        expect(hasDistressSignal('Hoy hace buen día')).toBe(false);
    });

    it('repond avec les memes faits, en tutoyant', () => {
        expect(answerIntent('medications', facts, 'es'))
            .toBe('Ahora tienes que tomar: Metformina, 2 comprimidos. Pulsa el botón verde cuando lo hayas hecho.');
        expect(answerIntent('appointments', facts, 'es')).toBe('Hoy tienes cita: Cardiólogo a las 15:30, Hospital.');
        expect(answerIntent('contacts', facts, 'es')).toBe('Puedes llamar a: Dra. Ruiz (médico) al 912 345 678.');
    });

    it('dit l heure avec le bon verbe', () => {
        expect(answerIntent('datetime', facts, 'es', new Date(2026, 9, 1, 10, 5))).toMatch(/, son las 10:05\.$/);
        expect(answerIntent('datetime', facts, 'es', new Date(2026, 9, 1, 1, 5))).toMatch(/, es la 1:05\.$/);
    });

    it('accorde l unite et ecrit la virgule decimale', () => {
        expect(describeIntake({ medication_name: 'Paracetamol', quantity: 1, unit: 'sachet', due_at: '' }, 'es')).toBe('Paracetamol, 1 sobre');
        expect(describeIntake({ medication_name: 'Jarabe', quantity: 2.5, unit: 'ml', due_at: '' }, 'es')).toBe('Jarabe, 2,5 ml');
    });
});

describe('allemand', () => {
    it('reconnait l allemand sous toutes ses formes', () => {
        expect(pickLang('de')).toBe('de');
        expect(pickLang('de-DE')).toBe('de');
        expect(pickLang('de-AT')).toBe('de');
        expect(pickLang('DE')).toBe('de');
        expect(intlLocale('de')).toBe('de-DE');
        expect(numberLocale('de')).toBe('de-DE');
    });

    it('traduit les messages, avec interpolation', () => {
        expect(t('de', 'medications.nameRequired')).toBe('Der Name des Medikaments ist erforderlich');
        expect(t('de', 'events.move_too_far', { days: 30 })).toBe('Ein einzelner Termin kann höchstens um 30 Tage verschoben werden.');
        expect(t('de', 'integrations.nextcloud.connected', { version: '30', count: 2, s: 's' })).toBe('Mit Nextcloud 30 verbunden: Kalender gefunden: 2');
    });

    it('n utilise ni tiret long ni tiret moyen', () => {
        const EN_DASH = String.fromCharCode(0x2013);
        for (const [key, text] of Object.entries(MESSAGES.de)) {
            expect(text.includes(EM_DASH) || text.includes(EN_DASH), key).toBe(false);
        }
    });

    it('valide les reglages et les regles en allemand', () => {
        expect(validateSettingsPatch({ unit_system: 'lunaire' }, 'de').error).toBe('unit_system muss metric oder imperial sein');
        expect(validateSettingsPatch({ inconnue: 1 }, 'de').error).toBe('Unbekannte Einstellung: inconnue');
        expect(validateRules(null, 'de').error).toBe('Die Regeln müssen ein Objekt sein');
    });

    it('ecrit l entree de journal d une visite, heure sur 24 h', () => {
        const at = (h: number, m: number) => new Date(2026, 9, 1, h, m);
        expect(journalContent({ visitor_name: 'Anna', visitor_type: 'nurse', checked_in_at: at(10, 30) }, 'de', 'Erika'))
            .toBe('Anna (Pflegekraft) ist um 10:30 Uhr gekommen, zu Besuch bei Erika');
        expect(journalContent({ visitor_name: 'Paul', visitor_type: 'family', checked_in_at: at(13, 0), checked_out_at: at(14, 5) }, 'de', ''))
            .toBe('Paul (Familie) ist um 13:00 Uhr gekommen, gegangen um 14:05 Uhr');
    });
});

const factsDe: CompanionFactsInput = {
    recipientFirstName: 'Erika',
    medications: {
        due_now: [{ medication_name: 'Metformin', quantity: 2, unit: 'tablet', due_at: '2026-10-01T08:00:00' }],
        done: [],
        next_due_at: null,
    },
    events_today: [{ title: 'Kardiologe', category: 'medical', start_time: '2026-10-01T15:30:00', location: 'Klinikum' }],
    visits_today: [],
    contacts_key: [{ name: 'Dr. Weber', category: 'doctor', phone: '030 123456' }],
    heatwave: null,
};

describe('compagnon en allemand', () => {
    it('reconnait les questions du quotidien', () => {
        expect(detectIntent('Was muss ich nehmen?')).toBe('medications');
        expect(detectIntent('Welche Tabletten heute?')).toBe('medications');
        expect(detectIntent('Wer kommt heute?')).toBe('visitors');
        expect(detectIntent('Habe ich heute einen Termin?')).toBe('appointments');
        expect(detectIntent('Wann ist mein Arzttermin?')).toBe('appointments');
        expect(detectIntent('Wie spät ist es?')).toBe('datetime');
        expect(detectIntent('Welcher Tag ist heute?')).toBe('datetime');
        expect(detectIntent('Wen kann ich anrufen?')).toBe('contacts');
        expect(detectIntent('Wie ist das Wetter?')).toBe('weather');
    });

    it('fait passer la demande d aide avant tout le reste', () => {
        expect(detectIntent('Ich brauche Hilfe, was muss ich nehmen?')).toBe('help');
        expect(detectIntent('Hilf mir bitte')).toBe('help');
    });

    it('ne confond pas l aide a domicile avec une demande d aide', () => {
        expect(detectIntent('Kommt die Haushaltshilfe heute?')).toBe('visitors');
    });

    it('repere une plainte', () => {
        expect(hasDistressSignal('Mir tut der Kopf so weh')).toBe(true);
        expect(hasDistressSignal('Ich bin im Bad gestürzt')).toBe(true);
        expect(hasDistressSignal('Heute ist ein schöner Tag')).toBe(false);
    });

    it('repond avec les memes faits, en vouvoyant', () => {
        expect(answerIntent('medications', factsDe, 'de'))
            .toBe('Jetzt sollten Sie nehmen: Metformin, 2 Tabletten. Tippen Sie auf den grünen Knopf, wenn Sie fertig sind.');
        expect(answerIntent('appointments', factsDe, 'de')).toBe('Ihre Termine heute: Kardiologe um 15:30 Uhr, Klinikum.');
        expect(answerIntent('contacts', factsDe, 'de')).toBe('Sie können anrufen: Dr. Weber (Arzt) unter 030 123456.');
        expect(answerIntent('datetime', factsDe, 'de', new Date(2026, 9, 1, 10, 5))).toBe('Heute ist Donnerstag, 1. Oktober 2026, es ist 10:05 Uhr.');
    });

    it('accorde l unite et ecrit la virgule decimale', () => {
        expect(describeIntake({ medication_name: 'Paracetamol', quantity: 1, unit: 'sachet', due_at: '' }, 'de')).toBe('Paracetamol, 1 Beutel');
        expect(describeIntake({ medication_name: 'Saft', quantity: 2.5, unit: 'ml', due_at: '' }, 'de')).toBe('Saft, 2,5 ml');
    });
});
