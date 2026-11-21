#!/usr/bin/env node
// WSPanel: API local + interfaz web, abierta en una ventana propia del navegador
// instalado (modo --app de Chrome/Edge/Chromium/Brave).
//
//   node app.js                    → abre el panel y reconecta las cuentas que estaban conectadas
//   node app.js --start            → además arranca todas las cuentas
//   node app.js --start personal   → arranca esa (además de las recordadas)
//   node app.js --no-autostart     → no reconectar las cuentas recordadas
//   node app.js --fake             → WhatsApp simulado (sin navegador para los bots)
//   node app.js --no-open          → no abrir ventana (arranque con el sistema)
//   node app.js --port 47800       → puerto (si está ocupado se usa otro libre)
//
// Si el panel ya está abierto, lanzarlo otra vez solo abre su ventana.
// Cerrar la ventana NO para los bots: se cierra desde Ajustes → «Cerrar WSPanel» o con Ctrl+C.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createPanel } = require('./panel-core');
const { createApiServer } = require('./server');
const { createDesktop, findRunning, writeLock, removeLock } = require('./desktop');
const { DATA_DIR, BOT_DIR, VERSION } = require('./paths');
const browserLib = require(path.join(BOT_DIR, 'lib', 'browser.js'));

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const value = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };

const fake = flag('--fake');
const port = Number(value('--port') || 47800);
const startArg = flag('--start') ? (value('--start') || 'todos') : null;

// Abre la URL en una ventana de aplicación del navegador detectado (perfil propio).
function openWindow(url, browserPath, name) {
    if (!browserPath) return false;
    const profile = path.join(DATA_DIR, 'sessions', '_panel-ui');
    fs.mkdirSync(profile, { recursive: true });
    const child = spawn(browserPath, [
        `--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,860',
    ], { detached: true, stdio: 'ignore' });
    child.on('error', () => console.log(`No se pudo abrir ${name}; abre el enlace a mano.`));
    child.unref();
    return name;
}

let panel = null;
let api = null;
let closing = false;

async function close(code = 0) {
    if (closing) return process.exit(1);
    closing = true;
    console.log('\nDeteniendo…');
    removeLock(DATA_DIR);
    if (api) await api.close();
    if (panel) await panel.shutdown();
    process.exit(code);
}
process.on('SIGINT', () => close(0));
process.on('SIGTERM', () => close(0));

async function main() {
    // ¿ya está abierto? → abrir su ventana y salir
    const running = await findRunning(DATA_DIR);
    if (running) {
        console.log('WSPanel ya está en marcha.');
        if (!flag('--no-open')) {
            const b = browserLib.findBrowser('', {});
            const name = openWindow(running.url, b.path, b.name);
            console.log(name ? `Abriendo su ventana con ${name}…` : `Ábrelo en: ${running.url}`);
        }
        process.exit(0);
    }

    panel = createPanel({ dataDir: DATA_DIR, botDir: BOT_DIR, fake, version: VERSION });
    panel.startServices();
    api = await createApiServer(panel, {
        port,
        desktop: createDesktop(),
        onQuit: () => close(0),
    }).listen();
    writeLock(DATA_DIR, { port: api.port, token: api.token });

    console.log(`WSPanel ${VERSION} — datos: ${DATA_DIR}${fake ? ' · modo --fake' : ''}`);
    console.log(`Panel: ${api.loginUrl}`);
    console.log('   (el enlace lleva el token de esta sesión; cambia en cada arranque)');

    panel.mgr.on('event', (id, ev) => {
        // errores del bot también en la terminal (y en logs/<cuenta>.log, ver panel-core)
        if (ev.type === 'log' && (ev.tag === 'ERROR' || (ev.tag === 'STDERR' && !/DeprecationWarning|trace-deprecation/.test(ev.msg)))) {
            console.log(`[${new Date().toLocaleTimeString()}] [${id}] ${ev.tag}: ${ev.msg}${ev.data && ev.data.error ? ` — ${ev.data.error}` : ''}`);
            if (ev.data && ev.data.stack) console.log(ev.data.stack.split('\n').map((l) => '      ' + l).join('\n'));
        }
        if (ev.type === 'status' && ev.value !== 'qr') console.log(`[${new Date().toLocaleTimeString()}] [${id}] ${ev.value}`);
        else if (ev.type === 'qr' && panel.mgr.getStatus(id) !== 'qr') console.log(`[${new Date().toLocaleTimeString()}] [${id}] esperando QR`);
    });

    if (!flag('--no-open')) {
        const b = panel.browserFor(null);
        const name = openWindow(api.loginUrl, b.path, b.name);
        console.log(name ? `Abriendo el panel con ${name}…` : 'No hay navegador para abrir la ventana: abre el enlace a mano.');
    }

    // cuentas a conectar: las recordadas + las pedidas con --start
    const ids = new Set(flag('--no-autostart') ? [] : panel.autostartIds());
    if (startArg) for (const id of startArg === 'todos' ? panel.instances.map((i) => i.id) : startArg.split(',')) ids.add(id);
    for (const id of ids) {
        try {
            const r = panel.start(id);
            if (!r.ok) console.log(`[${id}] no arrancada: ${r.reason}`);
        } catch (e) { console.log(`[${id}] ${e.message}`); }
    }
    if (ids.size) console.log(`Conectando: ${[...ids].join(', ')}`);
    console.log('Ctrl+C (o Ajustes → «Cerrar WSPanel») para cerrar el panel y detener las cuentas.');
}

main().catch((e) => { console.error(e); removeLock(DATA_DIR); process.exit(1); });
