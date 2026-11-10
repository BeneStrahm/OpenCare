/**
 * "Demandez-moi" : reponses ancrees sur les donnees du cercle, sans IA.
 *
 * Detection d'intention par mots-cles (francais, anglais, espagnol et allemand) et phrase
 * de reponse construite a partir de l'instantane du jour : medicaments a prendre
 * maintenant, visites, rendez-vous, date et heure, personnes a appeler,
 * canicule. Le francais et l'espagnol tutoient, comme le reste de l'ecran du proche ;
 * l'allemand vouvoie ("Sie"), l'usage pour s'adresser a une personne agee.
 *
 * Module sans dependance. Une copie identique sert la demo statique
 * (client/src/demo/companionAnswers.ts) : garder les deux fichiers alignes.
 */

export type CompanionLang = 'fr' | 'en' | 'es' | 'de';
export type CompanionIntent =
    | 'help' | 'medications' | 'visitors' | 'appointments' | 'datetime' | 'contacts' | 'weather'
    // Fork: weitere feste Themen, ebenfalls ohne KI und nur aus den Daten.
    | 'medication_stock' | 'vitals_latest' | 'tasks_today' | 'appointments_week';

/** Themen mit Gesundheitsdaten: nur fuer Rollen mit Lesezugriff auf Gesundheit (und das Patienten-Geraet). */
export const HEALTH_INTENTS: readonly CompanionIntent[] = ['medications', 'appointments', 'medication_stock', 'vitals_latest'];

export type FactsVitalType = 'weight' | 'bp' | 'pain' | 'mood' | 'temperature' | 'glucose';

export interface FactsIntake {
    medication_name: string;
    dosage?: string | null;
    quantity?: number | string | null;
    unit?: string | null;
    due_at: string;
}
export interface FactsEvent {
    title: string;
    category: string;
    location?: string | null;
    start_time: string;
    members?: Array<{ name: string }>;
}
export interface FactsVisit {
    visitor_type: string;
    visitor_name: string;
    checked_in_at: string;
    checked_out_at: string | null;
}
export interface FactsContact {
    name: string;
    category: string;
    phone?: string | null;
    organization?: string | null;
}
/** Vorrat eines aktiven Medikaments (in der Einheit der Einnahmen). */
export interface FactsStock {
    name: string;
    quantity: number;
    threshold: number | null;
    unit?: string | null;
}
/** Letzter Messwert eines Typs, schon im Einheitensystem des Kreises formatiert ("72,5 kg"). */
export interface FactsVital {
    type: FactsVitalType;
    display: string;
    measured_at: string;
}
export interface FactsTask {
    title: string;
    due_date: string | null;
}
export interface CompanionFactsInput {
    recipientFirstName: string;
    medications: { due_now: FactsIntake[]; done: FactsIntake[]; next_due_at: string | null };
    events_today: FactsEvent[];
    visits_today: FactsVisit[];
    contacts_key: FactsContact[];
    heatwave: { active: boolean; level?: string } | null;
    // Fork: optionale Fakten fuer die neuen Themen. undefined/null heisst
    // "nicht geladen oder fuer diese Rolle nicht sichtbar", [] heisst "nichts eingetragen".
    medication_stock?: FactsStock[] | null;
    vitals_latest?: FactsVital[] | null;
    tasks_due?: FactsTask[] | null;
    events_week?: FactsEvent[] | null;
}

/** Minuscules, sans accents ni apostrophes : "Qu'est-ce que je dois prendre ?" -> "qu est-ce que je dois prendre ?" */
export const normalizeText = (text: string): string =>
    text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`]/g, ' ').replace(/\s+/g, ' ').trim();

// L'ordre compte : la demande d'aide passe avant tout le reste. Les motifs
// s'appliquent au texte normalise : "ayúdame" y devient "ayudame", "año" "ano".
// Pas de "toma" ni "tomar" seuls : "Tomás", une fois normalise, viendrait
// repondre medicaments a "Est-ce que Tomás vient aujourd'hui ?".
const PATTERNS: Array<[CompanionIntent, RegExp]> = [
    ['help', /\b(au secours|besoin d aide|aidez(-| )moi|aide(-| )moi|urgence|appelle (ma|la) famille|previens (ma|la) famille|help me|i need help|emergency|call (my|the) family|necesito ayuda|ayudame|socorro|auxilio|emergencia|urgencia|llama a (mi|la) familia|avisa a (mi|la) familia|ich brauche hilfe|brauche hilfe|hilf mir|helfen sie mir|notfall|notruf|ruf (meine|die) familie|rufen sie (meine|die) familie)\b/],
    // Fork: vor 'medications', weil "Welche Medikamente gehen zur Neige?" sonst dort landet.
    ['medication_stock', /\b(zur neige|neige gehen|aufgebraucht|nachkaufen|nachbestellen|vorrat|vorrate|medikamentenvorrat|running (low|out)|run out|in stock|stock left|refill|reorder|how many (pills|tablets) (are )?left|stock|reserve de medicaments|bientot fini|va manquer|racheter|queda poco|quedan pocas?|se acaba|se agota|existencias|reponer)\b/],
    // Fork: letzte Messwerte. Ohne "Schmerz" (Notfall-Signal), ohne allgemeines
    // "Temperatur" (koennte das Wetter meinen) und ohne einzelnes "Zucker" (Einkauf).
    ['vitals_latest', /\b(blutzucker|zuckerwerte?|(der|mein|meinen|den|ihr|ihren) zucker|gewicht|wiege ich|blutdruck|fieber|korpertemperatur|messwerte?|gemessen|blood sugar|glucose|sugar level|weight|how much do i weigh|blood pressure|fever|body temperature|readings?|vitals|measurements?|measured|glycemie|taux de sucre|poids|combien je pese|tension|fievre|mesures?|glucemia|azucar en (la )?sangre|nivel de azucar|peso|presion arterial|tension arterial|fiebre|mediciones)\b/],
    // Fork: offene Aufgaben (vor 'appointments', das "was steht heute an" kennt).
    ['tasks_today', /\b(aufgaben?|zu tun|zu erledigen|erledigen|to ?do|to-dos?|tasks?|chores|what needs (to be )?doing|taches?|a faire|choses a faire|tareas?|que hay que hacer|pendientes?|por hacer)\b/],
    ['medications', /\b(medicaments?|cachets?|comprimes?|gelules?|pilules?|pilulier|traitement|dois(-| )je prendre|dois prendre|faut prendre|quoi prendre|a prendre|prendre (mes|ce|quoi|quelque chose)|prises?|medications?|medicines?|pills?|tablets?|(should|do|must) i take|what (do|should) i take|my treatment|next dose|medicamentos?|medicinas?|pastillas?|comprimidos?|capsulas?|tratamiento|tengo que tomar|debo tomar|hay que tomar|que tomo|mis tomas|proxima toma|siguiente toma|dosis|medikamente?|tabletten?|pillen?|kapseln?|tropfen|arznei(en)?|muss ich (jetzt |noch |etwas )*nehmen|was (muss|soll) ich nehmen|was nehme ich|einnahmen?|nachste einnahme|meine behandlung)\b/],
    // Fork: Termine der naechsten sieben Tage, nur mit ausdruecklichem Wochenbezug.
    ['appointments_week', /\b(diese woche|dieser woche|nachste woche|nachsten tage|kommenden tage|this week|next week|coming days|next few days|next seven days|week ahead|cette semaine|semaine prochaine|prochains jours|esta semana|proxima semana|proximos dias)\b/],
    ['visitors', /\b(qui vient|qui passe|qui va venir|qui doit venir|qui est venu|qui est la|qui est passe|qui est chez moi|visites?|visiteurs?|infirmier|infirmiere|aide a domicile|aide(-| )menagere|who is coming|who comes|who came|who is here|who visited|who is visiting|visitors?|visits?|the nurse|home aide|home help|quien viene|quien va a venir|quien vino|quien ha venido|quien esta aqui|quien esta en casa|visitas?|visitantes?|enfermer[oa]|auxiliar|wer kommt|wer war (da|hier)|wer ist (da|hier)|besuch|besuche|besucher|pflegedienst|pflegerin|pfleger|haushaltshilfe)\b/],
    ['appointments', /\b(rendez(-| )vous|rdv|docteur|medecin|dentiste|kine|kinesitherapeute|specialiste|hopital|consultation|agenda|programme|prevu aujourd hui|appointments?|doctor|dentist|physio|hospital|schedule|what is planned|planned today|citas?|medic[oa]|doctora|fisio|fisioterapeuta|especialista|consulta|que tengo hoy|que hay hoy|termine?|arzttermine?|arzt|arztin|zahnarzt|hausarzt|krankenhaus|klinik|krankengymnastik|was steht (heute )?an|was ist heute geplant|was habe ich heute)\b/],
    ['datetime', /\b(quel jour|quelle date|quelle heure|on est quel|nous sommes quel|quel mois|quelle annee|le combien|what day|what date|what time|what is the date|what month|what year|the date today|que dia|que fecha|que hora|en que dia|que mes|en que mes|que ano|a cuantos estamos|welcher tag|welchen tag haben wir|welches datum|wie spat|wieviel uhr|wie viel uhr|welcher monat|welches jahr|der wievielte|den wievielten)\b/],
    ['contacts', /\b(appeler|telephoner|numero|telephone|joindre|pharmacie|(who|whom) (can|should|do) i call|phone number|call the|call my|pharmacy|how do i reach|llamar|telefonear|telefono|contactar|farmacia|a quien (puedo|debo|tengo que) llamar|anrufen|telefonieren|telefonnummer|nummer|apotheke|wen kann ich anrufen|erreichen)\b/],
    ['weather', /\b(meteo|temps qu il fait|quel temps|fait chaud|fait froid|canicule|chaleur|il pleut|pluie|weather|is it hot|is it cold|heatwave|raining|rain|que tiempo|hace calor|hace frio|ola de calor|calor|llueve|lluvia|clima|wetter|heiss|ist es warm|hitze|hitzewelle|ist es kalt|regnet|regen)\b/],
];

const DISTRESS = /\b(j ai mal|ca fait mal|douleurs?|je suis tombee?|chute|j ai peur|angoissee?|je pleure|je saigne|vertiges?|malaise|etouffe|respire mal|je me sens mal|pas bien|tres seule?|mourir|it hurts|i m hurt|in pain|i fell|fallen|i m scared|afraid|bleeding|dizzy|faint|can t breathe|i feel sick|not well|want to die|so lonely|me duele|duele|dolor(es)?|me he caido|me cai|caida|tengo miedo|angustiad[oa]|estoy llorando|sangro|estoy sangrando|mareo|maread[oa]|desmayo|me ahogo|no puedo respirar|me siento mal|no estoy bien|muy sol[oa]|morir|me quiero morir|es tut weh|tut weh|weh|schmerzt|schmerzen?|ich bin gesturzt|gesturzt|sturz|ich habe angst|angst|ich weine|ich blute|schwindel|schwindelig|mir ist schlecht|mir geht es (nicht gut|schlecht)|keine luft|kann nicht atmen|so allein|einsam|sterben|ich will sterben)\b/;

export function detectIntent(text: string): CompanionIntent | null {
    const norm = normalizeText(text);
    if (!norm) return null;
    for (const [intent, re] of PATTERNS) if (re.test(norm)) return intent;
    return null;
}

/** Signal de detresse par mots-cles : oriente vers l'IA (qui sait escalader) ou ajoute le rappel du bouton rouge. */
export const hasDistressSignal = (text: string): boolean => DISTRESS.test(normalizeText(text));

// ── Mise en forme ──

const firstNameOf = (name: string): string => (name || '').trim().split(/\s+/)[0] || '';

/** Le texte d'une langue ; le type impose les quatre variantes. */
const pick = <T>(lang: CompanionLang, variants: Record<CompanionLang, T>): T => variants[lang];

export function fmtTime(iso: string, lang: CompanionLang): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    if (lang === 'fr') return d.getMinutes() === 0 ? `${h} h` : `${h} h ${m}`;
    // English (US) reads the time on a 12-hour clock: "5:30 PM", not "17:30".
    if (lang === 'en') return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    // Deutsch: 24-Stunden-Uhr mit "Uhr", wie man es sagt: "9:30 Uhr".
    if (lang === 'de') return `${h}:${m} Uhr`;
    return `${h}:${m}`;
}

/** L'article espagnol devant une heure : "a la 1:30", "a las 10:00". */
const esArticle = (iso: string): string => (new Date(iso).getHours() === 1 ? 'la' : 'las');

/** "à 10 h", "at 10:00 AM", "a las 10:00", "um 10:00 Uhr". */
const atTime = (iso: string, lang: CompanionLang): string =>
    pick(lang, { fr: `à ${fmtTime(iso, lang)}`, en: `at ${fmtTime(iso, lang)}`, es: `a ${esArticle(iso)} ${fmtTime(iso, lang)}`, de: `um ${fmtTime(iso, lang)}` });

const fmtDate = (now: Date, lang: CompanionLang): string =>
    new Intl.DateTimeFormat(pick(lang, { fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE' }), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);

const UNIT_LABELS: Record<CompanionLang, Record<string, [string, string]>> = {
    fr: { tablet: ['comprimé', 'comprimés'], capsule: ['gélule', 'gélules'], ml: ['ml', 'ml'], drop: ['goutte', 'gouttes'], sachet: ['sachet', 'sachets'], patch: ['patch', 'patchs'], injection: ['injection', 'injections'], puff: ['bouffée', 'bouffées'], application: ['application', 'applications'], dose: ['dose', 'doses'] },
    en: { tablet: ['tablet', 'tablets'], capsule: ['capsule', 'capsules'], ml: ['ml', 'ml'], drop: ['drop', 'drops'], sachet: ['sachet', 'sachets'], patch: ['patch', 'patches'], injection: ['injection', 'injections'], puff: ['puff', 'puffs'], application: ['application', 'applications'], dose: ['dose', 'doses'] },
    es: { tablet: ['comprimido', 'comprimidos'], capsule: ['cápsula', 'cápsulas'], ml: ['ml', 'ml'], drop: ['gota', 'gotas'], sachet: ['sobre', 'sobres'], patch: ['parche', 'parches'], injection: ['inyección', 'inyecciones'], puff: ['inhalación', 'inhalaciones'], application: ['aplicación', 'aplicaciones'], dose: ['dosis', 'dosis'] },
    de: { tablet: ['Tablette', 'Tabletten'], capsule: ['Kapsel', 'Kapseln'], ml: ['ml', 'ml'], drop: ['Tropfen', 'Tropfen'], sachet: ['Beutel', 'Beutel'], patch: ['Pflaster', 'Pflaster'], injection: ['Spritze', 'Spritzen'], puff: ['Hub', 'Hübe'], application: ['Anwendung', 'Anwendungen'], dose: ['Dosis', 'Dosen'] },
};

const VISITOR_LABELS: Record<CompanionLang, Record<string, string>> = {
    fr: { family: 'famille', friend: 'ami ou voisin', caregiver: 'aide à domicile', nurse: 'soins infirmiers', doctor: 'médecin', other: '' },
    en: { family: 'family', friend: 'friend or neighbour', caregiver: 'home aide', nurse: 'nurse', doctor: 'doctor', other: '' },
    es: { family: 'familia', friend: 'amigo o vecino', caregiver: 'auxiliar a domicilio', nurse: 'enfermería', doctor: 'médico', other: '' },
    de: { family: 'Familie', friend: 'Freund oder Nachbar', caregiver: 'Haushaltshilfe', nurse: 'Pflegedienst', doctor: 'Arzt', other: '' },
};

const EVENT_LABELS: Record<CompanionLang, Record<string, string>> = {
    fr: { nurse: "l'infirmier ou l'infirmière", aide: "l'aide à domicile" },
    en: { nurse: 'the nurse', aide: 'the home aide' },
    es: { nurse: 'el enfermero o la enfermera', aide: 'la auxiliar a domicilio' },
    de: { nurse: 'der Pflegedienst', aide: 'die Haushaltshilfe' },
};

const CONTACT_LABELS: Record<CompanionLang, Record<string, string>> = {
    fr: { doctor: 'médecin', nurse: 'soins infirmiers', aide: 'aide à domicile', physio: 'kiné', pharmacy: 'pharmacie' },
    en: { doctor: 'doctor', nurse: 'nurse', aide: 'home aide', physio: 'physio', pharmacy: 'pharmacy' },
    es: { doctor: 'médico', nurse: 'enfermería', aide: 'auxiliar a domicilio', physio: 'fisio', pharmacy: 'farmacia' },
    de: { doctor: 'Arzt', nurse: 'Pflegedienst', aide: 'Haushaltshilfe', physio: 'Physiotherapie', pharmacy: 'Apotheke' },
};

const joinList = (items: string[], lang: CompanionLang): string => {
    if (items.length <= 1) return items.join('');
    const and = pick(lang, { fr: ' et ', en: ' and ', es: ' y ', de: ' und ' });
    return `${items.slice(0, -1).join(', ')}${and}${items[items.length - 1]}`;
};

/** "Metformine, 2 comprimés" (ou le dosage textuel si la quantite manque). */
export function describeIntake(intake: FactsIntake, lang: CompanionLang): string {
    const q = Number(intake.quantity);
    if (!Number.isFinite(q) || q <= 0) return intake.dosage ? `${intake.medication_name} (${intake.dosage})` : intake.medication_name;
    const labels = UNIT_LABELS[lang][intake.unit || ''];
    const qs = Number.isInteger(q) ? String(q) : String(q).replace('.', lang === 'en' ? '.' : ',');
    const label = labels ? (q > 1 ? labels[1] : labels[0]) : (intake.unit || '');
    return `${intake.medication_name}, ${qs} ${label}`.trim();
}

const eventWho = (ev: FactsEvent, lang: CompanionLang): string => {
    const names = (ev.members || []).map((m) => firstNameOf(m.name)).filter(Boolean);
    if (names.length > 0) return joinList(names, lang);
    return EVENT_LABELS[lang][ev.category] || ev.title;
};

const visitLabel = (v: FactsVisit, lang: CompanionLang): string => {
    const role = VISITOR_LABELS[lang][v.visitor_type] || '';
    return role ? `${firstNameOf(v.visitor_name)} (${role})` : firstNameOf(v.visitor_name);
};

// ── Reponses ──

function answerMedications(f: CompanionFactsInput, lang: CompanionLang): string {
    const due = f.medications.due_now.map((i) => describeIntake(i, lang));
    if (due.length > 0) {
        return pick(lang, {
            fr: `Maintenant, tu dois prendre : ${joinList(due, lang)}. Appuie sur le bouton vert quand c'est fait.`,
            en: `Right now you need to take: ${joinList(due, lang)}. Tap the green button when it is done.`,
            es: `Ahora tienes que tomar: ${joinList(due, lang)}. Pulsa el botón verde cuando lo hayas hecho.`,
            de: `Jetzt sollten Sie nehmen: ${joinList(due, lang)}. Tippen Sie auf den grünen Knopf, wenn Sie fertig sind.`,
        });
    }
    const done = f.medications.done.map((i) => i.medication_name);
    const nextIso = f.medications.next_due_at;
    const next = nextIso ? fmtTime(nextIso, lang) : '';
    const parts: string[] = [];
    if (lang === 'fr') {
        parts.push("Rien à prendre pour l'instant.");
        if (done.length > 0) parts.push(`Tu as déjà pris ${joinList(done, lang)} aujourd'hui.`);
        parts.push(next ? `Prochaine prise à ${next}.` : "Plus rien à prendre aujourd'hui.");
    } else if (lang === 'es') {
        parts.push('Nada que tomar por ahora.');
        if (done.length > 0) parts.push(`Hoy ya has tomado ${joinList(done, lang)}.`);
        parts.push(nextIso && next ? `Próxima toma ${atTime(nextIso, lang)}.` : 'No queda nada por tomar hoy.');
    } else if (lang === 'de') {
        parts.push('Im Moment ist nichts zu nehmen.');
        if (done.length > 0) parts.push(`Heute haben Sie schon genommen: ${joinList(done, lang)}.`);
        parts.push(nextIso && next ? `Nächste Einnahme ${atTime(nextIso, lang)}.` : 'Heute ist nichts mehr zu nehmen.');
    } else {
        parts.push('Nothing to take right now.');
        if (done.length > 0) parts.push(`You already took ${joinList(done, lang)} today.`);
        parts.push(next ? `Next dose at ${next}.` : 'Nothing else to take today.');
    }
    return parts.join(' ');
}

function answerVisitors(f: CompanionFactsInput, lang: CompanionLang): string {
    const planned = f.events_today
        .filter((ev) => ev.category !== 'medical')
        .map((ev) => `${eventWho(ev, lang)} ${atTime(ev.start_time, lang)}`);
    const present = f.visits_today.filter((v) => !v.checked_out_at);
    const gone = f.visits_today.filter((v) => v.checked_out_at);
    const parts: string[] = [];
    if (lang === 'fr') {
        parts.push(planned.length > 0 ? `Aujourd'hui, visites prévues : ${joinList(planned, lang)}.` : "Personne n'est prévu aujourd'hui.");
        for (const v of present) parts.push(`${visitLabel(v, lang)} est là depuis ${fmtTime(v.checked_in_at, lang)}.`);
        for (const v of gone) parts.push(`Visite de ${visitLabel(v, lang)} à ${fmtTime(v.checked_in_at, lang)}.`);
    } else if (lang === 'es') {
        parts.push(planned.length > 0 ? `Visitas previstas hoy: ${joinList(planned, lang)}.` : 'Hoy no viene nadie.');
        for (const v of present) parts.push(`${visitLabel(v, lang)} está aquí desde ${esArticle(v.checked_in_at)} ${fmtTime(v.checked_in_at, lang)}.`);
        for (const v of gone) parts.push(`Visita de ${visitLabel(v, lang)} ${atTime(v.checked_in_at, lang)}.`);
    } else if (lang === 'de') {
        parts.push(planned.length > 0 ? `Heute geplante Besuche: ${joinList(planned, lang)}.` : 'Für heute hat sich niemand angekündigt.');
        for (const v of present) parts.push(`${visitLabel(v, lang)} ist seit ${fmtTime(v.checked_in_at, lang)} da.`);
        for (const v of gone) parts.push(`Besuch von ${visitLabel(v, lang)} ${atTime(v.checked_in_at, lang)}.`);
    } else {
        parts.push(planned.length > 0 ? `Visits planned today: ${joinList(planned, lang)}.` : 'Nobody is planned today.');
        for (const v of present) parts.push(`${visitLabel(v, lang)} has been here since ${fmtTime(v.checked_in_at, lang)}.`);
        for (const v of gone) parts.push(`${visitLabel(v, lang)} visited at ${fmtTime(v.checked_in_at, lang)}.`);
    }
    return parts.join(' ');
}

function answerAppointments(f: CompanionFactsInput, lang: CompanionLang): string {
    const items = f.events_today
        .filter((ev) => ev.category === 'medical')
        .map((ev) => `${ev.title} ${atTime(ev.start_time, lang)}${ev.location ? `, ${ev.location}` : ''}`);
    if (items.length === 0) {
        return pick(lang, { fr: "Pas de rendez-vous médical aujourd'hui.", en: 'No medical appointment today.', es: 'Hoy no tienes ninguna cita médica.', de: 'Heute haben Sie keinen Arzttermin.' });
    }
    return pick(lang, {
        fr: `Tu as rendez-vous aujourd'hui : ${items.join(' ; ')}.`,
        en: `Your appointments today: ${items.join('; ')}.`,
        es: `Hoy tienes cita: ${items.join('; ')}.`,
        de: `Ihre Termine heute: ${items.join('; ')}.`,
    });
}

function answerDatetime(now: Date, lang: CompanionLang): string {
    const iso = now.toISOString();
    return pick(lang, {
        fr: `Nous sommes ${fmtDate(now, lang)}, il est ${fmtTime(iso, lang)}.`,
        en: `Today is ${fmtDate(now, lang)}, it is ${fmtTime(iso, lang)}.`,
        es: `Hoy es ${fmtDate(now, lang)}, ${esArticle(iso) === 'la' ? 'es la' : 'son las'} ${fmtTime(iso, lang)}.`,
        de: `Heute ist ${fmtDate(now, lang)}, es ist ${fmtTime(iso, lang)}.`,
    });
}

function answerContacts(f: CompanionFactsInput, lang: CompanionLang): string {
    const items = f.contacts_key.slice(0, 4).map((c) => {
        const role = CONTACT_LABELS[lang][c.category] || '';
        const who = role ? `${c.name} (${role})` : c.name;
        return c.phone ? `${who} ${pick(lang, { fr: 'au', en: 'on', es: 'al', de: 'unter' })} ${c.phone}` : who;
    });
    if (items.length === 0) {
        return pick(lang, {
            fr: "Je n'ai pas de numéro à te donner. Regarde dans « Mes informations » ou demande à ta famille.",
            en: 'I have no number to give you. Look in “My information” or ask your family.',
            es: 'No tengo ningún número que darte. Mira en «Mi información» o pregunta a tu familia.',
            de: 'Ich habe keine Nummer für Sie. Schauen Sie unter „Meine Informationen“ nach oder fragen Sie Ihre Familie.',
        });
    }
    return pick(lang, {
        fr: `Tu peux appeler : ${items.join(' ; ')}.`,
        en: `You can call: ${items.join('; ')}.`,
        es: `Puedes llamar a: ${items.join('; ')}.`,
        de: `Sie können anrufen: ${items.join('; ')}.`,
    });
}

function answerWeather(f: CompanionFactsInput, lang: CompanionLang): string {
    if (f.heatwave?.active) {
        return pick(lang, {
            fr: "Il fait très chaud en ce moment. Pense à boire de l'eau régulièrement et reste au frais.",
            en: 'It is very hot at the moment. Remember to drink water regularly and stay cool.',
            es: 'Hace mucho calor ahora mismo. Acuérdate de beber agua a menudo y quédate en un sitio fresco.',
            de: 'Es ist gerade sehr heiß. Trinken Sie regelmäßig Wasser und bleiben Sie an einem kühlen Ort.',
        });
    }
    return pick(lang, {
        fr: "La météo du jour est affichée en haut de l'écran. Je ne peux pas t'en dire plus.",
        en: 'The weather is shown at the top of the screen. I cannot tell you more.',
        es: 'El tiempo de hoy aparece arriba en la pantalla. No puedo decirte más.',
        de: 'Das Wetter von heute steht oben auf dem Bildschirm. Mehr kann ich Ihnen dazu nicht sagen.',
    });
}

// ── Fork: neue feste Themen ──

export const noAccess = (lang: CompanionLang): string => pick(lang, {
    fr: "Je n'ai pas accès à ces informations.",
    en: 'I do not have access to this information.',
    es: 'No tengo acceso a esa información.',
    de: 'Auf diese Angaben habe ich keinen Zugriff.',
});

const numberLocaleFor = (lang: CompanionLang): string => pick(lang, { fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE' });

const fmtNumber = (n: number, lang: CompanionLang): string =>
    new Intl.NumberFormat(numberLocaleFor(lang), { maximumFractionDigits: 2 }).format(n);

/** "Freitag, 6. November" bzw. "heute", "gestern" (Datum ohne Jahr, wie man es sagt). */
export function fmtDay(iso: string, lang: CompanionLang, now: Date = new Date()): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const dayKey = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (dayKey(d) === dayKey(now)) return pick(lang, { fr: "aujourd'hui", en: 'today', es: 'hoy', de: 'heute' });
    if (dayKey(d) === dayKey(yesterday)) return pick(lang, { fr: 'hier', en: 'yesterday', es: 'ayer', de: 'gestern' });
    if (dayKey(d) === dayKey(tomorrow)) return pick(lang, { fr: 'demain', en: 'tomorrow', es: 'mañana', de: 'morgen' });
    return new Intl.DateTimeFormat(numberLocaleFor(lang), { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

function stockLabel(item: FactsStock, lang: CompanionLang): string {
    const labels = UNIT_LABELS[lang][item.unit || ''];
    const label = labels ? (item.quantity === 1 ? labels[0] : labels[1]) : '';
    const amount = `${fmtNumber(item.quantity, lang)}${label ? ` ${label}` : ''}`;
    return pick(lang, {
        fr: `${item.name}, il reste ${amount}`,
        en: `${item.name}, ${amount} left`,
        es: `${item.name}, quedan ${amount}`,
        de: `${item.name}, noch ${amount}`,
    });
}

/** Ein Vorrat gilt als knapp, wenn ein Schwellwert gesetzt ist und erreicht wurde. */
export const isLowStock = (item: FactsStock): boolean =>
    item.threshold !== null && Number.isFinite(item.threshold) && item.quantity <= item.threshold;

function answerMedicationStock(f: CompanionFactsInput, lang: CompanionLang): string {
    if (!f.medication_stock) return noAccess(lang);
    if (f.medication_stock.length === 0) {
        return pick(lang, {
            fr: "Aucun stock de médicament n'est enregistré.",
            en: 'No medication stock has been entered.',
            es: 'No hay ninguna existencia de medicamentos registrada.',
            de: 'Es ist kein Vorrat für Medikamente eingetragen.',
        });
    }
    const low = f.medication_stock.filter(isLowStock).map((i) => stockLabel(i, lang));
    if (low.length > 0) {
        return pick(lang, {
            fr: `Bientôt épuisé : ${low.join(' ; ')}. Pense à renouveler.`,
            en: `Running low: ${low.join('; ')}. Remember to reorder.`,
            es: `Se acaba pronto: ${low.join('; ')}. Acuérdate de reponer.`,
            de: `Bald aufgebraucht: ${low.join('; ')}. Bitte rechtzeitig nachbestellen.`,
        });
    }
    return pick(lang, {
        fr: 'Aucun médicament ne va manquer pour le moment.',
        en: 'No medication is running low at the moment.',
        es: 'Por ahora no se acaba ningún medicamento.',
        de: 'Im Moment geht kein Medikament zur Neige.',
    });
}

const VITAL_LABELS: Record<CompanionLang, Record<FactsVitalType, string>> = {
    fr: { weight: 'Poids', bp: 'Tension', pain: 'Douleur', mood: 'Humeur', temperature: 'Température', glucose: 'Glycémie' },
    en: { weight: 'Weight', bp: 'Blood pressure', pain: 'Pain', mood: 'Mood', temperature: 'Temperature', glucose: 'Blood sugar' },
    es: { weight: 'Peso', bp: 'Tensión', pain: 'Dolor', mood: 'Ánimo', temperature: 'Temperatura', glucose: 'Glucemia' },
    de: { weight: 'Gewicht', bp: 'Blutdruck', pain: 'Schmerz', mood: 'Stimmung', temperature: 'Temperatur', glucose: 'Blutzucker' },
};

/** Welche Messwert-Typen in der Frage genannt sind (leer = alle). Stimmt mit den Mustern oben ueberein. */
export function vitalTypesInQuestion(text: string): FactsVitalType[] {
    const norm = normalizeText(text);
    const found: FactsVitalType[] = [];
    const check: Array<[FactsVitalType, RegExp]> = [
        ['glucose', /\b(blutzucker|zucker|zuckerwert|blood sugar|glucose|sugar level|glycemie|sucre|glucemia|azucar)\b/],
        ['weight', /\b(gewicht|wiege ich|weight|weigh|poids|pese|peso)\b/],
        ['bp', /\b(blutdruck|blood pressure|tension|presion|tension arterial)\b/],
        ['temperature', /\b(temperatur|fieber|temperature|fever|fievre|temperatura|fiebre)\b/],
        ['mood', /\b(stimmung|mood|humeur|animo)\b/],
    ];
    for (const [type, re] of check) if (re.test(norm)) found.push(type);
    return found;
}

function answerVitalsLatest(f: CompanionFactsInput, lang: CompanionLang, question: string, now: Date): string {
    if (!f.vitals_latest) return noAccess(lang);
    const wanted = vitalTypesInQuestion(question);
    const list = wanted.length > 0 ? f.vitals_latest.filter((v) => wanted.includes(v.type)) : f.vitals_latest;
    if (list.length === 0) {
        const what = wanted.length === 1 ? VITAL_LABELS[lang][wanted[0]] : '';
        return pick(lang, {
            fr: what ? `Aucune mesure de ${what.toLowerCase()} n'est enregistrée.` : "Aucune mesure n'est enregistrée.",
            en: what ? `No ${what.toLowerCase()} reading has been entered.` : 'No reading has been entered.',
            es: what ? `No hay ninguna medición de ${what.toLowerCase()} registrada.` : 'No hay ninguna medición registrada.',
            de: what ? `Es ist kein Wert für ${what} eingetragen.` : 'Es sind keine Messwerte eingetragen.',
        });
    }
    const items = list.map((v) => {
        const when = `${fmtDay(v.measured_at, lang, now)} ${atTime(v.measured_at, lang)}`;
        return `${VITAL_LABELS[lang][v.type]}: ${v.display} (${when})`;
    });
    return pick(lang, {
        fr: `Dernières mesures : ${items.join(' ; ')}.`,
        en: `Latest readings: ${items.join('; ')}.`,
        es: `Últimas mediciones: ${items.join('; ')}.`,
        de: `Zuletzt gemessen: ${items.join('; ')}.`,
    });
}

function answerTasksToday(f: CompanionFactsInput, lang: CompanionLang, now: Date): string {
    if (!f.tasks_due) return noAccess(lang);
    if (f.tasks_due.length === 0) {
        return pick(lang, {
            fr: "Aucune tâche n'est prévue pour aujourd'hui ni en retard.",
            en: 'No tasks are due today or overdue.',
            es: 'No hay tareas para hoy ni atrasadas.',
            de: 'Heute ist keine Aufgabe fällig, und es ist nichts überfällig.',
        });
    }
    const todayKey = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const items = f.tasks_due.slice(0, 6).map((t) => {
        if (!t.due_date) return t.title;
        const d = new Date(t.due_date);
        const overdue = !Number.isNaN(d.getTime()) && new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() < todayKey;
        return overdue ? `${t.title} (${pick(lang, { fr: 'en retard', en: 'overdue', es: 'atrasada', de: 'überfällig' })})` : t.title;
    });
    const more = f.tasks_due.length - items.length;
    const tail = more > 0 ? pick(lang, { fr: ` Et ${more} de plus.`, en: ` And ${more} more.`, es: ` Y ${more} más.`, de: ` Und ${more} weitere.` }) : '';
    return pick(lang, {
        fr: `À faire aujourd'hui ou en retard : ${items.join(' ; ')}.${tail}`,
        en: `Due today or overdue: ${items.join('; ')}.${tail}`,
        es: `Para hoy o atrasado: ${items.join('; ')}.${tail}`,
        de: `Heute fällig oder überfällig: ${items.join('; ')}.${tail}`,
    });
}

function answerAppointmentsWeek(f: CompanionFactsInput, lang: CompanionLang, now: Date): string {
    if (!f.events_week) return noAccess(lang);
    if (f.events_week.length === 0) {
        return pick(lang, {
            fr: "Aucun rendez-vous n'est prévu dans les sept prochains jours.",
            en: 'Nothing is planned for the next seven days.',
            es: 'No hay nada previsto en los próximos siete días.',
            de: 'In den nächsten sieben Tagen ist nichts eingetragen.',
        });
    }
    const items = f.events_week.slice(0, 8).map((ev) =>
        `${fmtDay(ev.start_time, lang, now)} ${atTime(ev.start_time, lang)}: ${ev.title}${ev.location ? `, ${ev.location}` : ''}`);
    const more = f.events_week.length - items.length;
    const tail = more > 0 ? pick(lang, { fr: ` Et ${more} de plus.`, en: ` And ${more} more.`, es: ` Y ${more} más.`, de: ` Und ${more} weitere.` }) : '';
    return pick(lang, {
        fr: `Les sept prochains jours : ${items.join(' ; ')}.${tail}`,
        en: `The next seven days: ${items.join('; ')}.${tail}`,
        es: `Los próximos siete días: ${items.join('; ')}.${tail}`,
        de: `Die nächsten sieben Tage: ${items.join('; ')}.${tail}`,
    });
}

export function answerHelp(lang: CompanionLang): string {
    return pick(lang, {
        fr: "Si tu as besoin d'aide, appuie sur le gros bouton rouge « J'ai besoin d'aide » : ta famille est prévenue tout de suite. Je viens aussi de lui envoyer un signal.",
        en: 'If you need help, press the big red button “I need help”: your family is alerted right away. I have also just sent them a signal.',
        es: 'Si necesitas ayuda, pulsa el botón rojo grande «Necesito ayuda»: tu familia recibe el aviso enseguida. Yo también acabo de enviarle una señal.',
        de: 'Wenn Sie Hilfe brauchen, drücken Sie den großen roten Knopf „Ich brauche Hilfe“. Dann wird Ihre Familie sofort benachrichtigt. Ich habe ihr auch gerade Bescheid gegeben.',
    });
}

export function distressHint(lang: CompanionLang): string {
    return pick(lang, {
        fr: " Si tu ne te sens pas bien, appuie sur le bouton rouge « J'ai besoin d'aide ».",
        en: ' If you do not feel well, press the red button “I need help”.',
        es: ' Si no te encuentras bien, pulsa el botón rojo «Necesito ayuda».',
        de: ' Wenn es Ihnen nicht gut geht, drücken Sie den roten Knopf „Ich brauche Hilfe“.',
    });
}

/** Ce que le compagnon sait faire sans IA (repli quand aucune intention n'est reconnue). */
export function capabilitiesReply(lang: CompanionLang): string {
    return pick(lang, {
        fr: "Je peux te dire ce que tu dois prendre, quel médicament va manquer, qui vient aujourd'hui, tes rendez-vous du jour et de la semaine, ce qu'il y a à faire, les dernières mesures, la date et qui appeler. Pose-moi une de ces questions.",
        en: 'I can tell you what to take, which medication is running low, who is coming today, your appointments today and this week, what needs doing, the latest readings, the date and who to call. Ask me one of those.',
        es: 'Puedo decirte qué tienes que tomar, qué medicamento se acaba, quién viene hoy, tus citas de hoy y de la semana, qué hay que hacer, las últimas mediciones, la fecha y a quién llamar. Hazme una de esas preguntas.',
        de: 'Ich kann Ihnen sagen, was Sie nehmen müssen, welche Medikamente zur Neige gehen, wer heute kommt, welche Termine heute und diese Woche anstehen, was zu erledigen ist, welche Werte zuletzt gemessen wurden, welches Datum heute ist und wen Sie anrufen können. Fragen Sie mich danach.',
    });
}

export function answerIntent(intent: CompanionIntent, facts: CompanionFactsInput, lang: CompanionLang, now: Date = new Date(), question = ''): string {
    switch (intent) {
        case 'help': return answerHelp(lang);
        case 'medications': return answerMedications(facts, lang);
        case 'visitors': return answerVisitors(facts, lang);
        case 'appointments': return answerAppointments(facts, lang);
        case 'datetime': return answerDatetime(now, lang);
        case 'contacts': return answerContacts(facts, lang);
        case 'weather': return answerWeather(facts, lang);
        case 'medication_stock': return answerMedicationStock(facts, lang);
        case 'vitals_latest': return answerVitalsLatest(facts, lang, question, now);
        case 'tasks_today': return answerTasksToday(facts, lang, now);
        case 'appointments_week': return answerAppointmentsWeek(facts, lang, now);
    }
}

/** Bloc "aujourd'hui" injecte dans le prompt de l'IA, pour qu'elle n'invente rien. */
export function buildTodayFacts(facts: CompanionFactsInput, lang: CompanionLang, now: Date = new Date()): string {
    const L = (fr: string, en: string, es: string, de: string): string => pick(lang, { fr, en, es, de });
    const none = L('aucun', 'none', 'ninguno', 'keine');
    const due = facts.medications.due_now.map((i) => describeIntake(i, lang));
    const done = facts.medications.done.map((i) => i.medication_name);
    const planned = facts.events_today.filter((ev) => ev.category !== 'medical').map((ev) => `${eventWho(ev, lang)} ${atTime(ev.start_time, lang)}`);
    const medical = facts.events_today.filter((ev) => ev.category === 'medical').map((ev) => `${ev.title} ${atTime(ev.start_time, lang)}${ev.location ? `, ${ev.location}` : ''}`);
    const visits = facts.visits_today.map((v) => v.checked_out_at
        ? `${visitLabel(v, lang)} ${atTime(v.checked_in_at, lang)}`
        : `${visitLabel(v, lang)} ${L('là depuis', 'here since', 'aquí desde', 'da seit')} ${fmtTime(v.checked_in_at, lang)}`);
    const contacts = facts.contacts_key.slice(0, 4).map((c) => {
        const role = CONTACT_LABELS[lang][c.category];
        return `${c.name}${role ? ` (${role})` : ''}${c.phone ? ` ${c.phone}` : ''}`;
    });
    const next = facts.medications.next_due_at ? fmtTime(facts.medications.next_due_at, lang) : '';
    return [
        `- ${L('Date et heure', 'Date and time', 'Fecha y hora', 'Datum und Uhrzeit')} : ${fmtDate(now, lang)}, ${fmtTime(now.toISOString(), lang)}`,
        `- ${L('Médicaments à prendre maintenant', 'Medication due now', 'Medicamentos que tomar ahora', 'Jetzt fällige Medikamente')} : ${due.length ? due.join(' ; ') : none}`,
        `- ${L("Déjà pris aujourd'hui", 'Already taken today', 'Ya tomados hoy', 'Heute schon genommen')} : ${done.length ? done.join(', ') : none}`,
        `- ${L('Prochaine prise', 'Next dose', 'Próxima toma', 'Nächste Einnahme')} : ${next || L("plus rien aujourd'hui", 'nothing else today', 'nada más hoy', 'heute nichts mehr')}`,
        `- ${L("Visites prévues aujourd'hui", 'Visits planned today', 'Visitas previstas hoy', 'Heute geplante Besuche')} : ${planned.length ? planned.join(' ; ') : none}`,
        `- ${L('Visiteurs passés ou présents', 'Visitors who came or are here', 'Visitantes que han venido o están aquí', 'Besuch, der da war oder da ist')} : ${visits.length ? visits.join(' ; ') : none}`,
        `- ${L('Rendez-vous médicaux', 'Medical appointments', 'Citas médicas', 'Arzttermine')} : ${medical.length ? medical.join(' ; ') : none}`,
        `- ${L('Personnes à appeler', 'People to call', 'Personas a las que llamar', 'Personen zum Anrufen')} : ${contacts.length ? contacts.join(' ; ') : none}`,
        `- ${L('Canicule en cours', 'Heatwave in progress', 'Ola de calor en curso', 'Aktuelle Hitzewelle')} : ${facts.heatwave?.active ? L('oui', 'yes', 'sí', 'ja') : L('non', 'no', 'no', 'nein')}`,
    ].join('\n');
}
