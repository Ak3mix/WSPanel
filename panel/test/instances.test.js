// Lanza procesos reales de bot.js en modo --fake (sin navegador).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { InstanceManager } = require('../instances');

const BOT_DIR = path.resolve(__dirname, '..', '..', 'bot');

function makeMgr(opts = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wspanel-'));
    fs.writeFileSync(path.join(dataDir, 'config-personal.yaml'),
        'keywords: [aeropuerto]\nallowed_groups: ["111@g.us"]\nreply_delay_ms: 0\n');
    fs.writeFileSync(path.join(dataDir, 'config-trabajo.yaml'), 'keywords: [x]\n');
    const mgr = new InstanceManager({
        botDir: BOT_DIR, dataDir, extraArgs: ['--fake'], backoffMs: [100], killTimeoutMs: 3000, ...opts,
    });
    const events = [];
    mgr.on('event', (id, ev) => events.push({ id, ...ev }));
    const cleanup = async () => { await mgr.stopAll(); fs.rmSync(dataDir, { recursive: true, force: true }); };
    return { mgr, events, dataDir, cleanup };
}

function waitFor(events, pred, ms = 8000) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
            const hit = events.find(pred);
            if (hit) { clearInterval(iv); resolve(hit); }
            else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout esperando evento')); }
        }, 20);
    });
}

const isStatus = (id, v) => (e) => e.id === id && e.type === 'status' && e.value === v;

test('arranca, llega a ready y responde RPC', async () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
        mgr.start('personal');
        await waitFor(events, isStatus('personal', 'ready'));
        const r = await mgr.sendRpc('personal', 'FETCH_GROUPS');
        assert.equal(r.groups.length, 2);
        assert.equal(mgr.getStatus('personal'), 'ready');
        assert.equal(mgr.getStatus('trabajo'), 'stopped');
    } finally { await cleanup(); }
});

test('restart NO mata a la instancia nueva (regresión)', async () => {
    const { mgr, events, cleanup } = makeMgr({ killTimeoutMs: 1500 });
    try {
        mgr.start('personal');
        await waitFor(events, isStatus('personal', 'ready'));
        events.length = 0;
        await mgr.restart('personal');
        await waitFor(events, isStatus('personal', 'ready'));
        await new Promise((r) => setTimeout(r, 2500)); // más que killTimeoutMs
        assert.equal(mgr.getStatus('personal'), 'ready');
        assert.ok(!events.some(isStatus('personal', 'crashed')));
        assert.equal((await mgr.sendRpc('personal', 'PING')).pong, true);
    } finally { await cleanup(); }
});

test('stop deja la instancia en stopped sin crash', async () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
        mgr.start('personal');
        await waitFor(events, isStatus('personal', 'ready'));
        await mgr.stop('personal');
        assert.equal(mgr.getStatus('personal'), 'stopped');
        assert.ok(!events.some(isStatus('personal', 'crashed')));
        await assert.rejects(mgr.sendRpc('personal', 'PING'), /no está en marcha/);
    } finally { await cleanup(); }
});

test('una caída inesperada se reinicia sola y no afecta a la otra', async () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
        mgr.start('personal');
        mgr.start('trabajo');
        await waitFor(events, isStatus('personal', 'ready'));
        await waitFor(events, isStatus('trabajo', 'ready'));
        events.length = 0;
        mgr.state.get('personal').proc.cp.kill('SIGKILL');
        const crash = await waitFor(events, isStatus('personal', 'crashed'));
        assert.equal(crash.retryInMs, 100);
        await waitFor(events, isStatus('personal', 'ready'));
        assert.equal(mgr.getStatus('trabajo'), 'ready');
        assert.equal((await mgr.sendRpc('trabajo', 'PING')).pong, true);
    } finally { await cleanup(); }
});

test('la pausa se recuerda entre reinicios', async () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
        mgr.start('personal');
        await waitFor(events, isStatus('personal', 'ready'));
        await mgr.setPaused('personal', true);
        await mgr.restart('personal');
        events.length = 0;
        await waitFor(events, isStatus('personal', 'ready'));
        const st = await mgr.sendRpc('personal', 'GET_STATE');
        assert.equal(st.paused, true);
        assert.equal(mgr.statusAll().personal.paused, true);
    } finally { await cleanup(); }
});

test('mensaje simulado → notificación de auto-respuesta', async () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
        mgr.start('personal');
        await waitFor(events, isStatus('personal', 'ready'));
        mgr.injectFakeMessage('personal', { from: '111@g.us', author: '1@c.us', body: 'Voy al aeropuerto' });
        const n = await waitFor(events, (e) => e.type === 'notification');
        assert.equal(n.group, 'Grupo Uno');
    } finally { await cleanup(); }
});

test('YAML inválido → config_error sin bucle de reinicios', async () => {
    const { mgr, events, dataDir, cleanup } = makeMgr();
    try {
        fs.writeFileSync(path.join(dataDir, 'config-personal.yaml'), 'keywords: [roto');
        mgr.start('personal');
        await waitFor(events, isStatus('personal', 'config_error'));
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(mgr.isRunning('personal'), false);
        assert.ok(!events.some(isStatus('personal', 'crashed')));
    } finally { await cleanup(); }
});

test('runtime inexistente → error controlado, el manager no revienta', async () => {
    const { mgr, events, cleanup } = makeMgr({ runtime: '/no/existe/node' });
    try {
        mgr.start('personal');
        await waitFor(events, isStatus('personal', 'crashed'));
        assert.equal(mgr.isRunning('personal'), false);
    } finally { await cleanup(); }
});
