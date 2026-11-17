// Rutas centrales.
//
// - Desarrollo (repo): datos en la raíz del repo.
// - Paquete portable (scripts/package.js escribe panel/portable.json):
//     WSPanel/
//       node/        Node empaquetado
//       app/bot, app/panel
//       data/        config, sesiones, historial  ← sobrevive a las actualizaciones
// Variables de entorno (tests / despliegues): WSPANEL_DATA_DIR, WSPANEL_BOT_DIR.
const fs = require('fs');
const path = require('path');

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const PORTABLE = readJson(path.join(__dirname, 'portable.json')); // { version, platform, builtAt } o null
const isPortable = Boolean(PORTABLE);

const DATA_DIR = process.env.WSPANEL_DATA_DIR
    || (isPortable ? path.resolve(__dirname, '..', '..', 'data') : path.resolve(__dirname, '..'));

const BOT_DIR = process.env.WSPANEL_BOT_DIR || path.resolve(__dirname, '..', 'bot');

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

const VERSION = (PORTABLE && PORTABLE.version) || (readJson(path.join(__dirname, 'package.json')) || {}).version || 'dev';

// compatibilidad con el nombre anterior
const isPackaged = isPortable;

module.exports = { isPortable, isPackaged, DATA_DIR, BOT_DIR, SESSIONS_DIR, VERSION };
