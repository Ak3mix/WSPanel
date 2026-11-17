const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LidResolver } = require('../lib/lid');

function fakeLookup(map) {
    const calls = [];
    const fn = async (ids) => {
        calls.push(ids);
        const byPn = Object.fromEntries(Object.entries(map).map(([l, p]) => [p, l]));
        return ids.map((id) => (id.endsWith('@lid') ? { lid: id, pn: map[id] } : { lid: byPn[id], pn: id }));
    };
    fn.calls = calls;
    return fn;
}

test('toPhone resuelve @lid una sola vez y luego usa caché', async () => {
    const lookup = fakeLookup({ '9@lid': '1@c.us' });
    const r = new LidResolver({ lookup });
    assert.equal(await r.toPhone('9@lid'), '1@c.us');
    assert.equal(await r.toPhone('9@lid'), '1@c.us');
    assert.equal(lookup.calls.length, 1);
    assert.equal(await r.toPhone('1@c.us'), '1@c.us');
    assert.equal(lookup.calls.length, 1);
});

test('caché negativa: un @lid desconocido no se busca en cada mensaje', async () => {
    let t = 0;
    const lookup = fakeLookup({});
    const r = new LidResolver({ lookup, negativeTtlMs: 1000, now: () => t });
    assert.equal(await r.toPhone('5@lid'), null);
    assert.equal(await r.toPhone('5@lid'), null);
    assert.equal(lookup.calls.length, 1);
    t = 1001;
    await r.toPhone('5@lid');
    assert.equal(lookup.calls.length, 2);
});

test('búsquedas simultáneas del mismo @lid se deduplican', async () => {
    const lookup = fakeLookup({ '9@lid': '1@c.us' });
    const r = new LidResolver({ lookup });
    const res = await Promise.all([r.toPhone('9@lid'), r.toPhone('9@lid'), r.toPhone('9@lid')]);
    assert.deepEqual(res, ['1@c.us', '1@c.us', '1@c.us']);
    assert.equal(lookup.calls.length, 1);
});

test('lookup que lanza excepción no rompe y cuenta como fallo', async () => {
    const r = new LidResolver({ lookup: async () => { throw new Error('page closed'); } });
    assert.equal(await r.toPhone('9@lid'), null);
});

test('warm pre-resuelve allowed_users en un solo lookup', async () => {
    const lookup = fakeLookup({ '9@lid': '1@c.us', '8@lid': '2@c.us' });
    const r = new LidResolver({ lookup });
    const out = await r.warm(['1@c.us', '2@c.us', '3@c.us']);
    assert.equal(out.resolved, 2);
    assert.equal(lookup.calls.length, 1);
    assert.equal(r.cachedPhone('9@lid'), '1@c.us');
    await r.warm(['1@c.us', '2@c.us']);
    assert.equal(lookup.calls.length, 1); // ya estaban
});

test('persistencia atómica en disco', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsbot-lid-'));
    const file = path.join(dir, 'sub', 'lid.json');
    const r = new LidResolver({ lookup: fakeLookup({ '9@lid': '1@c.us' }), cacheFile: file });
    await r.toPhone('9@lid');
    r.saveNow();
    const r2 = new LidResolver({ lookup: async () => [], cacheFile: file });
    assert.equal(r2.load(), 1);
    assert.equal(r2.cachedPhone('9@lid'), '1@c.us');
    fs.rmSync(dir, { recursive: true, force: true });
});
