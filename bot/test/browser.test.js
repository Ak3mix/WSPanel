const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { detectBrowsers, findBrowser, validateBrowser, browserWarnings } = require('../lib/browser');

const only = (...paths) => {
    const set = new Set(paths.map((p) => p.toLowerCase()));
    return (p) => set.has(String(p).toLowerCase());
};
const noPuppeteer = () => '';

test('Windows: prefiere Chrome y cae a Edge si no hay Chrome', () => {
    const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const base = { platform: 'win32', env, regQuery: () => [], puppeteerPath: noPuppeteer };

    const both = detectBrowsers({ ...base, isExecutable: only(chrome, edge) });
    assert.deepEqual(both.map((b) => b.name), ['Chrome', 'Edge']);

    const r = findBrowser('', { ...base, isExecutable: only(edge) });
    assert.equal(r.name, 'Edge');
    assert.equal(r.path, edge);
});

test('Windows: encuentra instalaciones no estándar por el registro', () => {
    const custom = 'D:\\Apps\\Chrome\\chrome.exe';
    const r = findBrowser('', {
        platform: 'win32',
        env: { PROGRAMFILES: 'C:\\Program Files' },
        regQuery: (exe) => (exe === 'chrome.exe' ? [custom] : []),
        isExecutable: only(custom),
        puppeteerPath: noPuppeteer,
    });
    assert.equal(r.path, custom);
    assert.equal(r.name, 'Chrome');
});

test('Windows: Brave en AppData del usuario', () => {
    const brave = 'C:\\Users\\u\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
    const r = findBrowser('', {
        platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        regQuery: () => [], isExecutable: only(brave), puppeteerPath: noPuppeteer,
    });
    assert.equal(r.name, 'Brave');
});

test('Linux: busca en el PATH y en rutas típicas, en orden Chrome > Chromium > Edge > Brave', () => {
    const env = { PATH: ['/usr/local/bin', '/usr/bin'].join(path.delimiter) };
    const base = { platform: 'linux', env, puppeteerPath: noPuppeteer };
    const exe = only('/usr/bin/chromium', '/opt/microsoft/msedge/msedge', '/usr/local/bin/brave-browser');
    const found = detectBrowsers({ ...base, isExecutable: exe });
    assert.deepEqual(found.map((b) => `${b.name}:${b.path}`), [
        'Chromium:/usr/bin/chromium',
        'Edge:/opt/microsoft/msedge/msedge',
        'Brave:/usr/local/bin/brave-browser',
    ]);
    assert.equal(findBrowser('', { ...base, isExecutable: exe }).name, 'Chromium');
});

test('Linux: sin navegador → path null; puppeteer como último recurso', () => {
    const base = { platform: 'linux', env: { PATH: '/usr/bin' } };
    const none = findBrowser('', { ...base, isExecutable: () => false, puppeteerPath: noPuppeteer });
    assert.equal(none.path, null);
    const pp = '/home/u/.cache/puppeteer/chrome/linux-1/chrome-linux64/chrome';
    const r = findBrowser('', { ...base, isExecutable: only(pp), puppeteerPath: () => pp });
    assert.equal(r.name, 'Chrome for Testing');
});

test('macOS: aplicaciones en /Applications', () => {
    const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    const r = findBrowser('', { platform: 'darwin', env: {}, home: '/Users/u', isExecutable: only(edge), puppeteerPath: noPuppeteer });
    assert.equal(r.name, 'Edge');
});

test('chrome_path y CHROME_PATH tienen prioridad; si no existen se avisa y se autodetecta', () => {
    const base = { platform: 'linux', env: { PATH: '/usr/bin' }, puppeteerPath: noPuppeteer };
    const exe = only('/usr/bin/chromium', '/mi/chrome', '/env/edge');
    assert.equal(findBrowser('/mi/chrome', { ...base, isExecutable: exe }).source, 'config');
    assert.equal(findBrowser('', { ...base, env: { ...base.env, CHROME_PATH: '/env/edge' }, isExecutable: exe }).name, 'Edge');

    // config vieja de Windows usada en Linux
    const r = findBrowser('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', { ...base, isExecutable: exe });
    assert.equal(r.path, '/usr/bin/chromium');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /chrome_path no existe/);
});

test('validateBrowser comprueba que sea un Chromium', () => {
    const exe = () => true;
    const ok = validateBrowser('"/usr/bin/chromium"', { platform: 'linux', isExecutable: exe, run: () => 'Chromium 131.0.6778.85 snap\n' });
    assert.equal(ok.ok, true);
    assert.equal(ok.path, '/usr/bin/chromium');
    assert.equal(ok.name, 'Chromium');
    assert.equal(validateBrowser('/usr/bin/firefox', { platform: 'linux', isExecutable: exe, run: () => 'Mozilla Firefox 132' }).ok, false);
    assert.equal(validateBrowser('/no/existe', { platform: 'linux', isExecutable: () => false }).ok, false);
    assert.equal(validateBrowser('', {}).ok, false);
    const broken = validateBrowser('/x', { platform: 'linux', isExecutable: exe, run: () => { throw new Error('EACCES'); } });
    assert.match(broken.error, /No se pudo ejecutar/);
    // en Windows no se ejecuta --version
    const win = validateBrowser('C:\\x\\msedge.exe', { platform: 'win32', isExecutable: exe, run: () => { throw new Error('no debería llamarse'); } });
    assert.equal(win.ok, true);
    assert.equal(win.name, 'Edge');
});

test('aviso de Chromium snap con datos en disco externo', () => {
    assert.equal(browserWarnings('/snap/bin/chromium', '/run/media/u/Disco/WSPanel').length, 1);
    assert.equal(browserWarnings('/snap/bin/chromium', '/home/u/WSPanel').length, 0);
    assert.equal(browserWarnings('/usr/bin/chromium', '/run/media/u/x').length, 0);
});

test('Chrome for Testing de la caché de puppeteer: cualquier versión, la más nueva primero', () => {
    const home = '/home/u';
    const base = '/home/u/.cache/puppeteer/chrome';
    const newest = `${base}/linux-157.0.8103.78/chrome-linux64/chrome`;
    const older = `${base}/linux-131.0.6778.85/chrome-linux64/chrome`;
    const r = detectBrowsers({
        platform: 'linux', env: { PATH: '/usr/bin' }, home, puppeteerPath: noPuppeteer,
        readdir: (d) => (d === base ? ['linux-131.0.6778.85', 'linux-157.0.8103.78', 'chrome-headless-shell'] : []),
        isExecutable: only(newest, older),
    });
    assert.deepEqual(r.map((b) => b.path), [newest, older]);
    assert.equal(r[0].name, 'Chrome for Testing');

    const win = detectBrowsers({
        platform: 'win32', env: { USERPROFILE: 'C:\\Users\\u' }, home: 'C:\\Users\\u', regQuery: () => [], puppeteerPath: noPuppeteer,
        readdir: () => ['win64-157.0.8103.78'],
        isExecutable: only('C:\\Users\\u\\.cache\\puppeteer\\chrome\\win64-157.0.8103.78\\chrome-win64\\chrome.exe'),
    });
    assert.equal(win.length, 1);

    // sin caché no pasa nada
    assert.equal(detectBrowsers({ platform: 'linux', env: {}, home, puppeteerPath: noPuppeteer, isExecutable: () => false,
        readdir: () => { throw new Error('ENOENT'); } }).length, 0);
});
