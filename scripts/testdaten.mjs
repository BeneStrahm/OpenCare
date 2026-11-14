// Legt fiktive Testdaten in einer LOKALEN Instanz an (alle Namen erfunden).
// Aufruf: node scripts/testdaten.mjs   (API_BASE ueberschreibt http://localhost:3001)
// Nur fuer den lokalen Test. Nie gegen den echten Server ausfuehren.
// Laeuft nur einmal: Gibt es das Test-Konto schon, passiert nichts.

const API = process.env.API_BASE || 'http://localhost:3001';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API)) {
    console.error(`Abbruch: ${API} ist keine lokale Adresse.`);
    process.exit(1);
}

const PASSWORT = 'Testpasswort-123';
// Anmeldung mit Benutzername = VornameNachname ohne Leerzeichen (E18)
const KONTEN = [
    { rolle: 'admin', vorname: 'Thomas', nachname: 'Muster' },
    { rolle: 'family', vorname: 'Sabine', nachname: 'Muster' },
    { rolle: 'professional', vorname: 'Petra', nachname: 'Sonnenschein' },
    { rolle: 'neighbor', vorname: 'Karl', nachname: 'Nachbar' },
    { rolle: 'recipient', vorname: 'Erika', nachname: 'Muster' },
];
const benutzername = (k) => `${k.vorname}${k.nachname}`.replace(/\s+/g, '');

async function call(method, path, body, token, circle) {
    const headers = { 'Content-Type': 'application/json', 'Accept-Language': 'de' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (circle) headers['X-Circle-Id'] = circle;
    const res = await fetch(API + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* leere Antwort */ }
    return { status: res.status, json };
}

async function must(method, path, body, token, circle) {
    const r = await call(method, path, body, token, circle);
    if (r.status < 200 || r.status >= 300) {
        throw new Error(`${method} ${path}: ${r.status} ${r.json?.error ?? ''}`);
    }
    return r.json?.data;
}

const pad = (n) => String(n).padStart(2, '0');
/** Lokaler Zeitpunkt relativ zu heute, z. B. tag(2, 10, 30) = uebermorgen 10:30 */
function tag(offset, h = 0, m = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(h)}:${pad(m)}:00`;
}
const datum = (offset) => tag(offset).slice(0, 10);

async function main() {
    const admin = KONTEN[0];

    // Schon angelegt? Dann nichts tun.
    const login = await call('POST', '/api/auth/login', { username: benutzername(admin), password: PASSWORT });
    if (login.status === 200) {
        console.log('Testdaten sind schon vorhanden.');
        console.log('Ganz neu anlegen: docker compose down -v, danach npm run precheck');
        zugangsdaten();
        return;
    }

    // Erstes Konto auf leerem Server, wird Administrator
    const reg = await call('POST', '/api/auth/register', { firstName: admin.vorname, lastName: admin.nachname, password: PASSWORT });
    if (reg.status === 403) {
        console.error('Die lokale Datenbank enthaelt schon andere Konten.');
        console.error('Lokale Daten loeschen und neu starten: docker compose down -v, danach npm run precheck');
        process.exit(1);
    }
    if (reg.status !== 200) throw new Error(`Registrierung: ${reg.status} ${reg.json?.error ?? ''}`);
    const T = reg.json.data.token;

    const circle = await must('POST', '/api/circles', { recipient_first_name: 'Erika', recipient_last_name: 'Muster' }, T);
    const C = circle.circle.id;
    const api = (method, path, body) => must(method, path, body, T, C);

    // Weitere Konten ueber Einladungen (Rolle kommt aus der Einladung)
    const tokens = {};
    for (const k of KONTEN.slice(1)) {
        const inv = await api('POST', '/api/invites', { role: k.rolle, first_name: k.vorname, last_name: k.nachname, expires_in_days: 1 });
        const neu = await must('POST', '/api/auth/register', { password: PASSWORT, inviteToken: inv.token });
        tokens[k.rolle] = neu.token;
    }

    // Kontakte
    await api('POST', '/api/contacts', { name: 'Dr. Paula Beispiel', category: 'doctor', organization: 'Hausarztpraxis am Park', phone: '01234 567890', address: 'Parkweg 1, 12345 Musterstadt' });
    await api('POST', '/api/contacts', { name: 'Pflegedienst Sonnenschein', category: 'nurse', phone: '01234 111222' });
    await api('POST', '/api/contacts', { name: 'Apotheke am Markt', category: 'pharmacy', phone: '01234 333444' });

    // Angaben zur betreuten Person (Notfallblatt, "Meine Informationen" in der einfachen Ansicht)
    await api('PUT', `/api/circles/${C}/recipient`, {
        birth_date: '1941-03-12', address: 'Lindenstraße 5, 12345 Musterstadt', phone: '01234 765432',
        blood_type: 'A+', allergies: 'Penicillin', medical_history: 'Diabetes Typ 2, Bluthochdruck',
        advance_directives: 'Liegt im Ordner im Wohnzimmerschrank.', insurance_info: 'Musterkasse, Versichertennummer A123456789',
        gp_name: 'Dr. Paula Beispiel', gp_phone: '01234 567890',
    });
    await api('GET', '/api/emergency/sheet'); // legt das Notfallblatt an
    await api('PUT', '/api/emergency/sheet', { extra_notes: 'Trägt links ein Hörgerät.' });

    // Medikamente: Tageszeit, feste Uhrzeit, bei Bedarf
    const metformin = await api('POST', '/api/medications', {
        name: 'Metformin', active_ingredient: 'Metforminhydrochlorid', dosage: '500 mg', form: 'tablet',
        with_food: 'with', reason: 'Diabetes', prescriber: 'Dr. Paula Beispiel',
        schedules: [
            { time_of_day: '08:00', quantity: 1, unit: 'tablet', time_fixed: false },
            { time_of_day: '18:00', quantity: 1, unit: 'tablet', time_fixed: false },
        ],
    });
    await api('PUT', `/api/medications/${metformin.id}/stock`, { stock_quantity: 12, stock_alert_threshold: 14 });
    const ramipril = await api('POST', '/api/medications', {
        name: 'Ramipril', active_ingredient: 'Ramipril', dosage: '5 mg', form: 'tablet',
        with_food: 'any', reason: 'Bluthochdruck', prescriber: 'Dr. Paula Beispiel',
        schedules: [{ time_of_day: '08:00', quantity: 1, unit: 'tablet', time_fixed: false }],
    });
    await api('PUT', `/api/medications/${ramipril.id}/stock`, { stock_quantity: 50, stock_alert_threshold: 10 });
    await api('POST', '/api/medications', {
        name: 'Levothyroxin', active_ingredient: 'Levothyroxin-Natrium', dosage: '50 µg', form: 'tablet',
        with_food: 'without', reason: 'Schilddrüse', instructions: '30 Minuten vor dem Frühstück',
        prescriber: 'Dr. Paula Beispiel',
        schedules: [{ time_of_day: '06:30', quantity: 1, unit: 'tablet', time_fixed: true }],
    });
    await api('POST', '/api/medications', {
        name: 'Paracetamol', active_ingredient: 'Paracetamol', dosage: '500 mg', form: 'tablet',
        prn: true, reason: 'Schmerzen, höchstens 3 am Tag',
    });

    // Termine: einzeln, wiederkehrend, mit Fahrt
    await api('POST', '/api/events', {
        title: 'Hausarzt', category: 'medical', start_time: tag(2, 10, 0), end_time: tag(2, 10, 30),
        location: 'Hausarztpraxis am Park', guests: ['Thomas Muster'],
        travel_to_minutes: 30, travel_back_minutes: 30, driver_to: 'Thomas Muster', driver_back: 'Sabine Muster',
    });
    await api('POST', '/api/events', {
        title: 'Pflegedienst', category: 'nurse', start_time: tag(0, 8, 30), end_time: tag(0, 9, 0),
        rrule: 'FREQ=WEEKLY;BYDAY=TU,FR',
    });
    await api('POST', '/api/events', {
        title: 'Besuch von Sabine', category: 'visit', start_time: tag(4, 15, 0), end_time: tag(4, 17, 0),
    });
    // Heute, damit die einfache Ansicht der betreuten Person Fahrt und Mitnehmen zeigt
    await api('POST', '/api/events', {
        title: 'Augenarzt', category: 'medical', start_time: tag(0, 15, 0), end_time: tag(0, 15, 30),
        location: 'Augenpraxis Musterstadt', guests: ['Sabine Muster'], companion_needed: true,
        travel_needed: true, travel_to_minutes: 30, travel_back_minutes: 15, driver_to: 'Sabine Muster',
        take_along: 'Versichertenkarte und Brille',
    });
    // Heute, damit "Wer heute kommt" Pflegedienst und Haushaltshilfe zeigt
    await api('POST', '/api/events', {
        title: 'Haushaltshilfe', category: 'aide', start_time: tag(0, 11, 0), end_time: tag(0, 12, 0),
    });

    // Arztgespraech in Vorbereitung, mit Kalendertermin
    const gespraech = await api('POST', '/api/consultations', {
        doctor_name: 'Dr. Max Zucker', specialty: 'Diabetologie', scheduled_at: tag(9, 11, 0),
        location: 'Diabetes-Praxis Musterstadt', reason: 'Kontrolle der Blutzuckerwerte', create_event: true,
    });
    for (const text of [
        'Sind die Werte am Morgen in Ordnung?',
        'Muss die Dosis von Metformin angepasst werden?',
        'Wie oft soll gemessen werden?',
    ]) {
        await api('POST', `/api/consultations/${gespraech.id}/questions`, { text });
    }

    // Normalbereiche wie unter Gesundheit › Normalbereich (fiktive Testwerte, Blutzucker in g/L)
    await api('PUT', '/api/vitals/thresholds', { type: 'glucose', min_value: 0.7, max_value: 1.8 });
    await api('PUT', '/api/vitals/thresholds', { type: 'bp', min_value: 100, max_value: 140, min_value2: 60, max_value2: 90, min_pulse: 50, max_pulse: 100 });
    await api('PUT', '/api/vitals/thresholds', { type: 'weight', min_value: 60, max_value: 75 });

    // Gesundheitswerte der letzten 6 Wochen (E47, E48). Eingetragen abwechselnd von Admin,
    // Familie und Fachkraft, damit Bearbeiten und Loeschen fuer alle Rollen pruefbar sind.
    // Tag 30 bis 33 ohne Werte: "Weitere laden" (nach 28 Tagen) springt ueber die Luecke.
    const schreiber = [T, tokens.family, tokens.professional];
    const jetzt = new Date();
    const vital = async (i, body) => {
        if (new Date(body.measured_at) > jetzt) return; // heute nichts in der Zukunft
        await must('POST', '/api/vitals', body, schreiber[i % 3], C);
    };
    const gL = (mgdl) => (mgdl / 100).toFixed(2);
    const ZUCKER_SLOTS = [
        { meal_time: 'morning', meal_relation: 'before', h: 7, m: 40, basis: 105 },
        { meal_time: 'morning', meal_relation: 'after', h: 9, m: 10, basis: 150 },
        { meal_time: 'noon', meal_relation: 'before', h: 12, m: 5, basis: 110 },
        { meal_time: 'noon', meal_relation: 'after', h: 13, m: 30, basis: 155 },
        { meal_time: 'evening', meal_relation: 'before', h: 18, m: 15, basis: 115 },
        { meal_time: 'evening', meal_relation: 'after', h: 19, m: 40, basis: 160 },
        { meal_time: 'late', meal_relation: null, h: 22, m: 5, basis: 130 },
    ];
    // Werte ausserhalb des Bereichs: "Tag-Slot" -> mg/dL
    const ZUCKER_AUSREISSER = { '2-5': 245, '9-3': 232, '17-1': 251, '36-5': 238, '12-6': 62 };
    const ZUCKER_BEMERKUNG = {
        2: 'Kuchen beim Kaffee', 6: 'Nach dem Spaziergang', 9: 'Geburtstagsessen',
        12: 'Etwas zittrig, Saft getrunken', 15: 'Neues Messgerät', 21: 'Wenig gegessen',
        27: 'Vor dem Arzttermin', 38: 'Nach dem Mittagsschlaf',
    };
    for (let i = 41; i >= 0; i--) {
        if (i >= 30 && i <= 33) continue;
        // Pro Tag: morgens vor dem Essen, mittags und abends abwechselnd vor/nach, jeden 3. Tag spaet
        const slots = [0, i % 2 ? 2 : 3, i % 2 ? 5 : 4];
        if (i % 4 === 1) slots.splice(1, 0, 1);
        if (i % 3 === 0) slots.push(6);
        for (const [n, s] of slots.entries()) {
            const slot = ZUCKER_SLOTS[s];
            const mgdl = ZUCKER_AUSREISSER[`${i}-${s}`] ?? slot.basis + ((i * 37 + s * 11) % 40) - 20;
            const letzter = n === slots.length - 1;
            await vital(i, {
                type: 'glucose', value: gL(mgdl), unit: 'g/L', measured_at: tag(-i, slot.h, slot.m),
                meal_time: slot.meal_time, meal_relation: slot.meal_relation,
                notes: letzter ? ZUCKER_BEMERKUNG[i] : undefined,
            });
        }
        // Zweiter Wert im selben Feld (zwei Werte untereinander)
        if (i === 8) {
            await vital(i, { type: 'glucose', value: gL(128), unit: 'g/L', measured_at: tag(-i, 8, 5), meal_time: 'morning', meal_relation: 'before', notes: 'Nachgemessen' });
        }
        // Wert ohne Tageszeit, wie am PC ohne Auswahl eingetragen
        if (i % 7 === 3) {
            await vital(i + 1, { type: 'glucose', value: gL(140 + (i % 5) * 6), unit: 'g/L', measured_at: tag(-i, 16, 0), notes: i === 10 ? 'Am PC nachgetragen' : undefined });
        }

        // Blutdruck morgens, jeden 3. Tag auch abends; jeder 4. Wert ohne Puls
        const druck = [{ h: 8, m: 0, sys: 128 + ((i * 13) % 14) - 7, dia: 78 + ((i * 7) % 10) - 5 }];
        if (i % 3 === 0) druck.push({ h: 19, m: 30, sys: 124 + ((i * 5) % 12) - 6, dia: 76 + ((i * 3) % 8) - 4 });
        if (i === 4) Object.assign(druck[0], { sys: 152, dia: 94, notiz: 'Kopfschmerzen' });
        if (i === 25) Object.assign(druck[0], { sys: 156, dia: 96, notiz: 'Tablette vergessen' });
        if (i === 12 && druck[1]) Object.assign(druck[1], { sys: 148, dia: 88 });
        if (i === 19) Object.assign(druck[0], { puls: 108, notiz: 'Nach dem Treppensteigen' });
        for (const [n, d] of druck.entries()) {
            const ohnePuls = (i + n) % 4 === 1;
            await vital(i + n, {
                type: 'bp', value: d.sys, value2: d.dia, unit: 'mmHg', measured_at: tag(-i, d.h, d.m),
                pulse: ohnePuls && !d.puls ? undefined : d.puls ?? 68 + ((i * 5) % 12), notes: d.notiz,
            });
        }

        // Gewicht jeden 2. Tag
        if (i % 2 === 0) {
            const kg = i === 14 ? 76.2 : 68.5 + ((i * 7) % 30) / 10;
            const notiz = { 14: 'Nach dem Urlaub', 22: 'Mit Schuhen gewogen', 40: 'Neue Waage' }[i];
            await vital(i + 2, { type: 'weight', value: kg.toFixed(1), unit: 'kg', measured_at: tag(-i, 7, 35), notes: notiz });
        }
    }

    // Die betreute Person traegt selbst ein. Der Server setzt die Zeit auf "jetzt" (E47),
    // Rueckgaengig geht also nur in den ersten 10 Minuten nach dem Einspielen.
    const stunde = jetzt.getHours();
    const tageszeit = stunde < 11 ? 'morning' : stunde < 16 ? 'noon' : stunde < 21 ? 'evening' : 'late';
    const selbst = (body) => must('POST', '/api/vitals', body, tokens.recipient, C);
    await selbst({ type: 'glucose', value: 2.1, meal_time: tageszeit, meal_relation: tageszeit === 'late' ? null : 'after', notes: 'Selbst gemessen' });
    await selbst({ type: 'weight', value: 70.4 });
    await selbst({ type: 'bp', value: 142, value2: 86, pulse: 72 });

    // Aufgaben, Pinnwand, Tagebuch
    await api('POST', '/api/tasks', { title: 'Rezept für Metformin abholen', due_date: datum(3) });
    await api('POST', '/api/tasks', { title: 'Termin für die Fußpflege vereinbaren', due_date: datum(7) });
    await api('POST', '/api/tasks', { title: 'Batterien für das Hörgerät kaufen' });
    // Einkaufsliste: drei offen, einer erledigt
    for (const name of ['Milch', 'Vollkornbrot', 'Äpfel']) await api('POST', '/api/shopping', { name });
    const kaffee = await api('POST', '/api/shopping', { name: 'Kaffee' });
    await api('PUT', `/api/shopping/${kaffee.id}`, { is_checked: true });
    await api('POST', '/api/notes', { content: 'Die Brille liegt im Wohnzimmer auf dem Regal.', color: 'yellow' });
    await api('POST', '/api/notes', { content: 'Der Pflegedienst kommt am Freitag eine halbe Stunde später.', color: 'blue' });
    await api('POST', '/api/journal', { type: 'note', content: 'Heute gut geschlafen und mit Appetit gefrühstückt.' });

    console.log('Testdaten angelegt (Pflegekreis „Erika Muster“).');
    zugangsdaten();
}

function zugangsdaten() {
    console.log(`\nTest-Zugänge (Passwort für alle: ${PASSWORT}):`);
    for (const k of KONTEN) console.log(`  ${k.rolle.padEnd(13)} ${benutzername(k)}`);
}

main().catch((err) => {
    console.error(`Fehler beim Anlegen der Testdaten: ${err.message}`);
    process.exit(1);
});
