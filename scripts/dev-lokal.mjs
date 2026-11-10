// Lokaler Entwicklungsmodus: Aenderungen erscheinen nach etwa einer Sekunde im Browser.
//   npm run dev:lokal
// Startet nur die Datenbank in Docker (Port nur an 127.0.0.1), dann Server und Oberflaeche
// direkt auf dem Rechner (npm run dev). Legt beim ersten Start die Testdaten an.
// Braucht Node 20+ und Docker Desktop (gestartet). Vor dem Commit weiterhin npm run precheck.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://localhost:3001';
const LOG = join(root, 'dev-lokal.log');
const COMPOSE = 'docker compose -f docker-compose.yml -f docker-compose.dev.yml';

function run(title, cmd) {
    console.log(`\n=== ${title} ===`);
    const r = spawnSync(cmd, { cwd: root, stdio: 'inherit', shell: true });
    if (r.status !== 0) {
        console.error(`\nFEHLER bei: ${title}. Abgebrochen.`);
        process.exit(1);
    }
}

function readEnv(file) {
    const werte = {};
    for (const zeile of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = zeile.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) werte[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return werte;
}

async function waitForServer(maxSeconds) {
    for (let i = 0; i < maxSeconds; i += 2) {
        try {
            const res = await fetch(`${API}/health`);
            if (res.ok) return true;
        } catch { /* Server startet noch */ }
        await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
}

// 1. .env im Hauptordner (fuer Docker), wie bei npm run precheck
const rootEnv = join(root, '.env');
if (!existsSync(rootEnv)) {
    copyFileSync(join(root, '.env.demo'), rootEnv);
    console.log('.env aus .env.demo angelegt (nur fuer den lokalen Test).');
}

// 2. server/.env fuer npm run dev, Passwort und Schluessel aus der .env im Hauptordner
const serverEnv = join(root, 'server', '.env');
if (!existsSync(serverEnv)) {
    const quelle = readEnv(rootEnv);
    const uebernehmen = ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'JWT_SECRET',
        'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];
    let text = readFileSync(join(root, 'server', '.env.example'), 'utf8');
    for (const name of uebernehmen) {
        if (quelle[name]) text = text.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${quelle[name]}`);
    }
    writeFileSync(serverEnv, text);
    console.log('server/.env aus server/.env.example angelegt (nur fuer diesen Rechner).');
}

// 3. Gemeinsames Paket einmal bauen, falls noch nicht geschehen
if (!existsSync(join(root, 'shared', 'dist', 'index.js'))) {
    run('Gemeinsames Paket bauen', 'npm run build:shared');
}

// 4. Docker-App von npm run precheck anhalten (belegt sonst Port 3001), nur Datenbank starten
spawnSync('docker compose stop server client', { cwd: root, stdio: 'ignore', shell: true });
run('Datenbank in Docker starten (nur 127.0.0.1:5433)', `${COMPOSE} up -d --wait postgres`);

// 5. Server und Oberflaeche starten, Testdaten anlegen, sobald der Server antwortet
// Alle Meldungen von Server und Oberflaeche gehen in dev-lokal.log, das Terminal bleibt ruhig
console.log('\n=== Server und Oberflaeche starten (Meldungen in dev-lokal.log) ===');
const logFd = openSync(LOG, 'w');
const dev = spawn('npm run dev', { cwd: root, stdio: ['ignore', logFd, logFd], shell: true });
closeSync(logFd);
dev.on('exit', (code) => {
    console.error('\nServer oder Oberflaeche beendet. Letzte Meldungen aus dev-lokal.log:\n');
    console.error(readFileSync(LOG, 'utf8').split(/\r?\n/).slice(-30).join('\n'));
    process.exit(code ?? 0);
});

if (await waitForServer(120)) {
    const t = spawn(`node "${join('scripts', 'testdaten.mjs')}"`, { cwd: root, stdio: 'inherit', shell: true });
    t.on('exit', () => {
        console.log('\nFertig. Im Browser oeffnen: http://localhost:5173');
        console.log('Alle Meldungen: dev-lokal.log (wird bei jedem Start neu angelegt)');
        console.log('Beenden: Strg+C. Datenbank anhalten: docker compose stop postgres');
    });
} else {
    console.error('\nServer antwortet nicht auf Port 3001. Meldungen in dev-lokal.log pruefen.');
}
