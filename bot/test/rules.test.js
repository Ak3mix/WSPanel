const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig } = require('../lib/config');
const { compileConfig, evaluate, inSchedule, pickReply, findRule, normalizeText } = require('../lib/filter');

const G1 = '111@g.us';
const G2 = '222@g.us';
const at = (day, hh, mm = 0) => { const d = new Date(2026, 10, 15 + day, hh, mm); return d; }; // 15/11/2026 = domingo (0)

test('formato antiguo (keywords + auto_reply) se convierte en una regla y no arrastra las claves viejas', () => {
    const c = normalizeConfig({ keywords: ['Aeropuerto'], auto_reply: 'Voy', debug: true });
    assert.deepEqual(c.rules, [{ name: '', keywords: ['Aeropuerto'], exclude: [], replies: ['Voy'], groups: [] }]);
    assert.ok(!('keywords' in c) && !('auto_reply' in c));
    assert.deepEqual(normalizeConfig({}).rules, []);
    assert.deepEqual(normalizeConfig({ keywords: [] }).rules, []);
});

test('normaliza reglas, respuestas y horario', () => {
    const c = normalizeConfig({
        rules: [{ name: ' T1 ', keywords: ['a', 'a'], exclude: ['no voy'], replies: [' x ', '', 'x', 'y'], groups: ['1@g.us', 'malo'] }, {}],
        schedule: { days: [5, 1, 1, 8, 'x'], from: '8:05', to: '24:00' },
    });
    assert.deepEqual(c.rules[0], { name: 'T1', keywords: ['a'], exclude: ['no voy'], replies: ['x', 'y'], groups: ['1@g.us'] });
    assert.deepEqual(c.rules[1].replies, ['Yo, estoy al tanto.']);
    assert.deepEqual(c.schedule, { days: [1, 5], from: '08:05', to: '' });
    assert.deepEqual(normalizeConfig({ schedule: { days: [0, 1, 2, 3, 4, 5, 6] } }).schedule.days, []); // todos = sin límite
});

test('varias reglas: gana la primera que casa; cada una con sus grupos', () => {
    const compiled = compileConfig(normalizeConfig({
        rules: [
            { name: 'T1', keywords: ['terminal 1'], replies: ['Voy a la T1'] },
            { name: 'Solo G2', keywords: ['aeropuerto'], replies: ['G2'], groups: [G2] },
            { name: 'General', keywords: ['aeropuerto'], replies: ['General'] },
        ],
    }));
    assert.equal(findRule(compiled, G1, normalizeText('en la terminal 1 y el aeropuerto')).rule.name, 'T1');
    assert.equal(findRule(compiled, G2, normalizeText('aeropuerto')).rule.name, 'Solo G2');
    assert.equal(findRule(compiled, G1, normalizeText('aeropuerto')).rule.name, 'General');
    assert.equal(findRule(compiled, G1, normalizeText('hola')).rule, null);
});

test('exclusiones: anulan la regla y se puede pasar a la siguiente', () => {
    const compiled = compileConfig(normalizeConfig({
        rules: [
            { name: 'A', keywords: ['aeropuerto'], exclude: ['no voy', 'mañana'] },
            { name: 'B', keywords: ['urgente'] },
        ],
    }));
    const r1 = evaluate(compiled, { groupId: G1, text: 'No voy al aeropuerto' });
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'excluded');
    assert.equal(r1.excluded[0].by, 'no voy');
    assert.equal(evaluate(compiled, { groupId: G1, text: 'aeropuerto MAÑANA' }).reason, 'excluded'); // sin acentos
    assert.equal(evaluate(compiled, { groupId: G1, text: 'no voy al aeropuerto, urgente' }).ruleName, 'B');
    assert.equal(evaluate(compiled, { groupId: G1, text: 'voy al aeropuerto' }).ok, true);
});

test('evaluate explica por qué no respondería', () => {
    const compiled = compileConfig(normalizeConfig({
        rules: [{ keywords: ['aeropuerto'] }],
        allowed_groups: [G1], allowed_users: ['1@c.us'],
        schedule: { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' },
    }));
    const lunes10 = at(1, 10);
    assert.equal(evaluate(compiled, { groupId: '1@c.us', text: 'aeropuerto' }).reason, 'not_group');
    assert.equal(evaluate(compiled, { groupId: G2, user: '1@c.us', text: 'aeropuerto', date: lunes10 }).reason, 'group');
    assert.equal(evaluate(compiled, { groupId: G1, user: '1@c.us', text: 'hola', date: lunes10 }).reason, 'no_keyword');
    assert.equal(evaluate(compiled, { groupId: G1, user: '2@c.us', text: 'aeropuerto', date: lunes10 }).reason, 'user');
    assert.equal(evaluate(compiled, { groupId: G1, user: '1@c.us', text: 'aeropuerto', date: at(0, 10) }).reason, 'schedule');
    assert.equal(evaluate(compiled, { groupId: G1, user: '1@c.us', text: 'aeropuerto', date: lunes10, paused: true }).reason, 'paused');
    const ok = evaluate(compiled, { groupId: G1, user: '1@c.us', text: 'aeropuerto', date: lunes10 });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.replies, ['Yo, estoy al tanto.']);
});

test('horario: días, tramos, solo días, solo horas y cruce de medianoche', () => {
    assert.equal(inSchedule({ days: [], from: '', to: '' }, at(0, 3)), true);
    const lv = { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' };
    assert.equal(inSchedule(lv, at(1, 8)), true);
    assert.equal(inSchedule(lv, at(1, 17, 59)), true);
    assert.equal(inSchedule(lv, at(1, 18)), false);
    assert.equal(inSchedule(lv, at(6, 10)), false); // sábado
    assert.equal(inSchedule({ days: [6, 0], from: '', to: '' }, at(6, 23)), true);
    assert.equal(inSchedule({ days: [], from: '09:00', to: '' }, at(3, 8)), false);
    const noche = { days: [5], from: '22:00', to: '06:00' }; // viernes noche
    assert.equal(inSchedule(noche, at(5, 23)), true);
    assert.equal(inSchedule(noche, at(6, 5)), true); // madrugada del sábado cuenta como viernes
    assert.equal(inSchedule(noche, at(6, 7)), false);
    assert.equal(inSchedule(noche, at(4, 23)), false); // jueves
});

test('varias respuestas: elige una y no repite la última del grupo', () => {
    const rule = { replies: ['A', 'B', 'C'] };
    for (let i = 0; i < 50; i++) assert.notEqual(pickReply(rule, 'B'), 'B');
    assert.equal(pickReply({ replies: ['Solo'] }, 'Solo'), 'Solo');
    assert.equal(pickReply({ replies: [] }), 'Yo, estoy al tanto.');
});
