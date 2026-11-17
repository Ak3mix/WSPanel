const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeText, compileKeywords, matchKeyword, buildRules } = require('../lib/filter');
const { normalizeConfig, parseConfig } = require('../lib/config');
const { Cooldown } = require('../lib/cooldown');

test('normalizeText quita acentos, mayúsculas y espacios extra', () => {
    assert.equal(normalizeText('  AEROPUÉRTO   Terminal\n1 '), 'aeropuerto terminal 1');
    assert.equal(normalizeText(undefined), '');
});

test('keywords casan como palabra completa', () => {
    const kws = compileKeywords(['Terminal 1', 'Aeropuerto']);
    assert.equal(matchKeyword(normalizeText('Voy a la terminal 1.'), kws), 'terminal 1');
    assert.equal(matchKeyword(normalizeText('Estoy en la TERMINAL   1'), kws), 'terminal 1');
    assert.equal(matchKeyword(normalizeText('terminal 10 por favor'), kws), null);
    assert.equal(matchKeyword(normalizeText('aeropuerto'), kws), 'aeropuerto');
    assert.equal(matchKeyword(normalizeText('Aeropuértos'), kws), null);
    assert.equal(matchKeyword(normalizeText('al aeropuérto!'), kws), 'aeropuerto');
});

test('keywords con caracteres especiales no rompen la regex', () => {
    const kws = compileKeywords(['T1 (sur)', 'a+b']);
    assert.equal(matchKeyword(normalizeText('llego a T1 (sur) ya'), kws), 't1 (sur)');
    assert.equal(matchKeyword(normalizeText('a+b'), kws), 'a+b');
});

test('buildRules: listas vacías = todos permitidos', () => {
    const r = buildRules(normalizeConfig({}));
    assert.equal(r.groups, null);
    assert.equal(r.users, null);
    const r2 = buildRules(normalizeConfig({ allowed_groups: ['1@g.us'], allowed_users: ['2@c.us'] }));
    assert.ok(r2.groups.has('1@g.us'));
    assert.ok(r2.users.has('2@c.us'));
});

test('normalizeConfig respeta 0 y valida tipos', () => {
    const c = normalizeConfig({ reply_delay_ms: 0, keywords: ['a', '', null, 'a', 5], debug: 'yes', extra: 1 });
    assert.equal(c.reply_delay_ms, 0);
    assert.deepEqual(c.rules[0].keywords, ['a', '5']);
    assert.equal(c.debug, false);
    assert.equal(c.extra, 1);
    assert.equal(normalizeConfig({ reply_delay_ms: -5 }).reply_delay_ms, 1500);
});

test('parseConfig rechaza YAML que no es objeto', () => {
    assert.throws(() => parseConfig('- a\n- b'));
    assert.throws(() => parseConfig('keywords: [a'));
    assert.deepEqual(parseConfig('').rules, []);
});

test('Cooldown limita una respuesta por ventana', () => {
    let t = 1000;
    const c = new Cooldown(500, () => t);
    assert.equal(c.take('g'), true);
    assert.equal(c.take('g'), false);
    assert.equal(c.take('otro'), true);
    t += 500;
    assert.equal(c.take('g'), true);
    assert.equal(new Cooldown(0).take('g') && new Cooldown(0).take('g'), true);
});
