// Historial en disco, estadísticas, cuentas recordadas, probador de reglas y escritorio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHistoryStore } = require('../history-store');
const { createPanel } = require('../panel-core');
const { createApiServer } = require('../server');
const { createDesktop, findRunning, writeLock, removeLock, lockFile } = require('../desktop');

const BOT_DIR = path.resolve(__dirname, '..', '..', 'bot');
const tmp = (p = 'wspanel-feat-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const DAY = 86400000;

test('historial: guarda, sobrevive al reinicio, poda lo antiguo e ignora líneas corruptas', () => {
    const dataDir = tmp();
    let t = new Date(2026, 10, 17, 12).getTime();
    const now = () => t;
    const s1 = createHistoryStore({ dataDir, ids: ['personal'], keepDays: 30, now });
    s1.add('personal', { group: 'G1', group_id: '1@g.us', rule: 'T1', text: 'x'.repeat(900) }, t - 40 * DAY);
    s1.add('personal', { group: 'G1', group_id: '1@g.us', rule: 'T1', latency_ms: 42, delay_ms: 0 }, t - DAY);
    s1.add('personal', { group: 'G2', group_id: '2@g.us', rule: 'T2' }, t);
    s1.add('personal', { group: 'G1', group_id: '1@g.us', rule: 'T1' }, t);
    fs.appendFileSync(s1.file('personal'), '{roto\n');

    const s2 = createHistoryStore({ dataDir, ids: ['personal'], keepDays: 30, now });
    assert.equal(s2.recent('personal').length, 3); // el de hace 40 días y la línea rota fuera
    assert.equal(s2.recent('personal')[0].latency_ms, 42); // el tiempo de respuesta se conserva
    assert.equal(s2.recent('personal')[0].delay_ms, 0);
    assert.ok(!('latency_ms' in s2.recent('personal')[1])); // sin medir = sin campo
    assert.equal(s2.countToday('personal'), 2);
    const st = s2.stats('personal', 7);
    assert.equal(st.days.length, 7);
    assert.deepEqual(st.days.slice(-2).map((d) => d.count), [1, 2]);
    assert.equal(st.total, 3);
    assert.deepEqual(st.groups.map((g) => [g.name, g.count]), [['G1', 2], ['G2', 1]]);
    assert.deepEqual(st.rules, [{ name: 'T1', count: 2 }, { name: 'T2', count: 1 }]);
    assert.equal(fs.readFileSync(s2.file('personal'), 'utf8').trim().split('\n').length, 3); // archivo compactado
    t += DAY;
    assert.equal(s2.countToday('personal'), 0); // cambio de día
    fs.rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
    const dataDir = tmp();
    fs.writeFileSync(path.join(dataDir, 'config-personal.yaml'), [
        'rules:',
        '  - name: T1',
        '    keywords: [terminal 1]',
        '    replies: [Voy a la T1]',
        '  - keywords: [aeropuerto]',
        '    exclude: [no voy]',
        '    replies: [A, B]',
        'allowed_groups: ["111@g.us"]',
        'allowed_users: ["34600000001@c.us"]',
        'schedule: { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00" }',
        'reply_delay_ms: 0',
        '',
    ].join('\n'));
    return dataDir;
}

test('probador de reglas: respondería / por qué no', async () => {
    const dataDir = setup();
    const panel = createPanel({ dataDir, botDir: BOT_DIR, fake: true });
    try {
        const lunes = new Date(2026, 10, 16, 10).toISOString();
        const base = { groupId: '111@g.us', user: '+34600000001', at: lunes };
        const ok = panel.testMessage('personal', { ...base, text: 'Estoy en la TERMINAL 1' });
        assert.equal(ok.ok, true);
        assert.equal(ok.ruleName, 'T1');
        assert.equal(ok.reply, 'Voy a la T1');
        assert.ok(['A', 'B'].includes(panel.testMessage('personal', { ...base, text: 'aeropuerto' }).reply));
        const ex = panel.testMessage('personal', { ...base, text: 'no voy al aeropuerto' });
        assert.equal(ex.reason, 'excluded');
        assert.equal(ex.excluded[0].by, 'no voy');
        assert.equal(panel.testMessage('personal', { ...base, text: 'hola' }).reason, 'no_keyword');
        assert.equal(panel.testMessage('personal', { ...base, user: '34699999999', text: 'aeropuerto' }).reason, 'user');
        assert.equal(panel.testMessage('personal', { ...base, groupId: '222@g.us', text: 'aeropuerto' }).reason, 'group');
        assert.equal(panel.testMessage('personal', { ...base, at: new Date(2026, 10, 15, 10).toISOString(), text: 'aeropuerto' }).reason, 'schedule');
        await panel.pause('personal', true);
        assert.equal(panel.testMessage('personal', { ...base, text: 'aeropuerto' }).reason, 'paused');
        assert.throws(() => panel.testMessage('personal', { ...base, at: 'nunca', text: 'x' }), /fecha/);
    } finally { await panel.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('recuerda cuentas conectadas y pausas entre arranques; detener a mano lo olvida', async () => {
    const dataDir = setup();
    const p1 = createPanel({ dataDir, botDir: BOT_DIR, fake: true });
    try {
        p1.start('personal');
        const t0 = Date.now();
        while (p1.mgr.getStatus('personal') !== 'ready' && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 30));
        await p1.pause('personal', true);
        await new Promise((r) => setTimeout(r, 100));
    } finally { await p1.shutdown(); } // cerrar el panel NO olvida la cuenta

    const p2 = createPanel({ dataDir, botDir: BOT_DIR, fake: true });
    try {
        assert.deepEqual(p2.autostartIds(), ['personal']);
        assert.equal(p2.mgr.isPaused('personal'), true);
        assert.equal(p2.snapshot().instances.personal.autostart, true);
        await p2.stop('personal'); // detener a mano
        assert.deepEqual(p2.autostartIds(), []);
    } finally { await p2.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('las respuestas se guardan, cuentan hoy y aparecen en la actividad tras reiniciar', async () => {
    const dataDir = setup();
    fs.writeFileSync(path.join(dataDir, 'config-personal.yaml'), 'rules: [{ keywords: [aeropuerto], replies: [ok] }]\nreply_delay_ms: 0\n');
    const p1 = createPanel({ dataDir, botDir: BOT_DIR, fake: true });
    try {
        p1.start('personal');
        const t0 = Date.now();
        while (p1.mgr.getStatus('personal') !== 'ready' && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 30));
        p1.mgr.injectFakeMessage('personal', { from: '111@g.us', author: '1@c.us', body: 'voy al aeropuerto' });
        while (p1.snapshot().instances.personal.repliesToday < 1 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 30));
        assert.equal(p1.snapshot().instances.personal.repliesToday, 1);
    } finally { await p1.shutdown(); }
    const p2 = createPanel({ dataDir, botDir: BOT_DIR, fake: true });
    try {
        assert.equal(p2.snapshot().instances.personal.repliesToday, 1);
        const h = p2.history('personal');
        assert.equal(h.filter((x) => x.type === 'notification').length, 1);
        assert.equal(h[0].text, 'voy al aeropuerto');
        assert.equal(p2.stats('personal').total, 1);
    } finally { await p2.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('escritorio en Linux: acceso directo y arranque con el sistema (en segundo plano)', () => {
    const home = tmp('wspanel-home-');
    const d = createDesktop({ platform: 'linux', home, env: {}, nodePath: '/usr/bin/node', appEntry: '/opt/Mi Panel/panel/app.js' });
    assert.deepEqual([d.status().launcher, d.status().autostart], [false, false]);
    const st = d.set({ launcher: true, autostart: true });
    assert.equal(st.launcher && st.autostart, true);
    const launcher = fs.readFileSync(path.join(home, '.local/share/applications/wspanel.desktop'), 'utf8');
    const auto = fs.readFileSync(path.join(home, '.config/autostart/wspanel.desktop'), 'utf8');
    assert.match(launcher, /^Exec="\/usr\/bin\/node" "\/opt\/Mi Panel\/panel\/app.js"$/m);
    assert.match(auto, /app\.js" --no-open$/m);
    assert.equal(d.set({ autostart: false }).autostart, false);
    assert.equal(d.status().launcher, true);
    fs.rmSync(home, { recursive: true, force: true });
});

test('escritorio en Windows: scripts sin consola; macOS no soportado', () => {
    const home = tmp('wspanel-winhome-');
    const d = createDesktop({ platform: 'win32', home, env: { APPDATA: path.join(home, 'Roaming') }, nodePath: 'C:\\Program Files\\nodejs\\node.exe', appEntry: 'C:\\WSPanel\\panel\\app.js' });
    const vbs = d.content('autostart');
    assert.match(vbs, /node = "C:\\Program Files\\nodejs\\node\.exe"/);
    assert.match(vbs, /app = "C:\\WSPanel\\panel\\app\.js"/);
    assert.match(vbs, /sh\.Run """" & node & """ """ & app & """ --no-open", 0, False/);
    // si la carpeta ya no existe: mensaje claro en vez del error de Windows, antes de tocar CurrentDirectory
    assert.ok(vbs.indexOf('fso.FileExists(node)') < vbs.indexOf('sh.CurrentDirectory'));
    assert.match(vbs, /MsgBox\("No se encuentra WSPanel/);
    assert.doesNotMatch(d.content('launcher'), /--no-open/);
    assert.equal(createDesktop({ platform: 'darwin' }).status().supported, false);
    fs.rmSync(home, { recursive: true, force: true });
});

test('instancia única: encuentra el panel en marcha y descarta bloqueos viejos', async () => {
    const dataDir = tmp();
    const panel = createPanel({ dataDir, botDir: BOT_DIR, fake: true });
    const api = await createApiServer(panel, { port: 0 }).listen();
    try {
        assert.equal(await findRunning(dataDir), null);
        writeLock(dataDir, { port: api.port, token: api.token });
        const r = await findRunning(dataDir);
        assert.equal(r.port, api.port);
        assert.match(r.url, /\/login\?token=/);
        if (process.platform !== 'win32') assert.equal(fs.statSync(lockFile(dataDir)).mode & 0o777, 0o600);
        // bloqueo de un proceso que ya no existe
        fs.writeFileSync(lockFile(dataDir), JSON.stringify({ pid: 999999, port: api.port, token: api.token }));
        assert.equal(await findRunning(dataDir), null);
        // token que ya no vale (el panel se reinició)
        writeLock(dataDir, { port: api.port, token: 'viejo' });
        assert.equal(await findRunning(dataDir), null);
        removeLock(dataDir);
        assert.equal(fs.existsSync(lockFile(dataDir)), false);
    } finally { await api.close(); await panel.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('API: /test, /stats, /desktop y /quit', async () => {
    const dataDir = setup();
    const panel = createPanel({ dataDir, botDir: BOT_DIR, fake: true });
    const home = tmp('wspanel-home-');
    let quit = false;
    const api = await createApiServer(panel, {
        port: 0,
        desktop: createDesktop({ platform: 'linux', home, env: {} }),
        onQuit: () => { quit = true; },
    }).listen();
    const call = async (method, p, body) => {
        const r = await fetch(`http://127.0.0.1:${api.port}${p}`, {
            method, headers: { Authorization: `Bearer ${api.token}`, 'X-WSPanel': '1', 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: r.status, json: await r.json() };
    };
    try {
        const t = await call('POST', '/api/instances/personal/test', { groupId: '111@g.us', user: '34600000001', text: 'terminal 1', at: new Date(2026, 10, 16, 10).toISOString() });
        assert.equal(t.json.ok, true);
        assert.equal(t.json.ruleName, 'T1');
        assert.equal((await call('GET', '/api/instances/personal/stats?days=7')).json.days.length, 7);
        assert.equal((await call('GET', '/api/desktop')).json.supported, true);
        assert.equal((await call('PUT', '/api/desktop', { launcher: true })).json.launcher, true);
        assert.equal((await call('POST', '/api/quit')).status, 200);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(quit, true);
    } finally {
        await api.close(); await panel.shutdown();
        fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
    }
});

test('escritorio en Windows: .vbs en UTF-16 con BOM (rutas con ñ) y se repara al cambiar de carpeta', () => {
    // las rutas de Windows no son rutas de verdad en Linux/macOS: se trabaja con una
    // APPDATA relativa dentro de un directorio temporal para no dejar basura
    const home = tmp('wspanel-winfix-');
    const cwd = process.cwd();
    process.chdir(home);
    const env = { APPDATA: 'Roaming' };
    const old = createDesktop({ platform: 'win32', home, env, nodePath: 'C:\\Descargas\\WSPanel-2.1.1\\node\\node.exe', appEntry: 'C:\\Descargas\\WSPanel-2.1.1\\app\\panel\\app.js' });
    const st = old.set({ autostart: true });
    const buf = fs.readFileSync(st.paths.autostart);
    assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xfe]);
    // versión nueva descomprimida en otra carpeta (con ñ)
    const cur = createDesktop({ platform: 'win32', home, env, nodePath: 'C:\\Users\\Peña\\WSPanel\\node\\node.exe', appEntry: 'C:\\Users\\Peña\\WSPanel\\app\\panel\\app.js' });
    assert.deepEqual(cur.refresh(), ['autostart']); // el acceso del menú no existía: no se crea
    const text = fs.readFileSync(st.paths.autostart).subarray(2).toString('utf16le');
    assert.match(text, /Peña\\WSPanel\\app\\panel\\app\.js/);
    assert.doesNotMatch(text, /2\.1\.1/);
    assert.deepEqual(cur.refresh(), [], 'ya al día');
    assert.equal(fs.existsSync(path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WSPanel.vbs')), false);
    // un .vbs antiguo (UTF-8, versión 2.1.x) también se actualiza; uno ajeno no se toca
    fs.writeFileSync(st.paths.autostart, "' WSPanel: generado por el panel. Puedes borrarlo desde Ajustes.\r\nSet sh = CreateObject(\"WScript.Shell\")\r\n");
    assert.deepEqual(cur.refresh(), ['autostart']);
    fs.writeFileSync(st.paths.autostart, "' mi propio script\r\n");
    assert.deepEqual(cur.refresh(), []);
    assert.equal(fs.readFileSync(st.paths.autostart, 'utf8'), "' mi propio script\r\n");
    process.chdir(cwd);
    fs.rmSync(home, { recursive: true, force: true });
});

test('escritorio en Linux: el .desktop también se actualiza si cambió la carpeta', () => {
    const home = tmp('wspanel-linfix-');
    createDesktop({ platform: 'linux', home, env: {}, nodePath: '/opt/old/node', appEntry: '/opt/old/panel/app.js' }).set({ launcher: true });
    const cur = createDesktop({ platform: 'linux', home, env: {}, nodePath: '/opt/new/node', appEntry: '/opt/new/panel/app.js' });
    assert.deepEqual(cur.refresh(), ['launcher']);
    assert.match(fs.readFileSync(path.join(home, '.local', 'share', 'applications', 'wspanel.desktop'), 'utf8'), /\/opt\/new\/panel\/app\.js/);
    fs.rmSync(home, { recursive: true, force: true });
});
