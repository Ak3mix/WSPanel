// El parche de whatsapp-web.js (patches/, aplicado por patch-package en cada
// instalación) debe estar presente. En CI esto se comprueba tras un `npm ci` limpio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WWEBJS = path.dirname(require.resolve('whatsapp-web.js/package.json'));
const read = (rel) => fs.readFileSync(path.join(WWEBJS, rel), 'utf8');

test('versión de whatsapp-web.js a la que corresponde el parche', () => {
    const v = require(path.join(WWEBJS, 'package.json')).version;
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'patches', `whatsapp-web.js+${v}.patch`)),
        `no hay parche para whatsapp-web.js ${v}: hay que portarlo antes de actualizar`);
});

test('inject() espera a que WAWebSocketModel exista (fallo "reading \'Socket\'" con red lenta)', () => {
    const src = read('src/Client.js');
    const wait = src.indexOf("window.require?.('WAWebSocketModel')?.Socket?.state");
    const use = src.indexOf('await this.pupPage.evaluate(ExposeAuthStore);');
    assert.ok(wait > 0, 'falta la espera del módulo en inject()');
    assert.ok(use > wait, 'la espera debe ir ANTES de ExposeAuthStore');
});

test('se conserva el parche de los ids de mensaje (getMsgKeyId)', () => {
    assert.match(read('src/util/Injected/Utils.js'), /getMsgKeyId\(newMsgKey\)/);
});
