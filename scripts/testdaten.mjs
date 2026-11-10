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
const KONTEN = [
    { rolle: 'admin', name: 'Thomas Muster', email: 'admin@example.com' },
    { rolle: 'family', name: 'Sabine Muster', email: 'familie@example.com' },
    { rolle: 'professional', name: 'Pflegedienst Sonnenschein', email: 'fachkraft@example.com' },
    { rolle: 'neighbor', name: 'Karl Nachbar', email: 'freunde@example.com' },
    { rolle: 'recipient', name: 'Erika Muster', email: 'erika@example.com' },
];

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
    const login = await call('POST', '/api/auth/login', { email: admin.email, password: PASSWORT });
    if (login.status === 200) {
        console.log('Testdaten sind schon vorhanden.');
        console.log('Ganz neu anlegen: docker compose down -v, danach npm run precheck');
        zugangsdaten();
        return;
    }

    const reg = await call('POST', '/api/auth/register', { email: admin.email, password: PASSWORT, name: admin.name });
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
    for (const k of KONTEN.slice(1)) {
        const inv = await api('POST', '/api/invites', { role: k.rolle, invitee_email: k.email, expires_in_days: 1 });
        await must('POST', '/api/auth/register', { email: k.email, password: PASSWORT, name: k.name, inviteToken: inv.token });
    }

    // Kontakte
    await api('POST', '/api/contacts', { name: 'Dr. Paula Beispiel', category: 'doctor', organization: 'Hausarztpraxis am Park', phone: '01234 567890', address: 'Parkweg 1, 12345 Musterstadt' });
    await api('POST', '/api/contacts', { name: 'Pflegedienst Sonnenschein', category: 'nurse', phone: '01234 111222' });
    await api('POST', '/api/contacts', { name: 'Apotheke am Markt', category: 'pharmacy', phone: '01234 333444' });

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

    // Messwerte der letzten 14 Tage (gespeichert in g/L und kg)
    for (let i = 13; i >= 0; i--) {
        await api('POST', '/api/vitals', { type: 'glucose', value: (1.0 + ((i * 7) % 30) / 100).toFixed(2), unit: 'g/L', measured_at: tag(-i, 7, 30) });
        await api('POST', '/api/vitals', { type: 'weight', value: (68.5 + ((i * 3) % 8) / 10).toFixed(1), unit: 'kg', measured_at: tag(-i, 7, 35) });
        if (i % 2 === 0) {
            await api('POST', '/api/vitals', { type: 'bp', value: 130 + (i % 5) * 2, value2: 80 + (i % 3) * 2, unit: 'mmHg', measured_at: tag(-i, 8, 0) });
        }
    }

    // Aufgaben, Pinnwand, Tagebuch
    await api('POST', '/api/tasks', { title: 'Rezept für Metformin abholen', due_date: datum(3) });
    await api('POST', '/api/tasks', { title: 'Termin für die Fußpflege vereinbaren', due_date: datum(7) });
    await api('POST', '/api/tasks', { title: 'Batterien für das Hörgerät kaufen' });
    await api('POST', '/api/notes', { content: 'Die Brille liegt im Wohnzimmer auf dem Regal.', color: 'yellow' });
    await api('POST', '/api/notes', { content: 'Der Pflegedienst kommt am Freitag eine halbe Stunde später.', color: 'blue' });
    await api('POST', '/api/journal', { type: 'note', content: 'Heute gut geschlafen und mit Appetit gefrühstückt.' });

    console.log('Testdaten angelegt (Pflegekreis „Erika Muster“).');
    zugangsdaten();
}

function zugangsdaten() {
    console.log(`\nTest-Zugänge (Passwort für alle: ${PASSWORT}):`);
    for (const k of KONTEN) console.log(`  ${k.rolle.padEnd(13)} ${k.email}`);
}

main().catch((err) => {
    console.error(`Fehler beim Anlegen der Testdaten: ${err.message}`);
    process.exit(1);
});
