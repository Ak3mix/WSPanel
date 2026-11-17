const test = require('node:test');
const assert = require('node:assert/strict');
const { createLists, pageGroups, pageContacts } = require('../lib/wa-lists');

// Simula el entorno de WhatsApp Web (window.require) para las funciones de página
function withFakeWindow(contacts, chats, fn) {
    const wid = (id) => ({ _serialized: id, isLid: () => id.endsWith('@lid') });
    global.window = {
        require: (mod) => ({
            WAWebCollections: {
                Contact: { getModelsArray: () => contacts.map((c) => ({ ...c, id: wid(c.id) })) },
                Chat: { getModelsArray: () => chats.map((c) => ({ ...c, id: wid(c.id) })) },
            },
            WAWebContactGetters: {
                getIsMe: (c) => Boolean(c.me),
                getIsGroup: (c) => c.id._serialized.endsWith('@g.us'),
                getIsUser: (c) => !c.id._serialized.endsWith('@g.us'),
                getName: (c) => c.name,
                getPushname: (c) => c.push,
            },
            WAWebFrontendContactGetters: { getIsMyContact: (c) => Boolean(c.mine) },
            WAWebWidFactory: { createWidFromWidLike: (w) => w },
        }[mod]),
    };
    try { return fn(); } finally { delete global.window; }
}

test('pageContacts: solo la agenda (no participantes), sin uno mismo, @lid → número, sin duplicados', () => {
    const r = withFakeWindow([
        { id: '1@c.us', name: 'Ana', mine: true },
        { id: '2@c.us', push: 'Desconocido del grupo', mine: false },
        { id: '3@c.us', name: 'Yo', mine: true, me: true },
        { id: '9@lid', name: 'Beto', mine: true, phoneNumber: { _serialized: '4@c.us' } },
        { id: '4@c.us', name: 'Beto dup', mine: true },
        { id: '5@g.us', name: 'Un grupo', mine: true },
    ], [], () => pageContacts(100));
    assert.deepEqual(r.items, [{ id: '1@c.us', name: 'Ana' }, { id: '4@c.us', name: 'Beto' }]);
    assert.equal(r.total, 2);
});

test('pageGroups: solo @g.us y respeta el tope sin dejar de contar', () => {
    const chats = Array.from({ length: 30 }, (_, i) => ({ id: `${i}@g.us`, name: `G${i}` })).concat([{ id: '1@c.us', name: 'chat privado' }]);
    const r = withFakeWindow([], chats, () => pageGroups(10));
    assert.equal(r.items.length, 10);
    assert.equal(r.total, 30);
});

function fakeClient({ evaluate, chats = [], contacts = [] } = {}) {
    const c = {
        calls: 0,
        getChats: async () => { c.calls++; return chats; },
        getContacts: async () => { c.calls++; return contacts; },
    };
    if (evaluate) c.pupPage = { evaluate };
    return c;
}

test('caché: la segunda carga no vuelve a consultar; refresh sí', async () => {
    let n = 0;
    const lists = createLists(fakeClient({ evaluate: async () => { n++; return { items: [{ id: '1@g.us', name: 'b' }, { id: '2@g.us', name: 'a' }], total: 2 }; } }));
    const a = await lists.get('groups');
    assert.deepEqual(a.items.map((x) => x.name), ['a', 'b']); // ordenado
    assert.equal(a.cached, false);
    assert.equal((await lists.get('groups')).cached, true);
    await lists.get('groups', { refresh: true });
    assert.equal(n, 2);
});

test('peticiones simultáneas comparten una sola consulta', async () => {
    let n = 0;
    const lists = createLists(fakeClient({ evaluate: async () => { n++; await new Promise((r) => setTimeout(r, 30)); return { items: [], total: 0 }; } }));
    await Promise.all([lists.get('contacts'), lists.get('contacts'), lists.get('contacts', { refresh: true })]);
    assert.equal(n, 1);
});

test('tiempo máximo: una consulta colgada falla limpio y la siguiente puede reintentar', async () => {
    let hang = true;
    const lists = createLists(fakeClient({ evaluate: () => (hang ? new Promise(() => {}) : Promise.resolve({ items: [], total: 0 })) }),
        { limits: { groups: 10, contacts: 10, timeoutMs: 50, cacheMs: 1000 } });
    await assert.rejects(lists.get('groups'), /tiempo agotado/);
    hang = false;
    assert.equal((await lists.get('groups')).total, 0);
});

test('si la lectura interna falla, usa la API estándar filtrada y limitada', async () => {
    const logs = [];
    const contacts = [
        { id: { _serialized: '1@c.us' }, name: 'Ana', isMyContact: true },
        { id: { _serialized: '2@c.us' }, pushname: 'Participante', isMyContact: false },
        { id: { _serialized: '3@c.us' }, name: 'Carla', isMyContact: true },
    ];
    const lists = createLists(fakeClient({ evaluate: async () => { throw new Error('WAWebCollections cambió'); }, contacts }),
        { limits: { groups: 10, contacts: 1, timeoutMs: 1000, cacheMs: 0 }, log: (...a) => logs.push(a) });
    const r = await lists.get('contacts');
    assert.equal(r.items.length, 1);
    assert.equal(r.total, 2);
    assert.equal(r.truncated, true);
    assert.equal(logs.length, 1);
});

test('cuentas enormes: 50 000 grupos se recortan al tope sin romper', async () => {
    const big = Array.from({ length: 50000 }, (_, i) => ({ isGroup: true, id: { _serialized: `${i}@g.us` }, name: `Grupo ${i}` }));
    const lists = createLists(fakeClient({ chats: big }), { limits: { groups: 5000, contacts: 10, timeoutMs: 5000, cacheMs: 0 } });
    const r = await lists.get('groups');
    assert.equal(r.items.length, 5000);
    assert.equal(r.total, 50000);
    assert.equal(r.truncated, true);
});
