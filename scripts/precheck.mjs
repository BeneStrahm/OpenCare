// Lokale Pruefung vor dem Commit.
//   npm run precheck          Typpruefung, Tests, App in Docker starten, Testdaten anlegen
//   npm run precheck:fast     nur Typpruefung und Tests
// Braucht Node 20+ und fuer den vollen Lauf Docker Desktop (gestartet).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schnell = process.argv.includes('--schnell');
const API = 'http://localhost:3001';

function run(title, cmd) {
    console.log(`\n=== ${title} ===`);
    const r = spawnSync(cmd, { cwd: root, stdio: 'inherit', shell: true });
    if (r.status !== 0) {
        console.error(`\nFEHLER bei: ${title}. Pruefung abgebrochen.`);
        process.exit(1);
    }
}

async function waitForServer(maxSeconds) {
    for (let i = 0; i < maxSeconds; i += 3) {
        try {
            const res = await fetch(`${API}/health`);
            if (res.ok) return true;
        } catch { /* Server startet noch */ }
        await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
}

run('Typpruefung und Build', 'npm run build');
run('Tests', 'npm test');

if (schnell) {
    console.log('\nSchnellpruefung bestanden.');
    process.exit(0);
}

if (!existsSync(join(root, '.env'))) {
    copyFileSync(join(root, '.env.demo'), join(root, '.env'));
    console.log('\n.env aus .env.demo angelegt (nur fuer den lokalen Test).');
}

run('App in Docker bauen und starten', 'docker compose up -d --build');

console.log('\n=== Warten auf den Server ===');
if (!(await waitForServer(300))) {
    console.error('Server antwortet nicht. Protokoll ansehen: docker compose logs server');
    process.exit(1);
}

run('Testdaten', `node "${join('scripts', 'testdaten.mjs')}"`);

console.log('\nFertig. Im Browser oeffnen: http://localhost:3000');
console.log('Beenden: docker compose down (Testdaten bleiben erhalten)');
