const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { watchConfig } = require('../lib/config');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('hot-reload: aplica cambios válidos, ignora YAML roto y renames atómicos funcionan', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsbot-watch-'));
    const file = path.join(dir, 'config-x.yaml');
    fs.writeFileSync(file, 'keywords: [a]\n');
    const changes = [];
    const errors = [];
    const w = watchConfig(file, { onChange: (c) => changes.push(c), onError: (e) => errors.push(e), debounceMs: 50 });
    try {
        fs.writeFileSync(file, 'keywords: [roto');
        await tick(200);
        assert.equal(changes.length, 0);
        assert.ok(errors.length >= 1);

        fs.writeFileSync(file + '.tmp', 'keywords: [b]\n');
        fs.renameSync(file + '.tmp', file); // como guarda el panel
        await tick(200);
        assert.equal(changes.length, 1);
        assert.deepEqual(changes[0].rules[0].keywords, ['b']);

        fs.writeFileSync(file, 'keywords: [b]\n'); // mismo contenido → sin evento
        await tick(200);
        assert.equal(changes.length, 1);
    } finally {
        w.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
