const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { createPanel } = require('../panel-core');
const { askBrowserPath } = require('../browser-prompt');

const BOT_DIR = path.resolve(__dirname, '..', '..', 'bot');

function makePanel(existing = []) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wspanel-br-'));
    const exe = new Set(existing);
    const panel = createPanel({
        dataDir,
        botDir: BOT_DIR,
        browserDetect: {
            platform: 'linux',
            isExecutable: (p) => exe.has(p),
            puppeteerPath: () => '',
            validate: (p) => (exe.has(p) ? { ok: true, path: p, name: 'Chromium', version: 'Chromium 131' } : { ok: false, error: 'No existe o no es un ejecutable' }),
        },
    });
    const cleanup = async () => { await panel.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); };
    return { panel, dataDir, exe, cleanup };
}

test('sin navegador: startInstance no lanza el bot y marca browser_missing', async () => {
    const { panel, cleanup } = makePanel([]);
    try {
        const events = [];
        panel.mgr.on('event', (id, ev) => events.push({ id, ...ev }));
        const r = panel.startInstance('personal');
        assert.deepEqual(r, { ok: false, reason: 'browser_missing' });
        assert.equal(panel.mgr.isRunning('personal'), false);
        assert.equal(panel.mgr.getStatus('personal'), 'browser_missing');
        assert.ok(events.some((e) => e.type === 'status' && e.value === 'browser_missing'));
        assert.equal(panel.browserStatus().found, false);
        assert.match(panel.browserStatus().hint, /Chrome/);
    } finally { await cleanup(); }
});

test('setBrowserPath valida, guarda en panel-config.yaml y lo pasa a los bots', async () => {
    const { panel, dataDir, exe, cleanup } = makePanel([]);
    try {
        assert.equal(panel.setBrowserPath('/no/existe').ok, false);
        exe.add('/opt/mi/chromium');
        const r = panel.setBrowserPath('/opt/mi/chromium');
        assert.equal(r.ok, true);
        assert.equal(panel.mgr.env.CHROME_PATH, '/opt/mi/chromium');
        assert.equal(panel.browserFor('personal').path, '/opt/mi/chromium');
        assert.match(fs.readFileSync(path.join(dataDir, 'panel-config.yaml'), 'utf8'), /browser_path: \/opt\/mi\/chromium/);

        // se recuerda al volver a abrir el panel
        const again = createPanel({ dataDir, botDir: BOT_DIR, browserDetect: { isExecutable: (p) => exe.has(p), puppeteerPath: () => '' } });
        assert.equal(again.mgr.env.CHROME_PATH, '/opt/mi/chromium');
        await again.shutdown();

        // vaciar = volver a autodetectar
        panel.setBrowserPath('');
        assert.equal(panel.mgr.env.CHROME_PATH, undefined);
    } finally { await cleanup(); }
});

test('chrome_path del YAML de una instancia tiene prioridad', async () => {
    const { panel, exe, cleanup } = makePanel(['/usr/bin/chromium', '/opt/edge']);
    try {
        panel.configs.update('trabajo', (c) => ({ ...c, chrome_path: '/opt/edge' }));
        assert.equal(panel.browserFor('personal').path, '/usr/bin/chromium');
        assert.equal(panel.browserFor('trabajo').path, '/opt/edge');
        assert.equal(exe.size, 2);
    } finally { await cleanup(); }
});

test('askBrowserPath reintenta hasta una ruta válida', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (d) => { text += d; });
    const tried = [];
    const p = askBrowserPath({
        input, output, hint: 'instala Chrome',
        setBrowserPath: (x) => { tried.push(x); return x === '/ok' ? { ok: true, path: '/ok', name: 'Chrome' } : { ok: false, error: 'No existe' }; },
    });
    input.write('/mal\n');
    input.write('/ok\n');
    assert.equal(await p, '/ok');
    assert.deepEqual(tried, ['/mal', '/ok']);
    assert.match(text, /instala Chrome/);
    assert.match(text, /❌ No existe/);
    assert.match(text, /✅ Usaré Chrome/);
});

test('askBrowserPath: Enter vacío o fin de entrada cancela', async () => {
    const i1 = new PassThrough();
    const p1 = askBrowserPath({ input: i1, output: new PassThrough(), hint: '', setBrowserPath: () => ({ ok: false }) });
    i1.write('\n');
    assert.equal(await p1, null);
    const i2 = new PassThrough();
    const p2 = askBrowserPath({ input: i2, output: new PassThrough(), hint: '', setBrowserPath: () => ({ ok: false }) });
    i2.end();
    assert.equal(await p2, null);
});
