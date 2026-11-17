// API local contra el panel real con bots en modo --fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createPanel } = require('../panel-core');
const { createApiServer } = require('../server');

const BOT_DIR = path.resolve(__dirname, '..', '..', 'bot');

async function setup() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wspanel-api-'));
    fs.writeFileSync(path.join(dataDir, 'config-personal.yaml'), 'keywords: [aeropuerto]\nallowed_groups: ["111@g.us"]\nreply_delay_ms: 0\n');
    const panel = createPanel({ dataDir, botDir: BOT_DIR, fake: true, managerOptions: { killTimeoutMs: 3000 } });
    const api = await createApiServer(panel, { port: 0 }).listen();
    const base = `http://127.0.0.1:${api.port}`;
    const auth = { Authorization: `Bearer ${api.token}` };
    const call = async (method, p, body, headers = {}) => {
        const r = await fetch(base + p, {
            method,
            headers: { ...auth, 'X-WSPanel': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        let json; try { json = JSON.parse(text); } catch { json = text; }
        return { status: r.status, json, headers: r.headers };
    };
    const cleanup = async () => { await api.close(); await panel.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); };
    return { panel, api, base, call, cleanup };
}

// Lee eventos SSE hasta que `pred` devuelva true
function sse(base, token, pred, ms = 10000) {
    return new Promise((resolve, reject) => {
        const got = [];
        const req = http.get(`${base}/api/events`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
            let buf = '';
            res.on('data', (c) => {
                buf += c;
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    const ev = /^event: (.+)$/m.exec(block);
                    const data = /^data: (.+)$/m.exec(block);
                    if (!ev || !data) continue;
                    got.push({ event: ev[1], data: JSON.parse(data[1]) });
                    if (pred(got)) { clearTimeout(t); req.destroy(); resolve(got); }
                }
            });
        });
        req.on('error', () => {});
        const t = setTimeout(() => { req.destroy(); reject(new Error('timeout SSE')); }, ms);
    });
}

const waitStatus = async (call, id, value, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const { json } = await call('GET', '/api/state');
        if (json.instances[id].status === value) return json;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout esperando ${id}=${value}`);
};

test('seguridad: sin token, Host ajeno, sin cabecera X-WSPanel u Origin ajeno → rechazado', async () => {
    const { base, api, call, cleanup } = await setup();
    try {
        assert.equal((await fetch(base + '/api/state')).status, 401);
        assert.equal((await fetch(base + '/')).status, 401);
        assert.equal((await call('GET', '/api/state', null, { Authorization: 'Bearer malo' })).status, 401);
        const host = await new Promise((resolve) => {
            http.get({ host: '127.0.0.1', port: api.port, path: '/api/state', headers: { Host: 'evil.example:80', Authorization: `Bearer ${api.token}` } },
                (res) => { res.resume(); resolve(res.statusCode); });
        });
        assert.equal(host, 421);
        const noHeader = await fetch(base + '/api/instances/personal/start', { method: 'POST', headers: { Authorization: `Bearer ${api.token}` } });
        assert.equal(noHeader.status, 403);
        assert.equal((await call('POST', '/api/instances/personal/start', null, { Origin: 'https://evil.example' })).status, 403);
        assert.equal((await call('GET', '/../../package.json')).status, 404);
    } finally { await cleanup(); }
});

test('login por enlace deja una cookie HttpOnly y da acceso', async () => {
    const { base, api, cleanup } = await setup();
    try {
        const bad = await fetch(`${base}/login?token=nope`, { redirect: 'manual' });
        assert.equal(bad.status, 401);
        const r = await fetch(api.loginUrl, { redirect: 'manual' });
        assert.equal(r.status, 302);
        const cookie = r.headers.get('set-cookie');
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Strict/);
        const page = await fetch(base + '/', { headers: { Cookie: cookie.split(';')[0] } });
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
        assert.match(await page.text(), /WSPanel/);
    } finally { await cleanup(); }
});

test('flujo completo: arrancar, eventos en vivo, grupos, permitir, config, enviar, pausar, parar', async () => {
    const { base, api, call, cleanup } = await setup();
    try {
        let s = await call('GET', '/api/state');
        assert.equal(s.status, 200);
        assert.equal(s.json.instances.personal.status, 'stopped');
        assert.equal(s.json.fake, true);

        const live = sse(base, api.token, (got) => got.some((g) => g.event === 'bot' && g.data.ev.type === 'status' && g.data.ev.value === 'ready'));
        assert.equal((await call('POST', '/api/instances/personal/start')).json.ok, true);
        const events = await live;
        assert.equal(events[0].event, 'snapshot');
        assert.ok(events.some((g) => g.data.ev && g.data.ev.type === 'qr'));
        await waitStatus(call, 'personal', 'ready');

        const groups = await call('GET', '/api/instances/personal/groups');
        assert.equal(groups.json.groups.length, 2);
        assert.equal((await call('GET', '/api/instances/personal/contacts')).json.contacts.length, 2);

        const allowed = await call('POST', '/api/instances/personal/allow', { list: 'allowed_groups', value: '222@g.us' });
        assert.deepEqual(allowed.json.allowed_groups, ['111@g.us', '222@g.us']);
        assert.equal((await call('POST', '/api/instances/personal/allow', { list: 'otra', value: 'x' })).status, 400);

        const cfg = (await call('GET', '/api/instances/personal/config')).json;
        const saved = await call('PUT', '/api/instances/personal/config', { ...cfg, rules: [{ keywords: ['aeropuerto'], replies: ['Hola!'] }], reply_delay_ms: 0 });
        assert.deepEqual(saved.json.rules[0].replies, ['Hola!']);

        assert.equal((await call('POST', '/api/instances/personal/send', { to: '111@g.us', text: 'hola' })).json.sent, true);
        assert.equal((await call('POST', '/api/instances/personal/send', { to: 'x', text: 'hola' })).status, 400);

        assert.equal((await call('POST', '/api/instances/personal/pause', { paused: true })).json.paused, true);
        s = await call('GET', '/api/state');
        assert.equal(s.json.instances.personal.paused, true);

        const hist = await call('GET', '/api/instances/personal/history?limit=50');
        assert.ok(hist.json.length > 0);
        assert.ok(hist.json.every((h) => h.type === 'log' || h.type === 'notification'));

        await call('POST', '/api/instances/personal/stop');
        s = await call('GET', '/api/state');
        assert.equal(s.json.instances.personal.status, 'stopped');
    } finally { await cleanup(); }
});

test('errores: instancia desconocida, RPC con instancia parada, ruta y método inválidos, JSON roto', async () => {
    const { base, api, call, cleanup } = await setup();
    try {
        assert.equal((await call('POST', '/api/instances/nadie/start')).status, 404);
        assert.equal((await call('GET', '/api/instances/personal/groups')).status, 409);
        assert.equal((await call('GET', '/api/nada')).status, 404);
        assert.equal((await call('DELETE', '/api/state')).status, 405);
        const broken = await fetch(base + '/api/instances/personal/pause', {
            method: 'POST', headers: { Authorization: `Bearer ${api.token}`, 'X-WSPanel': '1' }, body: '{roto',
        });
        assert.equal(broken.status, 400);
    } finally { await cleanup(); }
});

test('navegador y Telegram por la API', async () => {
    const { call, cleanup } = await setup();
    try {
        const b = await call('GET', '/api/browser');
        assert.equal(b.status, 200);
        assert.ok('found' in b.json);
        assert.equal((await call('PUT', '/api/browser', { path: '/no/existe' })).status, 400);

        const t = await call('PUT', '/api/telegram', { token: '123456789:ABCDEFGHIJ', chatId: '-100', allowedUserIds: [5] });
        assert.equal(t.json.configured, true);
        assert.equal(t.json.tokenMasked, '123456••••GHIJ');
        assert.ok(!JSON.stringify((await call('GET', '/api/state')).json).includes('ABCDEFGHIJ')); // el token nunca sale entero
    } finally { await cleanup(); }
});

test('si el puerto está ocupado usa otro libre', async () => {
    const blocker = http.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    const busy = blocker.address().port;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wspanel-port-'));
    const panel = createPanel({ dataDir, botDir: BOT_DIR, fake: true });
    const api = await createApiServer(panel, { port: busy }).listen();
    try {
        assert.notEqual(api.port, busy);
    } finally {
        await api.close();
        await panel.shutdown();
        blocker.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('QR como SVG: 404 sin QR, imagen mientras la instancia lo pide', async () => {
    const { base, api, call, cleanup } = await setup();
    try {
        assert.equal((await call('GET', '/api/instances/personal/qr.svg')).status, 404);
        const qrSeen = sse(base, api.token, (got) => got.some((g) => g.event === 'bot' && g.data.ev.type === 'qr'));
        await call('POST', '/api/instances/personal/start');
        await qrSeen;
        // en modo fake el QR dura poco: puede haber pasado ya a authenticated
        const r = await fetch(base + '/api/instances/personal/qr.svg', { headers: { Authorization: `Bearer ${api.token}` } });
        if (r.status === 200) {
            assert.equal(r.headers.get('content-type'), 'image/svg+xml');
            assert.match(await r.text(), /^<svg [^>]*viewBox/);
        } else {
            assert.equal(r.status, 404);
        }
    } finally { await cleanup(); }
});

test('la ruta /simulate solo existe en modo --fake y las respuestas se cuentan sin Telegram', async () => {
    const { call, cleanup } = await setup();
    try {
        await call('POST', '/api/instances/personal/start');
        await waitStatus(call, 'personal', 'ready');
        assert.equal((await call('POST', '/api/instances/personal/simulate', { from: '111@g.us', author: '1@c.us', body: 'aeropuerto' })).status, 200);
        const t0 = Date.now();
        let replies = 0;
        while (Date.now() - t0 < 5000 && !replies) {
            replies = (await call('GET', '/api/state')).json.instances.personal.repliesToday;
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(replies, 1);
    } finally { await cleanup(); }

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wspanel-real-'));
    const panel = createPanel({ dataDir, botDir: BOT_DIR, fake: false });
    const realApi = await createApiServer(panel, { port: 0 }).listen();
    try {
        const r = await fetch(`http://127.0.0.1:${realApi.port}/api/instances/personal/simulate`, {
            method: 'POST', headers: { Authorization: `Bearer ${realApi.token}`, 'X-WSPanel': '1' }, body: '{}',
        });
        assert.equal(r.status, 404);
    } finally { await realApi.close(); await panel.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
