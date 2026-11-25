const test = require('node:test');
const assert = require('node:assert/strict');
const { createBot, EXIT } = require('../lib/bot-core');
const { normalizeConfig } = require('../lib/config');
const { LidResolver } = require('../lib/lid');
const { FakeClient } = require('../lib/fake-client');

const G1 = '111@g.us';
const G2 = '222@g.us';

function setup(cfgOverrides = {}, { lids = { '900@lid': '34600000001@c.us' }, paused = false, now, clock } = {}) {
    const events = [];
    const protocol = { say: (o) => events.push(o), log: (tag, msg, data) => events.push({ type: 'log', tag, msg, data }), humanLogs: false };
    const client = new FakeClient({ delayMs: 1, lids });
    const lid = new LidResolver({ lookup: (ids) => client.getContactLidAndPhone(ids) });
    const exits = [];
    const config = normalizeConfig({
        keywords: ['aeropuerto', 'terminal 1'],
        allowed_groups: [G1],
        allowed_users: ['34600000001@c.us'],
        reply_delay_ms: 0,
        ...cfgOverrides,
    });
    const bot = createBot({ client, protocol, lid, config, paused, exit: (c) => exits.push(c), sleep: async () => {}, ...(now ? { now } : {}), ...(clock ? { clock } : {}) });
    const rpc = async (cmd, extra = {}) => {
        const id = String(Math.random());
        await bot.handleRequest({ type: 'rpc', id, cmd, ...extra });
        return events.find((e) => e.type === 'rpc_result' && e.id === id);
    };
    return { bot, client, events, exits, rpc, lid };
}

const send = (bot, m) => bot.handleMessage({
    fromMe: false,
    reply: async function (t) { this.replied = t; return { id: { _serialized: 'r' + Math.random() }, ack: 1 }; },
    getChat: async () => ({ name: 'Grupo Uno' }),
    ...m,
});

test('responde a usuario @c.us permitido con keyword en grupo permitido', async () => {
    const { bot, events } = setup();
    const m = { from: G1, author: '34600000001@c.us', body: 'Voy al AEROPUÉRTO' };
    await send(bot, m);
    const n = events.find((e) => e.type === 'notification');
    assert.ok(n);
    assert.equal(n.group, 'Grupo Uno');
    assert.equal(n.keyword, 'aeropuerto');
    assert.equal(n.text, 'Voy al AEROPUÉRTO');
});

test('responde a usuario @lid permitido aunque no esté en caché (regresión)', async () => {
    const { bot, events, client } = setup();
    await send(bot, { from: G1, author: '900@lid', body: 'terminal 1' });
    assert.ok(events.find((e) => e.type === 'notification'));
    assert.equal(events.find((e) => e.type === 'notification').sender, '34600000001@c.us');
    await send(bot, { from: G1, author: '900@lid', body: 'terminal 1' });
    assert.equal(client.lookups, 1); // la segunda vez sale de caché
});

test('no responde a usuario no permitido, ni a grupo no permitido, ni sin keyword', async () => {
    const { bot, events, client } = setup({}, { lids: { '777@lid': '34699999999@c.us' } });
    await send(bot, { from: G1, author: '777@lid', body: 'aeropuerto' });
    await send(bot, { from: G1, author: '34699999999@c.us', body: 'aeropuerto' });
    await send(bot, { from: G2, author: '34600000001@c.us', body: 'aeropuerto' });
    await send(bot, { from: G1, author: '34600000001@c.us', body: 'hola' });
    await send(bot, { from: '34600000001@c.us', author: undefined, body: 'aeropuerto' }); // chat privado
    await send(bot, { from: G1, author: '34600000001@c.us', body: 'aeropuerto', fromMe: true });
    assert.equal(events.filter((e) => e.type === 'notification').length, 0);
    assert.equal(client.lookups, 1); // solo se resolvió el @lid del mensaje con keyword
});

test('mensajes sin keyword o de otros grupos no consultan WhatsApp', async () => {
    const { bot, client } = setup();
    let chats = 0;
    for (let i = 0; i < 50; i++) {
        await send(bot, { from: G2, author: `${i}@lid`, body: 'aeropuerto', getChat: async () => { chats++; return {}; } });
        await send(bot, { from: G1, author: `${i}@lid`, body: 'nada', getChat: async () => { chats++; return {}; } });
    }
    assert.equal(client.lookups, 0);
    assert.equal(chats, 0);
});

test('listas vacías = todos permitidos', async () => {
    const { bot, events } = setup({ allowed_groups: [], allowed_users: [] });
    await send(bot, { from: G2, author: '1@lid', body: 'aeropuerto' });
    assert.equal(events.filter((e) => e.type === 'notification').length, 1);
});

test('pausa: no responde y lo notifica como evento propio', async () => {
    const { bot, events, rpc } = setup();
    const r = await rpc('SET_PAUSED', { value: true });
    assert.equal(r.ok, true);
    assert.ok(events.find((e) => e.type === 'paused' && e.value === true));
    assert.ok(!events.find((e) => e.type === 'status' && e.value === 'paused'));
    await send(bot, { from: G1, author: '34600000001@c.us', body: 'aeropuerto' });
    assert.equal(events.filter((e) => e.type === 'notification').length, 0);
});

test('arrancar en pausa con --paused', async () => {
    const { bot } = setup({}, { paused: true });
    assert.equal(bot.paused, true);
});

test('cooldown por grupo', async () => {
    const { bot, events } = setup({ cooldown_ms: 60000 });
    await send(bot, { from: G1, author: '34600000001@c.us', body: 'aeropuerto' });
    await send(bot, { from: G1, author: '34600000001@c.us', body: 'aeropuerto' });
    assert.equal(events.filter((e) => e.type === 'notification').length, 1);
});

test('hot-reload: quitar un usuario surte efecto inmediato', async () => {
    const { bot, events } = setup();
    await send(bot, { from: G1, author: '900@lid', body: 'aeropuerto' });
    bot.applyConfig(normalizeConfig({ ...bot.config, allowed_users: ['34611111111@c.us'] }));
    await send(bot, { from: G1, author: '900@lid', body: 'aeropuerto' });
    assert.equal(events.filter((e) => e.type === 'notification').length, 1);
});

test('RPC que necesitan WhatsApp fallan limpio antes de ready', async () => {
    const { rpc } = setup();
    const r = await rpc('FETCH_GROUPS');
    assert.equal(r.ok, false);
    assert.match(r.error, /no lista/);
    assert.equal((await rpc('PING')).ok, true);
    assert.equal((await rpc('NOPE')).ok, false);
});

test('flujo completo con cliente falso: ready, grupos, contactos, búsqueda, envío', async () => {
    const { bot, client, rpc, events } = setup();
    await bot.start();
    assert.equal(bot.status, 'ready');
    assert.ok(events.find((e) => e.type === 'qr'));
    assert.equal((await rpc('FETCH_GROUPS')).data.groups.length, 2);
    assert.equal((await rpc('FETCH_CONTACTS')).data.contacts.length, 2);
    assert.equal((await rpc('SEARCH_CONTACTS', { query: 'aná' })).data.count, 1);
    assert.equal((await rpc('SEND_MESSAGE', { to: 'x', text: 'hola' })).ok, false);
    assert.equal((await rpc('SEND_MESSAGE', { to: G1, text: 'hola' })).ok, true);
    assert.deepEqual(client.sent, [{ to: G1, text: 'hola' }]);
});

test('desconexión y logout salen con el código adecuado', async () => {
    const a = setup();
    a.client.emit('disconnected', 'NAVIGATION');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(a.exits, [EXIT.DISCONNECTED]);

    const b = setup();
    b.client.emit('disconnected', 'LOGOUT');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(b.exits, [EXIT.LOGGED_OUT]);
    assert.ok(b.events.find((e) => e.type === 'status' && e.value === 'logged_out'));
});

test('initialize que no encuentra el navegador → EXIT.CONFIG', async () => {
    const s = setup();
    s.client.initialize = async () => { throw new Error('Browser was not found at the configured executablePath'); };
    await s.bot.start();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(s.exits, [EXIT.CONFIG]);
});

test('ready/authenticated repetidos se procesan una sola vez', async () => {
    const { bot, client, events } = setup();
    for (let i = 0; i < 3; i++) client.emit('authenticated');
    for (let i = 0; i < 3; i++) client.emit('ready');
    await new Promise((r) => setImmediate(r));
    assert.equal(events.filter((e) => e.type === 'status' && e.value === 'authenticated').length, 1);
    assert.equal(events.filter((e) => e.type === 'status' && e.value === 'ready').length, 1);
    assert.equal(client.lookups, 1); // la precarga de allowed_users no se repite
    assert.equal(bot.status, 'ready');
});

test('varias reglas: responde con la de la regla que casa y lo indica en el aviso', async () => {
    const { bot, events } = setup({ keywords: undefined, rules: [
        { name: 'T1', keywords: ['terminal 1'], replies: ['Voy a la T1'] },
        { keywords: ['aeropuerto'], exclude: ['no voy'], replies: ['Voy al aeropuerto'] },
    ] });
    await send(bot, { from: G1, author: '34600000001@c.us', body: 'estoy en la terminal 1' });
    await send(bot, { from: G1, author: '34600000001@c.us', body: 'no voy al aeropuerto' });
    await send(bot, { from: G1, author: '34600000001@c.us', body: 'voy al aeropuerto' });
    const n = events.filter((e) => e.type === 'notification');
    assert.deepEqual(n.map((x) => [x.rule, x.reply]), [['T1', 'Voy a la T1'], ['Regla 2', 'Voy al aeropuerto']]);
    assert.ok(events.find((e) => e.tag === 'FILTER' && /Excluded/.test(e.msg) && e.data.excluded_by === 'no voy'));
});

test('horario: fuera de horario no responde y lo registra', async () => {
    const domingo = new Date(2026, 10, 15, 10).getTime();
    const { bot, events } = setup({ schedule: { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' } }, { now: () => domingo });
    await send(bot, { from: G1, author: '34600000001@c.us', body: 'aeropuerto' });
    assert.equal(events.filter((e) => e.type === 'notification').length, 0);
    assert.ok(events.find((e) => e.tag === 'FILTER' && /Outside schedule/.test(e.msg)));
});

test('tiempo de respuesta: desde que llega el mensaje hasta que se envía, con la espera desglosada', async () => {
    const ticks = [1000, 1042]; // llegada, respuesta enviada
    const a = setup({}, { clock: () => ticks.shift() });
    await send(a.bot, { from: G1, author: '34600000001@c.us', body: 'aeropuerto' });
    const n1 = a.events.find((e) => e.type === 'notification');
    assert.equal(n1.latency_ms, 42);
    assert.equal(n1.delay_ms, 0);
    assert.ok(a.events.find((e) => e.tag === 'REPLY' && e.data.latency_ms === 42));

    const ticks2 = [5000.4, 6542.6];
    const b = setup({ reply_delay_ms: 1500 }, { clock: () => ticks2.shift() });
    await send(b.bot, { from: G1, author: '34600000001@c.us', body: 'aeropuerto' });
    const n2 = b.events.find((e) => e.type === 'notification');
    assert.equal(n2.latency_ms, 1542);
    assert.equal(n2.delay_ms, 1500);
});
