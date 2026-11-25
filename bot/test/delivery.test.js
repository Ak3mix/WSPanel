// Envío confirmado de respuestas, vigilancia de la conexión y tiempo límite del @lid.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBot, EXIT } = require('../lib/bot-core');
const { normalizeConfig } = require('../lib/config');
const { LidResolver } = require('../lib/lid');
const { FakeClient } = require('../lib/fake-client');

const G1 = '111@g.us';
const USER = '34600000001@c.us';

function setup(cfg = {}, timings = {}) {
    const events = [];
    const exits = [];
    const protocol = { say: (o) => events.push(o), log: (tag, msg, data) => events.push({ type: 'log', tag, msg, data }), humanLogs: false };
    const client = new FakeClient({ delayMs: 1 });
    const bot = createBot({
        client, protocol, exit: (c) => exits.push(c), sleep: async () => {},
        config: normalizeConfig({ keywords: ['aeropuerto'], allowed_groups: [G1], reply_delay_ms: 0, ...cfg }),
        timings: { replyTimeoutMs: 60, healthIntervalMs: 1e9, healthTimeoutMs: 30, ...timings },
    });
    const notes = () => events.filter((e) => e.type === 'notification');
    return { bot, client, events, exits, notes };
}

const msgFrom = (client, extra = {}) => client.injectMessage({ from: G1, author: USER, body: 'aeropuerto', ...extra });
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('responde sin marcar como leído y esperando la confirmación de WhatsApp', async () => {
    const { bot, client, notes } = setup();
    let opts;
    await bot.handleMessage({ from: G1, author: USER, body: 'aeropuerto', fromMe: false, timestamp: Math.floor(Date.now() / 1000) - 90,
        reply: async (t, chatId, o) => { opts = o; return { id: { _serialized: 'x' }, ack: 1 }; }, getChat: async () => ({ name: 'G' }) });
    assert.deepEqual(opts, { sendSeen: false, waitUntilMsgSent: true });
    const [n] = notes();
    assert.equal(n.event, 'auto_reply');
    assert.equal(n.delivery, 'sent');
    assert.ok(n.age_ms >= 89000 && n.age_ms < 100000, `age_ms = ${n.age_ms}`); // el mensaje tenía ~90 s
    assert.ok(client);
});

test('si el envío falla: aviso reply_failed, no cuenta como respuesta y libera el cooldown', async () => {
    const { bot, client, notes, events } = setup({ cooldown_ms: 60000 });
    client.sendMode = 'fail';
    await bot.handleMessage(msgFrom(client));
    await settle(20);
    assert.equal(notes().length, 1);
    assert.equal(notes()[0].event, 'reply_failed');
    assert.match(notes()[0].error, /fallo simulado/);
    assert.ok(events.find((e) => e.tag === 'ERROR' && e.msg === 'Auto-reply failed'));
    client.sendMode = 'ok';
    msgFrom(client);
    await settle(20);
    assert.equal(notes().filter((e) => e.event === 'auto_reply').length, 1, 'el siguiente mensaje sí se responde');
});

test('si WhatsApp no contesta: tiempo límite → respuesta sin confirmar (no se queda esperando)', async () => {
    const { client, notes } = setup();
    client.sendMode = 'hang';
    msgFrom(client);
    await settle();
    const [n] = notes();
    assert.equal(n.event, 'auto_reply');
    assert.equal(n.delivery, 'unconfirmed');
    assert.match(n.error, /no confirmó/);
});

test('ack pendiente: espera el ack del servidor; ack 1 = enviado, ack -1 = rechazado', async () => {
    const a = setup();
    a.client.sendMode = 'pending';
    msgFrom(a.client);
    await settle(10);
    assert.equal(a.notes().length, 0, 'todavía esperando');
    a.client.emit('message_ack', { id: { _serialized: 'fake_1' } }, 1);
    await settle(10);
    assert.equal(a.notes()[0].delivery, 'sent');

    const b = setup();
    b.client.sendMode = 'pending';
    msgFrom(b.client);
    await settle(10);
    b.client.emit('message_ack', { id: { _serialized: 'fake_1' } }, -1);
    await settle(10);
    assert.equal(b.notes()[0].event, 'reply_failed');
});

test('vigilancia: la página no contesta varias veces seguidas → sale con DISCONNECTED', async () => {
    const { bot, client, exits, events } = setup({}, { healthIntervalMs: 15, healthTimeoutMs: 10, healthMisses: 3 });
    client.getState = () => new Promise(() => {}); // página colgada
    await bot.start();
    await settle(200);
    assert.deepEqual(exits, [EXIT.DISCONNECTED]);
    assert.ok(events.find((e) => e.tag === 'ERROR' && /stuck/.test(e.msg)));
    assert.ok(events.find((e) => e.type === 'status' && e.value === 'disconnected'));
});

test('vigilancia: conexión fuera de CONNECTED demasiado tiempo → sale; si vuelve a tiempo, no', async () => {
    const a = setup({}, { healthIntervalMs: 15, stuckMs: 60 });
    await a.bot.start();
    a.client.state = 'TIMEOUT';
    a.client.emit('change_state', 'TIMEOUT');
    await settle(200);
    assert.deepEqual(a.exits, [EXIT.DISCONNECTED]);

    const b = setup({}, { healthIntervalMs: 15, stuckMs: 120 });
    await b.bot.start();
    b.client.emit('change_state', 'OPENING');
    await settle(30);
    b.client.emit('change_state', 'CONNECTED');
    await settle(200);
    assert.deepEqual(b.exits, []);
    await b.bot.shutdown(EXIT.OK, 'fin');
});

test('@lid: una búsqueda colgada no bloquea a ese remitente para siempre', async () => {
    let t = 0;
    let hang = true;
    const lid = new LidResolver({
        lookup: (ids) => (hang ? new Promise(() => {}) : Promise.resolve(ids.map((id) => ({ lid: id, pn: '34600000009@c.us' })))),
        timeoutMs: 20, errorTtlMs: 1000, now: () => t,
    });
    assert.equal(await lid.toPhone('9@lid'), null); // tiempo agotado → fallo temporal
    hang = false;
    assert.equal(await lid.toPhone('9@lid'), null); // aún dentro del margen de reintento
    t = 1500;
    assert.equal(await lid.toPhone('9@lid'), '34600000009@c.us'); // reintenta y resuelve
});

test('cooldown global: una respuesta en cualquier grupo bloquea a todos durante la ventana', async () => {
    const G2 = '222@g.us';
    let t = 0;
    const events = [];
    const client = new FakeClient({ delayMs: 1 });
    const bot = createBot({
        client, exit: () => {}, sleep: async () => {}, now: () => t,
        protocol: { say: (o) => events.push(o), log: () => {}, humanLogs: false },
        config: normalizeConfig({ keywords: ['aeropuerto'], allowed_groups: [G1, G2], reply_delay_ms: 0, cooldown_ms: 60000, cooldown_scope: 'global' }),
        timings: { healthIntervalMs: 1e9 },
    });
    const send = (from) => bot.handleMessage({ from, author: USER, body: 'aeropuerto', fromMe: false,
        reply: async () => ({ id: { _serialized: String(Math.random()) }, ack: 1 }), getChat: async () => ({ name: from }) });
    const replies = () => events.filter((e) => e.event === 'auto_reply').map((e) => e.group_id);
    await send(G1);
    await send(G2); // otro grupo, dentro de la ventana: no
    assert.deepEqual(replies(), [G1]);
    t = 61000;
    await send(G2);
    assert.deepEqual(replies(), [G1, G2]);
    // por grupo (lo de siempre): el otro grupo sí responde
    bot.applyConfig(normalizeConfig({ ...bot.config, cooldown_scope: 'group' }));
    t = 62000;
    await send(G1);
    assert.deepEqual(replies(), [G1, G2, G1]);
});

test('cooldown_scope: vacío o desconocido = por grupo', () => {
    assert.equal(normalizeConfig({}).cooldown_scope, 'group');
    assert.equal(normalizeConfig({ cooldown_scope: 'raro' }).cooldown_scope, 'group');
    assert.equal(normalizeConfig({ cooldown_scope: 'global' }).cooldown_scope, 'global');
});
