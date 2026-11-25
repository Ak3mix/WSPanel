#!/usr/bin/env node
/**
 * WSBot core — punto de entrada.
 *
 *   node bot.js --client-id personal --config ../config-personal.yaml --user-data-dir ../sessions/personal
 *
 * Opciones:
 *   --client-id <id>        id de la sesión LocalAuth
 *   --config <ruta>         YAML de configuración (por defecto ./config.yaml)
 *   --user-data-dir <ruta>  carpeta de sesiones (dataPath de LocalAuth)
 *   --paused                arrancar con la auto-respuesta en pausa
 *   --fake                  cliente WhatsApp simulado (tests / pruebas sin navegador)
 *
 * Protocolo: stdout = solo JSON-lines (ver lib/protocol.js). Códigos de salida en lib/bot-core.js (EXIT).
 */
const fs = require('fs');
const path = require('path');
const { createProtocol } = require('./lib/protocol');
const { normalizeConfig, loadConfigFile, watchConfig } = require('./lib/config');
const { findBrowser, browserWarnings, installHint } = require('./lib/browser');
const { LidResolver } = require('./lib/lid');
const { createBot, EXIT, stackOf } = require('./lib/bot-core');

function getArg(flag, def) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && i < process.argv.length - 1 ? process.argv[i + 1] : def;
}
const hasFlag = (flag) => process.argv.includes(flag);

const protocol = createProtocol();
const { log } = protocol;

function exit(code) {
    // dar tiempo a que stdout se vacíe antes de salir
    process.stdout.write('', () => process.exit(code));
}

function loadInitialConfig(file) {
    if (!fs.existsSync(file)) {
        log('CONFIG', 'Config file not found, using defaults', { file });
        return normalizeConfig({});
    }
    try {
        return loadConfigFile(file);
    } catch (e) {
        log('ERROR', 'Invalid config file', { file, error: e.message });
        exit(EXIT.CONFIG);
        return null;
    }
}

function createRealClient(cfg, { clientId, dataPath }) {
    const browser = findBrowser(cfg.chrome_path);
    for (const w of browser.warnings) log('CONFIG', w);
    if (!browser.path) {
        log('ERROR', 'No se encontró Chrome, Chromium, Edge ni Brave', {
            configured: cfg.chrome_path || null,
            hint: installHint(),
        });
        protocol.say({ type: 'status', value: 'browser_missing' });
        return null;
    }
    const executablePath = browser.path;
    log('CONFIG', `Usando ${browser.name}`, { executablePath, source: browser.source });
    for (const w of browserWarnings(executablePath, dataPath)) log('CONFIG', w);
    const { Client, LocalAuth } = require('whatsapp-web.js');
    return new Client({
        authStrategy: new LocalAuth({ ...(clientId ? { clientId } : {}), dataPath }),
        // tiempo para que WhatsApp Web termine de cargar (por defecto 30 s: poco con
        // una red o un PC lentos, y la cuenta caía con "auth timeout")
        authTimeoutMs: 120000,
        puppeteer: {
            headless: cfg.headless,
            executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-sync',
                '--disable-features=TranslateUI,CalculateNativeWinOcclusion',
            ],
        },
    });
}

function main() {
    const clientId = getArg('--client-id', undefined);
    const configFile = path.resolve(getArg('--config', path.join(__dirname, 'config.yaml')));
    const dataPath = path.resolve(getArg('--user-data-dir', path.join(__dirname, '.wwebjs_auth')));
    const fake = hasFlag('--fake');

    const cfg = loadInitialConfig(configFile);
    if (!cfg) return;

    let client;
    if (fake) {
        const { FakeClient } = require('./lib/fake-client');
        client = new FakeClient({ delayMs: Number(process.env.WSBOT_FAKE_DELAY_MS || 20) });
    } else {
        client = createRealClient(cfg, { clientId, dataPath });
        if (!client) return exit(EXIT.BROWSER_MISSING);
    }

    const lid = new LidResolver({
        lookup: (ids) => client.getContactLidAndPhone(ids),
        cacheFile: fake ? null : path.join(dataPath, `lid-cache-${clientId || 'default'}.json`),
    });
    const loaded = lid.load();
    if (loaded) log('CACHE', `Loaded ${loaded} cached @lid mappings`);

    const bot = createBot({ client, protocol, lid, config: cfg, paused: hasFlag('--paused'), exit });

    protocol.onRequest((req) => {
        if (fake && req.type === 'fake_message') return client.injectMessage(req);
        return bot.handleRequest(req);
    });
    // stdin cerrado = el panel murió: no quedarse huérfano con un Chrome abierto
    process.stdin.on('end', () => bot.shutdown(EXIT.OK, 'stdin closed'));
    process.on('SIGTERM', () => bot.shutdown(EXIT.OK, 'SIGTERM'));
    process.on('SIGINT', () => bot.shutdown(EXIT.OK, 'SIGINT'));
    process.on('unhandledRejection', (e) => log('ERROR', 'Unhandled rejection', { error: String(e && e.message || e), stack: stackOf(e) }));
    process.on('uncaughtException', (e) => {
        log('ERROR', 'Uncaught exception', { error: String(e && e.message || e), stack: stackOf(e) });
        bot.shutdown(EXIT.ERROR, 'uncaughtException');
    });

    try {
        watchConfig(configFile, {
            onChange: (next) => bot.applyConfig(next),
            onError: (e) => log('CONFIG', 'Config reload failed, keeping previous config', { error: e.message }),
        });
    } catch (e) {
        log('CONFIG', 'Hot-reload watcher failed', { error: e.message });
    }

    bot.start();
}

main();
