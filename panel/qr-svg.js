// QR → SVG usando el codificador que ya trae qrcode-terminal (sin dependencias nuevas).
const path = require('path');

function loadEncoder(botDir) {
    const base = path.dirname(require.resolve('qrcode-terminal/package.json', { paths: [botDir] }));
    return {
        QRCode: require(path.join(base, 'vendor', 'QRCode')),
        ECL: require(path.join(base, 'vendor', 'QRCode', 'QRErrorCorrectLevel')),
    };
}

function qrToSvg(text, { botDir, margin = 2, level = 'M' } = {}) {
    const { QRCode, ECL } = loadEncoder(botDir);
    const qr = new QRCode(-1, ECL[level]);
    qr.addData(String(text));
    qr.make();
    const n = qr.getModuleCount();
    const size = n + margin * 2;
    let d = '';
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
        + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

module.exports = { qrToSvg };
