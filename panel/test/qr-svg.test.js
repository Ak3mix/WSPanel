const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { qrToSvg } = require('../qr-svg');

test('qrToSvg genera un SVG cuadrado con módulos', () => {
    const svg = qrToSvg('2@abcdefghijklmnopqrstuvwxyz,1234567890,ABCDEFG==', { botDir: path.resolve(__dirname, '..', '..', 'bot') });
    const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    assert.ok(m);
    assert.equal(m[1], m[2]);
    assert.ok(Number(m[1]) >= 25);
    assert.match(svg, /<path d="M/);
});
