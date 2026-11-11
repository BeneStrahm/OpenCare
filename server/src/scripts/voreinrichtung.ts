/**
 * Voreinrichtung (Launch-Plan Block F).
 *
 * Legt auf einem LEEREN Server aus einer JSON-Datei an:
 *  - den Pflegekreis mit der betreuten Person,
 *  - je eine Einladung fuer die betreute Person (Rolle recipient) und jedes Mitglied,
 *  - Messwert-Erinnerungen (vital_reminders), Kontakte und Medikamente.
 *
 * Ablauf: Erst wird die ganze Datei geprueft. Gibt es Fehler, werden alle in
 * einfachen Worten gemeldet und nichts wird angelegt. Danach laeuft alles in
 * EINER Transaktion: alles oder nichts.
 *
 * Ausgabe: nur Namen, Rollen und Einladungslinks. Keine Gesundheitsdaten,
 * auch nicht in Fehlermeldungen (Medikamente und Kontakte nur mit Nummer).
 *
 * Aufruf im Server-Container (Datei kommt ueber die Standardeingabe, wird nicht gespeichert):
 *   docker compose exec -T server node server/dist/scripts/voreinrichtung.js - < /root/voreinrichtung.json
 * Nur pruefen, nichts anlegen:
 *   docker compose exec -T server node server/dist/scripts/voreinrichtung.js --pruefen - < /root/voreinrichtung.json
 */
import fs from 'fs';
import crypto from 'crypto';
import { buildUsername, MAX_NAME_PART_LENGTH } from '../lib/normalize';

// Gleiche Sperre wie beim allerersten Konto (routes/auth.ts, BOOTSTRAP_LOCK_KEY):
// Voreinrichtung und Anlegen des ersten Kontos koennen nicht gleichzeitig laufen.
const BOOTSTRAP_LOCK_KEY = 4180018;

// Gueltigkeit der Einladungen (die App erlaubt 1 bis 30 Tage).
const INVITE_DAYS = 14;

// Standarduhrzeiten der Tageszeiten, wie im Formular (client/src/pages/Medications.tsx, MOMENT_TIMES).
const TAGESZEITEN: Record<string, string> = {
    morgens: '08:00',
    mittags: '12:00',
    abends: '18:00',
    zur_nacht: '22:00',
};

const ROLLEN: Record<string, string> = {
    admin: 'Administrator',
    family: 'Familie',
    professional: 'Fachkraft',
    neighbor: 'Freunde',
};

const MESSWERTE: Record<string, 'glucose' | 'weight'> = {
    blutzucker: 'glucose',
    gewicht: 'weight',
};

// Kategorien wie shared/src/constants.ts (CONTACT_CATEGORIES)
const KATEGORIEN: Record<string, string> = {
    arzt: 'doctor',
    pflegedienst: 'nurse',
    betreuung: 'aide',
    physiotherapie: 'physio',
    apotheke: 'pharmacy',
    familie: 'family',
    nachbarn: 'neighbor',
    sonstige: 'other',
};

// Einheit der Einnahme -> Darreichungsform (MEDICATION_FORMS) und Einheit (MEDICATION_UNITS),
// passend zu DEFAULT_UNIT_BY_FORM in client/src/lib/medications.ts.
const EINHEITEN: Record<string, { form: string; unit: string }> = {
    tablette: { form: 'tablet', unit: 'tablet' },
    kapsel: { form: 'capsule', unit: 'capsule' },
    ml: { form: 'syrup', unit: 'ml' },
    tropfen: { form: 'drops', unit: 'drop' },
    beutel: { form: 'sachet', unit: 'sachet' },
    pflaster: { form: 'patch', unit: 'patch' },
    spritze: { form: 'injection', unit: 'injection' },
    hub: { form: 'inhaler', unit: 'puff' },
    anwendung: { form: 'cream', unit: 'application' },
    dosis: { form: 'other', unit: 'dose' },
};

const ZUM_ESSEN: Record<string, string> = { mit: 'with', ohne: 'without', egal: 'any' };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Adresse der App fuer die Links: APP_URL, sonst die erste Adresse aus CORS_ORIGINS (wie bisher lib/mailer.ts). */
function appUrl(): string {
    const explicit = process.env.APP_URL?.trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    const first = process.env.CORS_ORIGINS?.split(',')[0]?.trim();
    return (first || 'http://localhost:5173').replace(/\/+$/, '');
}

// ── Gepruefte Daten ──

interface Person { vorname: string; nachname: string; username: string; rolle: string }
interface Erinnerung { type: 'glucose' | 'weight'; time: string; note: string | null }
interface Kontakt {
    name: string; category: string; organization: string | null; phone: string | null; phone2: string | null;
    email: string | null; address: string | null; has_key: boolean; notes: string | null;
}
interface Einnahme { time_of_day: string; time_fixed: boolean; days: number[]; quantity: number }
interface Medikament {
    name: string; active_ingredient: string | null; dosage: string | null; form: string; unit: string;
    reason: string | null; appearance: string | null; prescriber: string | null; with_food: string | null;
    prn: boolean; stock: number | null; instructions: string | null; einnahmen: Einnahme[];
}
interface Plan {
    betreut: Person; mitglieder: Person[]; erinnerungen: Erinnerung[]; kontakte: Kontakt[]; medikamente: Medikament[];
}

// ── Pruefung ──

class Pruefer {
    fehler: string[] = [];

    melde(ort: string, text: string) {
        this.fehler.push(`${ort}: ${text}`);
    }

    /** Erlaubte Felder; Felder mit "_" am Anfang sind Hinweise und werden uebersprungen. */
    nurBekannte(obj: Record<string, unknown>, erlaubt: string[], ort: string) {
        for (const key of Object.keys(obj)) {
            if (key.startsWith('_')) continue;
            if (!erlaubt.includes(key)) {
                this.melde(ort, `Das Feld "${key}" kenne ich nicht. Erlaubt sind: ${erlaubt.join(', ')}.`);
            }
        }
    }

    /** Text: fehlt oder "" ergibt null. */
    text(obj: Record<string, unknown>, key: string, ort: string, max: number, pflicht = false): string | null {
        const raw = obj[key];
        if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
            if (pflicht) this.melde(ort, `"${key}" fehlt. Bitte ausfüllen.`);
            return null;
        }
        if (typeof raw !== 'string') {
            this.melde(ort, `"${key}" muss ein Text in Anführungszeichen sein.`);
            return null;
        }
        const value = raw.replace(/\s+/g, ' ').trim();
        if (value.length > max) {
            this.melde(ort, `"${key}" ist zu lang (höchstens ${max} Zeichen, jetzt ${value.length}).`);
            return null;
        }
        return value;
    }

    jaNein(obj: Record<string, unknown>, key: string, ort: string): boolean {
        const raw = obj[key];
        if (raw === undefined || raw === null) return false;
        if (typeof raw !== 'boolean') {
            this.melde(ort, `"${key}" muss true oder false sein (ohne Anführungszeichen).`);
            return false;
        }
        return raw;
    }

    auswahl(obj: Record<string, unknown>, key: string, ort: string, werte: string[], pflicht: boolean): string | null {
        const value = this.text(obj, key, ort, 50, pflicht);
        if (value === null) return null;
        const lower = value.toLowerCase();
        if (!werte.includes(lower)) {
            this.melde(ort, `"${key}" ist "${value}". Erlaubt sind: ${werte.join(', ')}.`);
            return null;
        }
        return lower;
    }

    liste(obj: Record<string, unknown>, key: string, ort: string): Record<string, unknown>[] {
        const raw = obj[key];
        if (raw === undefined || raw === null) return [];
        if (!Array.isArray(raw)) {
            this.melde(ort, `"${key}" muss eine Liste in eckigen Klammern [ ] sein.`);
            return [];
        }
        return raw.map((item, i) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                this.melde(ort, `Eintrag ${i + 1} in "${key}" muss in geschweiften Klammern { } stehen.`);
                return {};
            }
            return item as Record<string, unknown>;
        });
    }

    person(obj: Record<string, unknown>, ort: string, rolle: string | null): Person | null {
        const vorname = this.text(obj, 'vorname', ort, MAX_NAME_PART_LENGTH, true);
        const nachname = this.text(obj, 'nachname', ort, MAX_NAME_PART_LENGTH, true);
        if (!vorname || !nachname) return null;
        const username = buildUsername(vorname, nachname);
        if (!username) {
            this.melde(ort, 'Vorname und Nachname ergeben keinen gültigen Benutzernamen.');
            return null;
        }
        return { vorname, nachname, username, rolle: rolle ?? 'recipient' };
    }
}

function pruefe(data: unknown): { plan?: Plan; fehler: string[] } {
    const p = new Pruefer();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { fehler: ['Die Datei muss mit { beginnen und mit } enden.'] };
    }
    const root = data as Record<string, unknown>;
    p.nurBekannte(root, ['betreute_person', 'mitglieder', 'messwert_erinnerungen', 'kontakte', 'medikamente'], 'Datei');

    // Betreute Person
    let betreut: Person | null = null;
    const bp = root.betreute_person;
    if (!bp || typeof bp !== 'object' || Array.isArray(bp)) {
        p.melde('Betreute Person', '"betreute_person" fehlt oder steht nicht in geschweiften Klammern { }.');
    } else {
        p.nurBekannte(bp as Record<string, unknown>, ['vorname', 'nachname'], 'Betreute Person');
        betreut = p.person(bp as Record<string, unknown>, 'Betreute Person', null);
    }

    // Mitglieder
    const mitglieder: Person[] = [];
    const rohMitglieder = p.liste(root, 'mitglieder', 'Mitglieder');
    rohMitglieder.forEach((m, i) => {
        const ort = `Mitglied ${i + 1}`;
        p.nurBekannte(m, ['vorname', 'nachname', 'rolle'], ort);
        const rolle = p.auswahl(m, 'rolle', ort, Object.keys(ROLLEN), true);
        const person = p.person(m, ort, rolle);
        if (person && rolle) mitglieder.push(person);
    });
    if (rohMitglieder.length > 0 && !rohMitglieder.some((m) => String(m.rolle ?? '').toLowerCase() === 'admin')) {
        p.melde('Mitglieder', 'Mindestens ein Mitglied braucht die Rolle "admin". Sonst kann niemand einladen oder einstellen.');
    }
    if (rohMitglieder.length === 0) {
        p.melde('Mitglieder', 'Es ist kein Mitglied eingetragen. Mindestens eine Person mit der Rolle "admin" ist nötig.');
    }

    // Benutzernamen muessen eindeutig sein (ohne Gross-/Kleinschreibung, wie in der App)
    const gesehen = new Map<string, string>();
    const alle: [string, Person | null][] = [['Betreute Person', betreut], ...mitglieder.map((m, i): [string, Person] => [`Mitglied ${i + 1}`, m])];
    for (const [ort, person] of alle) {
        if (!person) continue;
        const key = person.username.toLowerCase();
        const vorher = gesehen.get(key);
        if (vorher) {
            p.melde(ort, `"${person.username}" gibt es schon bei ${vorher}. Jeder Benutzername darf nur einmal vorkommen, z. B. mit zweitem Vornamen unterscheiden.`);
        } else {
            gesehen.set(key, ort);
        }
    }

    // Messwert-Erinnerungen
    const erinnerungen: Erinnerung[] = [];
    p.liste(root, 'messwert_erinnerungen', 'Messwert-Erinnerungen').forEach((e, i) => {
        const ort = `Messwert-Erinnerung ${i + 1}`;
        p.nurBekannte(e, ['messwert', 'uhrzeit', 'hinweis'], ort);
        const messwert = p.auswahl(e, 'messwert', ort, Object.keys(MESSWERTE), true);
        const uhrzeit = p.text(e, 'uhrzeit', ort, 5, true);
        if (uhrzeit !== null && !TIME_RE.test(uhrzeit)) {
            p.melde(ort, `"uhrzeit" ist "${uhrzeit}". Bitte so schreiben: "07:30".`);
        }
        const note = p.text(e, 'hinweis', ort, 80);
        if (!messwert || !uhrzeit || !TIME_RE.test(uhrzeit)) return;
        const type = MESSWERTE[messwert];
        if (erinnerungen.some((x) => x.type === type)) {
            p.melde(ort, `Für "${messwert}" gibt es schon eine Erinnerung. Pro Messwert geht nur eine.`);
            return;
        }
        erinnerungen.push({ type, time: uhrzeit, note });
    });

    // Kontakte
    const kontakte: Kontakt[] = [];
    p.liste(root, 'kontakte', 'Kontakte').forEach((k, i) => {
        const ort = `Kontakt ${i + 1}`;
        const fehlerVorher = p.fehler.length;
        p.nurBekannte(k, ['name', 'kategorie', 'praxis_oder_firma', 'telefon', 'telefon2', 'email', 'adresse', 'hat_schluessel', 'notizen'], ort);
        const name = p.text(k, 'name', ort, 255, true);
        const kategorie = p.auswahl(k, 'kategorie', ort, Object.keys(KATEGORIEN), false) ?? 'sonstige';
        const email = p.text(k, 'email', ort, 255);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            p.melde(ort, '"email" sieht nicht wie eine E-Mail-Adresse aus. Bitte prüfen oder leer lassen.');
        }
        const kontakt: Kontakt = {
            name: name ?? '',
            category: KATEGORIEN[kategorie],
            organization: p.text(k, 'praxis_oder_firma', ort, 255),
            phone: p.text(k, 'telefon', ort, 30),
            phone2: p.text(k, 'telefon2', ort, 30),
            email,
            address: p.text(k, 'adresse', ort, 2000),
            has_key: p.jaNein(k, 'hat_schluessel', ort),
            notes: p.text(k, 'notizen', ort, 2000),
        };
        if (p.fehler.length === fehlerVorher) kontakte.push(kontakt);
    });

    // Medikamente
    const medikamente: Medikament[] = [];
    p.liste(root, 'medikamente', 'Medikamente').forEach((m, i) => {
        const ort = `Medikament ${i + 1}`;
        const fehlerVorher = p.fehler.length;
        p.nurBekannte(m, ['name', 'wirkstoff', 'staerke', 'einheit', 'wofuer', 'aussehen', 'verordnet_von', 'zum_essen', 'bei_bedarf', 'vorrat', 'hinweise', 'einnahmen'], ort);
        const name = p.text(m, 'name', ort, 255, true);
        const einheit = p.auswahl(m, 'einheit', ort, Object.keys(EINHEITEN), true);
        const zumEssen = p.auswahl(m, 'zum_essen', ort, Object.keys(ZUM_ESSEN), false);
        const prn = p.jaNein(m, 'bei_bedarf', ort);

        let stock: number | null = null;
        const vorrat = m.vorrat;
        if (vorrat !== undefined && vorrat !== null && vorrat !== '') {
            if (typeof vorrat !== 'number' || !Number.isFinite(vorrat) || vorrat < 0 || vorrat > 999999) {
                p.melde(ort, '"vorrat" muss eine Zahl ohne Anführungszeichen sein (z. B. 60), oder null, wenn unbekannt.');
            } else {
                stock = Math.round(vorrat * 100) / 100;
            }
        }

        const einnahmen: Einnahme[] = [];
        const rohEinnahmen = p.liste(m, 'einnahmen', ort);
        if (prn && rohEinnahmen.length > 0) {
            p.melde(ort, 'Bei "bei_bedarf": true bleibt "einnahmen" leer: [].');
        }
        if (!prn && rohEinnahmen.length === 0) {
            p.melde(ort, 'Es gibt keine Einnahme. Bitte mindestens eine eintragen, oder "bei_bedarf": true setzen.');
        }
        if (!prn) {
            rohEinnahmen.forEach((e, j) => {
                const eOrt = `${ort}, Einnahme ${j + 1}`;
                p.nurBekannte(e, ['tageszeit', 'uhrzeit', 'menge', 'tage'], eOrt);
                const vorhanden = (v: unknown) => v !== undefined && v !== null && v !== '';
                const hatTageszeit = vorhanden(e.tageszeit);
                const hatUhrzeit = vorhanden(e.uhrzeit);
                let time: string | null = null;
                let fixed = false;
                if (hatTageszeit === hatUhrzeit) {
                    p.melde(eOrt, 'Bitte genau eines angeben: "tageszeit" oder "uhrzeit".');
                } else if (hatTageszeit) {
                    const tz = p.auswahl(e, 'tageszeit', eOrt, Object.keys(TAGESZEITEN), true);
                    if (tz) time = TAGESZEITEN[tz];
                } else {
                    const uz = p.text(e, 'uhrzeit', eOrt, 5, true);
                    if (uz && !TIME_RE.test(uz)) {
                        p.melde(eOrt, `"uhrzeit" ist "${uz}". Bitte so schreiben: "07:00".`);
                    } else if (uz) {
                        time = uz;
                        fixed = true;
                    }
                }

                let quantity = 1;
                const menge = e.menge;
                if (menge !== undefined && menge !== null) {
                    if (typeof menge !== 'number' || !Number.isFinite(menge) || menge <= 0 || menge > 99) {
                        p.melde(eOrt, '"menge" muss eine Zahl zwischen 0.5 und 99 sein, ohne Anführungszeichen, mit Punkt statt Komma.');
                    } else {
                        quantity = Math.round(menge * 100) / 100;
                    }
                }

                let days = [1, 2, 3, 4, 5, 6, 7];
                const tage = e.tage;
                if (tage !== undefined && tage !== null) {
                    if (!Array.isArray(tage) || tage.length === 0 || !tage.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
                        p.melde(eOrt, '"tage" muss eine Liste mit Zahlen von 1 (Montag) bis 7 (Sonntag) sein, z. B. [1,3,5].');
                    } else {
                        days = [...new Set(tage as number[])].sort((a, b) => a - b);
                    }
                }
                if (time) einnahmen.push({ time_of_day: time, time_fixed: fixed, days, quantity });
            });
        }

        const felder = {
            active_ingredient: p.text(m, 'wirkstoff', ort, 255),
            dosage: p.text(m, 'staerke', ort, 100),
            reason: p.text(m, 'wofuer', ort, 500),
            appearance: p.text(m, 'aussehen', ort, 500),
            prescriber: p.text(m, 'verordnet_von', ort, 255),
            instructions: p.text(m, 'hinweise', ort, 2000),
        };
        if (p.fehler.length > fehlerVorher || !name || !einheit) return;
        medikamente.push({
            name,
            ...felder,
            form: EINHEITEN[einheit].form,
            unit: EINHEITEN[einheit].unit,
            with_food: zumEssen ? ZUM_ESSEN[zumEssen] : null,
            prn,
            stock,
            einnahmen,
        });
    });

    if (p.fehler.length > 0 || !betreut) return { fehler: p.fehler };
    return { plan: { betreut, mitglieder, erinnerungen, kontakte, medikamente }, fehler: [] };
}

// ── Einlesen ──

function lies(pfad: string): string {
    return pfad === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(pfad, 'utf8');
}

function parseJson(text: string): { data?: unknown; fehler?: string } {
    try {
        return { data: JSON.parse(text.replace(/^﻿/, '')) };
    } catch (error) {
        const msg = error instanceof Error ? error.message : '';
        const pos = /position (\d+)/.exec(msg);
        const zeile = pos ? text.slice(0, Number(pos[1])).split('\n').length : null;
        return {
            fehler: `Die Datei ist kein gültiges JSON${zeile ? ` (Fehler in Zeile ${zeile} oder kurz davor)` : ''}. `
                + 'Häufige Ursachen: Komma nach dem letzten Eintrag einer Liste, fehlendes Komma zwischen zwei Einträgen, '
                + 'fehlendes Anführungszeichen, oder deutsche Anführungszeichen „ “ statt " ".',
        };
    }
}

// ── Anlegen ──

interface Link { name: string; rolle: string; link: string }

async function legeAn(plan: Plan): Promise<{ links?: Link[]; nichtLeer?: string[] }> {
    // Erst hier laden: Die reine Pruefung braucht keine Datenbank.
    const { getClient } = await import('../db');
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);

        const belegt: string[] = [];
        for (const [tabelle, text] of [['users', 'Konten'], ['care_circles', 'Pflegekreise'], ['circle_invites', 'Einladungen']] as const) {
            const r = await client.query(`SELECT 1 FROM ${tabelle} LIMIT 1`);
            if (r.rows.length > 0) belegt.push(text);
        }
        if (belegt.length > 0) {
            await client.query('ROLLBACK');
            return { nichtLeer: belegt };
        }

        const circle = await client.query(
            `INSERT INTO care_circles (name, created_by) VALUES ($1, NULL) RETURNING id`,
            [plan.betreut.vorname]
        );
        const circleId: string = circle.rows[0].id;

        await client.query(
            'INSERT INTO care_recipients (circle_id, first_name, last_name) VALUES ($1, $2, $3)',
            [circleId, plan.betreut.vorname, plan.betreut.nachname]
        );

        const links: Link[] = [];
        const basis = appUrl();
        for (const person of [plan.betreut, ...plan.mitglieder]) {
            const token = crypto.randomBytes(32).toString('hex');
            await client.query(
                `INSERT INTO circle_invites (circle_id, created_by, token, invitee_username, role, expires_at)
                 VALUES ($1, NULL, $2, $3, $4, NOW() + ($5 || ' days')::interval)`,
                [circleId, token, person.username, person.rolle, String(INVITE_DAYS)]
            );
            links.push({
                name: person.username,
                rolle: person.rolle === 'recipient' ? 'Betreute Person' : ROLLEN[person.rolle],
                link: `${basis}/join?token=${token}`,
            });
        }

        // Wie saveVitalReminderSetting (lib/vitalReminders.ts), hier in derselben Transaktion.
        for (const e of plan.erinnerungen) {
            await client.query(
                `INSERT INTO vital_reminders (circle_id, type, enabled, remind_time, note)
                 VALUES ($1, $2, TRUE, $3::time, $4)`,
                [circleId, e.type, e.time, e.note]
            );
        }

        for (const k of plan.kontakte) {
            await client.query(
                `INSERT INTO contacts (circle_id, name, category, organization, phone, phone2, email, address, has_key, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [circleId, k.name, k.category, k.organization, k.phone, k.phone2, k.email, k.address, k.has_key, k.notes]
            );
        }

        // Wie POST /api/medications (routes/medications.ts) und PUT /:id/stock.
        for (const m of plan.medikamente) {
            const med = await client.query(
                `INSERT INTO medications (circle_id, name, dosage, form, instructions, prescriber,
                                          prn, with_food, reason, appearance, active_ingredient,
                                          stock_quantity, stock_updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric,
                         CASE WHEN $12::numeric IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)
                 RETURNING id`,
                [circleId, m.name, m.dosage, m.form, m.instructions, m.prescriber,
                    m.prn, m.with_food, m.reason, m.appearance, m.active_ingredient, m.stock]
            );
            for (const e of m.einnahmen) {
                await client.query(
                    `INSERT INTO medication_schedules (medication_id, time_of_day, days_of_week, label, quantity, unit, time_fixed)
                     VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
                    [med.rows[0].id, e.time_of_day, JSON.stringify(e.days), e.quantity, m.unit, e.time_fixed]
                );
            }
        }

        await client.query('COMMIT');
        return { links };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

// ── Start ──

async function main(): Promise<number> {
    const args = process.argv.slice(2);
    const nurPruefen = args.includes('--pruefen');
    const pfad = args.find((a) => a !== '--pruefen');
    if (!pfad) {
        console.error('Bitte die Datei angeben, z. B.:  node server/dist/scripts/voreinrichtung.js - < /root/voreinrichtung.json');
        return 2;
    }

    let text: string;
    try {
        text = lies(pfad);
    } catch {
        console.error(`Die Datei "${pfad}" konnte nicht gelesen werden. Stimmt der Pfad?`);
        return 2;
    }

    const parsed = parseJson(text);
    if (parsed.fehler) {
        console.error(parsed.fehler);
        console.error('Es wurde nichts angelegt.');
        return 1;
    }

    const { plan, fehler } = pruefe(parsed.data);
    if (!plan) {
        console.error(`In der Datei ${fehler.length === 1 ? 'ist 1 Fehler' : `sind ${fehler.length} Fehler`}:`);
        for (const f of fehler) console.error(`  - ${f}`);
        console.error('Bitte korrigieren und noch einmal starten. Es wurde nichts angelegt.');
        return 1;
    }

    const anzahl = `${1 + plan.mitglieder.length} Personen, ${plan.erinnerungen.length} Messwert-Erinnerungen, `
        + `${plan.kontakte.length} Kontakte, ${plan.medikamente.length} Medikamente`;
    if (nurPruefen) {
        console.log(`Die Datei ist in Ordnung: ${anzahl}. Es wurde nichts angelegt (nur geprüft).`);
        return 0;
    }

    let ergebnis: Awaited<ReturnType<typeof legeAn>>;
    try {
        ergebnis = await legeAn(plan);
    } catch (error) {
        console.error('Beim Anlegen gab es einen Fehler in der Datenbank. Es wurde nichts angelegt.');
        console.error('Läuft die App (docker compose ps)? Sie muss einmal gestartet sein, damit alle Tabellen da sind.');
        console.error(`Technische Meldung: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }

    if (ergebnis.nichtLeer) {
        console.error(`Der Server ist nicht leer (vorhanden: ${ergebnis.nichtLeer.join(', ')}).`);
        console.error('Die Voreinrichtung läuft nur auf einem neu eingerichteten Server. Es wurde nichts angelegt.');
        return 1;
    }

    console.log(`Fertig: ${anzahl} angelegt.`);
    console.log(`Einladungslinks (gültig ${INVITE_DAYS} Tage, jeder Link nur einmal nutzbar).`);
    console.log('Bitte nur an die jeweilige Person weitergeben:');
    console.log('');
    for (const l of ergebnis.links ?? []) {
        console.log(`${l.name} (${l.rolle})`);
        console.log(`  ${l.link}`);
        console.log('');
    }
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error('Unerwarteter Fehler. Es wurde nichts angelegt.');
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
