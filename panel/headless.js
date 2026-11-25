#!/usr/bin/env node
// Ejecuta el panel sin interfaz: instancias + Telegram, con logs y QR en la terminal.
//
//   node headless.js                 → arranca personal y trabajo
//   node headless.js personal        → solo una
//   node headless.js --fake          → WhatsApp simulado (sin navegador)
//   node headless.js --browser <ruta> → usar (y recordar) ese navegador
//   node headless.js --api           → además, API local + interfaz web (--port N, por defecto 47800)
//
// Si no hay Chrome, Chromium, Edge ni Brave, pide la ruta por la terminal.
// Ctrl+C detiene las instancias limpiamente.
const { createPanel } = require('./panel-core');
const { askBrowserPath } = require('./browser-prompt');
const { createApiServer } = require('./server');
const { DATA_DIR, BOT_DIR } = require('./paths');

const argv = process.argv.slice(2);
const fake = argv.includes('--fake');
const verbose = argv.includes('--verbose');
const withValue = ['--browser', '--port'];
const argValue = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const browserArg = argValue('--browser');
const apiEnabled = argv.includes('--api');
const apiPort = Number(argValue('--port') || 47800);
const wanted = argv.filter((a, i) => !a.startsWith('--') && !withValue.includes(argv[i - 1]));

let qrTerminal = null;
try { qrTerminal = require(require.resolve('qrcode-terminal', { paths: [BOT_DIR] })); } catch { /* sin QR ASCII */ }

const panel = createPanel({
    dataDir: DATA_DIR,
    botDir: BOT_DIR,
    fake,
    onError: (e) => verbose && console.error('[telegram]', e.message),
});
const ids = wanted.length ? wanted : panel.instances.map((i) => i.id);
for (const id of ids) {
    if (!panel.instances.some((i) => i.id === id)) {
        console.error(`Instancia desconocida: ${id}. Disponibles: ${panel.instances.map((i) => i.id).join(', ')}`);
        process.exit(2);
    }
}

const ts = () => new Date().toLocaleTimeString();
panel.mgr.on('event', (id, ev) => {
    const p = `[${ts()}] [${id}]`;
    if (ev.type === 'status') {
        console.log(`${p} ● estado: ${ev.value}${ev.code != null ? ` (código ${ev.code})` : ''}${ev.retryInMs != null ? ` — reintento en ${ev.retryInMs / 1000}s` : ''}`);
    } else if (ev.type === 'paused') {
        console.log(`${p} ${ev.value ? '⏸ pausada' : '▶ reanudada'}`);
    } else if (ev.type === 'qr') {
        console.log(`${p} Escanea este QR con el WhatsApp de la cuenta "${id}":`);
        if (qrTerminal && !fake) qrTerminal.generate(ev.qr, { small: true });
    } else if (ev.type === 'notification') {
        if (ev.event === 'reply_failed') console.log(`${p} ❌ no se pudo responder en "${ev.group}": ${ev.error}`);
        else console.log(`${p} ${ev.delivery === 'unconfirmed' ? '⚠️ respondió (sin confirmar)' : '🤖 respondió'} en "${ev.group}" a ${ev.sender} (keyword: ${ev.keyword})`);
    } else if (ev.type === 'log') {
        if (!verbose && ['MESSAGE', 'FILTER', 'STDERR', 'CACHE'].includes(ev.tag)) return;
        console.log(`${p} [${ev.tag}] ${ev.msg}${ev.data !== undefined ? ' ' + JSON.stringify(ev.data) : ''}`);
    }
});

let api = null;

// Devuelve false si no hay navegador y el usuario no indicó uno.
async function ensureBrowser() {
    if (fake) return true;
    if (browserArg) {
        const r = panel.setBrowserPath(browserArg);
        if (!r.ok) {
            console.error(`❌ --browser ${browserArg}: ${r.error}`);
            return false;
        }
    }
    if (ids.every((id) => panel.browserFor(id).path)) return true;
    const st = panel.browserStatus();
    if (!process.stdin.isTTY) {
        console.error('❌ No se encontró Chrome, Chromium, Edge ni Brave.');
        console.error('   ' + st.hint);
        console.error('   O indica la ruta: node headless.js --browser /ruta/al/navegador');
        return false;
    }
    const chosen = await askBrowserPath({ setBrowserPath: panel.setBrowserPath, hint: st.hint, detected: st.detected });
    return Boolean(chosen) && ids.every((id) => panel.browserFor(id).path);
}

async function main() {
    const tgc = panel.getTelegramConfig();
    console.log(`WSPanel headless — datos: ${DATA_DIR}`);
    if (!(await ensureBrowser())) process.exit(2);
    if (!fake) {
        for (const id of ids) {
            const b = panel.browserFor(id);
            console.log(`Navegador [${id}]: ${b.name} — ${b.path}${b.source === 'config' ? ' (chrome_path del YAML)' : ''}`);
            for (const w of b.warnings) console.log(`   ⚠️  ${w}`);
        }
    }
    console.log(`Telegram: ${tgc.configured ? `activo (grupo ${tgc.chatId})` : 'sin configurar'}${fake ? ' · modo --fake' : ''}`);
    panel.startServices();
    if (apiEnabled) {
        api = await createApiServer(panel, { port: apiPort }).listen();
        console.log(`Panel web: ${api.loginUrl}`);
        console.log('   (el enlace lleva el token de esta sesión; cambia en cada arranque)');
    }
    for (const id of ids) panel.startInstance(id);
}
main();

let closing = false;
async function close() {
    if (closing) return process.exit(1); // 2º Ctrl+C: salir ya
    closing = true;
    console.log('\nDeteniendo instancias…');
    if (api) await api.close();
    await panel.shutdown();
    process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
