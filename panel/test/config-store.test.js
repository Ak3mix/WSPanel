const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConfigStore } = require('../config-store');
const { createPanel } = require('../panel-core');

const BOT_DIR = path.resolve(__dirname, '..', '..', 'bot');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wspanel-cfg-'));

test('load crea plantilla, save normaliza y no deja temporales', () => {
    const dataDir = tmp();
    const store = createConfigStore({ dataDir, botDir: BOT_DIR });
    const cfg = store.load('personal');
    assert.deepEqual(cfg.rules, []);
    assert.ok(fs.existsSync(store.file('personal')));
    const saved = store.save('personal', { ...cfg, rules: [{ keywords: ['a', 'a', ' b '], replies: ['r'] }], reply_delay_ms: 0, mi_clave: 1 });
    assert.deepEqual(saved.rules[0].keywords, ['a', 'b']);
    assert.equal(store.load('personal').reply_delay_ms, 0);
    assert.equal(store.load('personal').mi_clave, 1);
    assert.deepEqual(fs.readdirSync(dataDir), ['config-personal.yaml']);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('load no sobrescribe un YAML roto', () => {
    const dataDir = tmp();
    const store = createConfigStore({ dataDir, botDir: BOT_DIR });
    fs.writeFileSync(store.file('personal'), 'keywords: [roto');
    assert.throws(() => store.load('personal'));
    assert.equal(fs.readFileSync(store.file('personal'), 'utf8'), 'keywords: [roto');
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('allow parte del disco y no pisa cambios externos', async () => {
    const dataDir = tmp();
    const panel = createPanel({ dataDir, botDir: BOT_DIR });
    fs.writeFileSync(path.join(dataDir, 'config-personal.yaml'), 'keywords: [editado_a_mano]\n');
    panel.allow('personal', 'allowed_groups', '1@g.us');
    const cfg = panel.configs.load('personal');
    assert.deepEqual(cfg.rules[0].keywords, ['editado_a_mano']);
    assert.deepEqual(cfg.allowed_groups, ['1@g.us']);
    panel.allow('personal', 'allowed_groups', '1@g.us', false);
    assert.deepEqual(panel.configs.load('personal').allowed_groups, []);
    assert.throws(() => panel.allow('personal', 'otra', 'x'));
    await panel.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('config de Telegram: se guarda con token enmascarado', async () => {
    const dataDir = tmp();
    const panel = createPanel({ dataDir, botDir: BOT_DIR, fetchImpl: async () => ({ json: async () => ({ ok: true, result: [] }) }) });
    const c = panel.setTelegramConfig({ token: '123456789:ABCDEFGHIJ', chatId: '-100', allowedUserIds: [7] });
    assert.equal(c.configured, true);
    assert.equal(c.tokenMasked, '123456••••GHIJ');
    assert.deepEqual(c.allowedUserIds, ['7']);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(path.join(dataDir, 'panel-config.yaml')).mode & 0o777, 0o600);
    }
    await panel.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
});
