// Detección del navegador Chromium que ya tenga instalado el equipo.
// Orden: ruta configurada → $CHROME_PATH → Chrome → Chromium → Edge → Brave →
// Chrome de puppeteer. Funciona en Windows, Linux y macOS. Todas las
// dependencias del sistema son inyectables para poder testearlo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BROWSERS = ['Chrome', 'Chromium', 'Edge', 'Brave'];

function defaultIsExecutable(p) {
    try {
        const st = fs.statSync(p);
        if (!st.isFile()) return false;
        if (process.platform === 'win32') return /\.exe$/i.test(p);
        fs.accessSync(p, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

// Lee "App Paths" del registro de Windows (instalaciones en rutas no estándar).
function defaultRegQuery(exe) {
    const keys = [
        `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
        `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
        `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    ];
    const out = [];
    for (const key of keys) {
        try {
            const txt = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            // "(Predeterminado)    REG_SZ    C:\...\chrome.exe" — el nombre del valor depende del idioma
            const m = txt.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
            if (m) out.push(m[1].replace(/^"|"$/g, ''));
        } catch { /* clave inexistente */ }
    }
    return out;
}

const expandWinEnv = (s, env) => s.replace(/%([^%]+)%/g, (all, k) => env[k] ?? env[k.toUpperCase()] ?? all);

function whichAll(names, env, isExecutable) {
    const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
    const out = [];
    for (const name of names) for (const d of dirs) out.push(path.join(d, name));
    return out.filter((p) => isExecutable(p));
}

// Lista de candidatos [{ name, path }] en orden de preferencia (pueden no existir).
function candidatePaths({ platform, env, home, regQuery }) {
    const list = [];
    const add = (name, paths) => { for (const p of paths) if (p) list.push({ name, path: p }); };

    if (platform === 'win32') {
        const pf = env.PROGRAMFILES || env.ProgramFiles || 'C:\\Program Files';
        const pf86 = env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const lad = env.LOCALAPPDATA || (home ? path.win32.join(home, 'AppData', 'Local') : '');
        const j = (...p) => path.win32.join(...p);
        const reg = (exe) => regQuery(exe).map((p) => expandWinEnv(p, env));
        add('Chrome', [
            j(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            j(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            lad && j(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            ...reg('chrome.exe').filter((p) => !/chromium/i.test(p)),
        ]);
        add('Chromium', [
            lad && j(lad, 'Chromium', 'Application', 'chrome.exe'),
            j(pf, 'Chromium', 'Application', 'chrome.exe'),
            ...reg('chrome.exe').filter((p) => /chromium/i.test(p)),
        ]);
        add('Edge', [
            j(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            j(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            lad && j(lad, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            ...reg('msedge.exe'),
        ]);
        add('Brave', [
            j(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            j(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            lad && j(lad, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            ...reg('brave.exe'),
        ]);
    } else if (platform === 'darwin') {
        const apps = ['/Applications', home && path.join(home, 'Applications')].filter(Boolean);
        const mac = (app, bin) => apps.map((a) => path.join(a, app, 'Contents', 'MacOS', bin));
        add('Chrome', mac('Google Chrome.app', 'Google Chrome'));
        add('Chromium', mac('Chromium.app', 'Chromium'));
        add('Edge', mac('Microsoft Edge.app', 'Microsoft Edge'));
        add('Brave', mac('Brave Browser.app', 'Brave Browser'));
    } else {
        // Linux y otros Unix: primero lo que haya en el PATH, luego rutas típicas
        const bins = {
            Chrome: ['google-chrome-stable', 'google-chrome'],
            Chromium: ['chromium', 'chromium-browser'],
            Edge: ['microsoft-edge-stable', 'microsoft-edge'],
            Brave: ['brave-browser', 'brave'],
        };
        const fixed = {
            Chrome: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'],
            Chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/lib/chromium/chromium', '/snap/bin/chromium'],
            Edge: ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge'],
            Brave: ['/opt/brave.com/brave/brave', '/usr/bin/brave-browser', '/snap/bin/brave'],
        };
        for (const name of BROWSERS) {
            add(name, bins[name].map((b) => ({ which: b })));
            add(name, fixed[name]);
        }
    }
    return list;
}

// Chrome for Testing descargado con `npx @puppeteer/browsers install chrome@stable`
// (cualquier versión; la más nueva primero).
function puppeteerCacheBrowsers({ platform, env, home, readdir }) {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const root = env.PUPPETEER_CACHE_DIR || (home ? p.join(home, '.cache', 'puppeteer') : '');
    if (!root) return [];
    const layout = {
        linux: [['linux-', ['chrome-linux64', 'chrome']]],
        win32: [['win64-', ['chrome-win64', 'chrome.exe']], ['win32-', ['chrome-win32', 'chrome.exe']]],
        darwin: [
            ['mac_arm-', ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']],
            ['mac-', ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']],
        ],
    }[platform] || [];
    let entries = [];
    try { entries = readdir(p.join(root, 'chrome')); } catch { return []; }
    const ver = (name) => name.replace(/^[a-z_0-9]+-/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const newer = (a, b) => { const x = ver(a); const y = ver(b); for (let i = 0; i < 4; i++) if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
    const out = [];
    for (const [prefix, rel] of layout) {
        for (const e of entries.filter((n) => n.startsWith(prefix)).sort(newer)) out.push(p.join(root, 'chrome', e, ...rel));
    }
    return out;
}

function puppeteerBrowser() {
    try { return require('puppeteer').executablePath(); } catch { return ''; }
}

// Todos los navegadores encontrados, sin duplicados, en orden de preferencia.
function detectBrowsers({
    platform = process.platform,
    env = process.env,
    home = os.homedir(),
    isExecutable = defaultIsExecutable,
    regQuery = platform === 'win32' ? defaultRegQuery : () => [],
    puppeteerPath = puppeteerBrowser,
    readdir = (d) => fs.readdirSync(d),
} = {}) {
    const found = [];
    const seen = new Set();
    const push = (name, p, source) => {
        if (!p) return;
        const key = platform === 'win32' ? p.toLowerCase() : p;
        if (seen.has(key) || !isExecutable(p)) return;
        seen.add(key);
        found.push({ name, path: p, source });
    };
    for (const c of candidatePaths({ platform, env, home, regQuery })) {
        if (typeof c.path === 'object') {
            for (const p of whichAll([c.path.which], env, isExecutable)) push(c.name, p, 'PATH');
        } else {
            push(c.name, c.path, 'system');
        }
    }
    for (const p of puppeteerCacheBrowsers({ platform, env, home, readdir })) push('Chrome for Testing', p, 'puppeteer');
    push('Chrome for Testing', puppeteerPath(), 'puppeteer');
    return found;
}

// Elige el navegador a usar. `configured` (chrome_path) y $CHROME_PATH tienen
// prioridad; si apuntan a algo que no existe se avisa y se sigue buscando.
function findBrowser(configured, opts = {}) {
    const env = opts.env || process.env;
    const isExecutable = opts.isExecutable || defaultIsExecutable;
    const warnings = [];
    for (const [p, source] of [[configured, 'config'], [env.CHROME_PATH, 'CHROME_PATH']]) {
        if (!p) continue;
        if (isExecutable(p)) return { name: guessName(p), path: p, source, warnings };
        warnings.push(`${source === 'config' ? 'chrome_path' : 'CHROME_PATH'} no existe o no es ejecutable: ${p}`);
    }
    const [best] = detectBrowsers({ ...opts, env, isExecutable });
    return best ? { ...best, warnings } : { name: null, path: null, source: null, warnings };
}

function guessName(p) {
    const s = p.toLowerCase();
    if (s.includes('edge')) return 'Edge';
    if (s.includes('brave')) return 'Brave';
    if (s.includes('chromium')) return 'Chromium';
    if (s.includes('chrome')) return 'Chrome';
    return 'Navegador';
}

// Comprueba una ruta dada por el usuario. En Linux/macOS además pregunta la
// versión (en Windows `chrome.exe --version` abre el navegador, así que no).
function validateBrowser(p, { platform = process.platform, isExecutable = defaultIsExecutable, run = execFileSync } = {}) {
    const file = String(p || '').trim().replace(/^["']|["']$/g, '');
    if (!file) return { ok: false, error: 'Ruta vacía' };
    if (!isExecutable(file)) return { ok: false, error: 'No existe o no es un ejecutable' };
    if (platform === 'win32') return { ok: true, path: file, name: guessName(file) };
    try {
        const version = String(run(file, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
        if (!/chrom|edge|brave/i.test(version)) {
            return { ok: false, error: `No parece un navegador Chromium (${version.slice(0, 80) || 'sin versión'})` };
        }
        return { ok: true, path: file, name: guessName(file + ' ' + version), version };
    } catch (e) {
        return { ok: false, error: 'No se pudo ejecutar: ' + (e.message || e).toString().split('\n')[0] };
    }
}

// Avisos útiles sobre el navegador elegido (p. ej. Chromium snap + disco externo).
function browserWarnings(browserPath, dataDir) {
    const w = [];
    if (browserPath && browserPath.startsWith('/snap/') && /^\/(run\/media|media|mnt)\//.test(dataDir || '')) {
        w.push('El navegador es un snap y los datos están en un disco externo: ejecuta '
            + '"sudo snap connect chromium:removable-media" o el navegador no podrá guardar la sesión.');
    }
    return w;
}

function installHint(platform = process.platform) {
    if (platform === 'win32') {
        return 'Instala Google Chrome (https://www.google.com/chrome/) o Microsoft Edge (viene con Windows 10/11).';
    }
    if (platform === 'darwin') {
        return 'Instala Google Chrome (https://www.google.com/chrome/), Chromium, Edge o Brave en /Applications.';
    }
    return 'Instala Google Chrome (.deb/.rpm de https://www.google.com/chrome/), Chromium, Edge o Brave, '
        + 'o descarga uno con: npx @puppeteer/browsers install chrome@stable';
}

module.exports = { BROWSERS, detectBrowsers, findBrowser, validateBrowser, browserWarnings, installHint, candidatePaths };
