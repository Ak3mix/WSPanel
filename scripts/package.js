#!/usr/bin/env node
// Crea el paquete portable de WSPanel para el sistema en el que se ejecuta.
// Lo usa el workflow de GitHub Actions (uno por sistema) y se puede lanzar a mano:
//
//   node scripts/package.js --version 2.1.0 [--out dist] [--reuse-deps]
//
// --reuse-deps       copia bot/node_modules ya instalado en vez de instalar desde
//                    cero (solo para pruebas locales sin red).
// --node-from <ruta> binario de Node a incluir (por defecto, el que ejecuta el
//                    script). Debe ser autónomo, como el oficial de nodejs.org.
//
// Resultado: dist/WSPanel-<versión>-<plataforma>-x64/WSPanel/
//   node/        Node de este sistema (el mismo que ejecuta el script)
//   app/bot      bot + dependencias de producción (whatsapp-web.js parcheado)
//   app/panel    panel + interfaz
//   data/        (vacío) configuración, sesiones e historial del usuario
//   WSPanel.vbs / WSPanel (consola).cmd   (Windows)   ·   wspanel (Linux/macOS)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const version = String(arg('--version', require(path.join(ROOT, 'panel', 'package.json')).version)).replace(/^v/, '');
const outRoot = path.resolve(arg('--out', path.join(ROOT, 'dist')));
const reuseDeps = argv.includes('--reuse-deps');
const nodeFrom = path.resolve(arg('--node-from', process.execPath));

const plat = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform] || process.platform;
const arch = process.arch === 'x64' ? 'x64' : process.arch;
const name = `WSPanel-${version}-${plat}-${arch}`;
const pkgDir = path.join(outRoot, name, 'WSPanel');
const isWin = process.platform === 'win32';

const log = (m) => console.log(`[package] ${m}`);
const npm = isWin ? 'npm.cmd' : 'npm';

function copy(src, dst, filter = () => true) {
    fs.cpSync(src, dst, { recursive: true, dereference: true, filter: (s) => filter(s) });
}

// ---------- 1. limpiar ----------
fs.rmSync(path.join(outRoot, name), { recursive: true, force: true });
fs.mkdirSync(pkgDir, { recursive: true });
log(`${name} → ${pkgDir}`);

// ---------- 2. bot ----------
const botSrc = path.join(ROOT, 'bot');
const botDst = path.join(pkgDir, 'app', 'bot');
fs.mkdirSync(botDst, { recursive: true });
for (const f of ['bot.js', 'package.json', 'package-lock.json']) fs.copyFileSync(path.join(botSrc, f), path.join(botDst, f));
copy(path.join(botSrc, 'lib'), path.join(botDst, 'lib'));
copy(path.join(botSrc, 'patches'), path.join(botDst, 'patches'));

if (reuseDeps) {
    log('copiando bot/node_modules existente (--reuse-deps)');
    copy(path.join(botSrc, 'node_modules'), path.join(botDst, 'node_modules'), (s) => !s.includes(`${path.sep}.cache${path.sep}`));
} else {
    log('instalando dependencias del bot (npm ci + parche)…');
    const env = { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1', PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: '1' };
    execFileSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: botDst, env, stdio: 'inherit', shell: isWin });
    execFileSync(npm, ['prune', '--omit=dev', '--no-audit', '--no-fund'], { cwd: botDst, env, stdio: 'inherit', shell: isWin });
}
// los atajos de node_modules/.bin dependen del sistema y no hacen falta
fs.rmSync(path.join(botDst, 'node_modules', '.bin'), { recursive: true, force: true });

// comprobar que el parche de whatsapp-web.js está aplicado
const utils = fs.readFileSync(path.join(botDst, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js'), 'utf8');
if (!utils.includes('getMsgKeyId(newMsgKey)')) throw new Error('el parche de whatsapp-web.js NO está aplicado');
log('parche de whatsapp-web.js aplicado ✓');

// ---------- 3. panel ----------
const panelSrc = path.join(ROOT, 'panel');
const panelDst = path.join(pkgDir, 'app', 'panel');
fs.mkdirSync(panelDst, { recursive: true });
for (const f of fs.readdirSync(panelSrc)) {
    if (f.endsWith('.js') || f === 'package.json') fs.copyFileSync(path.join(panelSrc, f), path.join(panelDst, f));
}
copy(path.join(panelSrc, 'ui'), path.join(panelDst, 'ui'));
fs.writeFileSync(path.join(panelDst, 'portable.json'), JSON.stringify({ version, platform: plat, arch, builtAt: new Date().toISOString() }, null, 2));

// ---------- 4. Node ----------
const nodeDst = path.join(pkgDir, 'node', isWin ? 'node.exe' : 'node');
fs.mkdirSync(path.dirname(nodeDst), { recursive: true });
// El Node de algunas distribuciones (p. ej. el paquete de Ubuntu) es un lanzador
// de pocos KB que depende de libnode.so del sistema: no serviría en otro equipo.
const nodeSize = fs.statSync(nodeFrom).size;
if (nodeSize < 20 * 1024 * 1024) {
    throw new Error(`${nodeFrom} ocupa ${Math.round(nodeSize / 1024)} KB: no es un Node autónomo (depende de librerías del sistema). `
        + 'Usa el oficial de nodejs.org con --node-from <ruta/bin/node>.');
}
fs.copyFileSync(nodeFrom, nodeDst);
if (!isWin) fs.chmodSync(nodeDst, 0o755);
const nodeVer = execFileSync(nodeDst, ['--version'], { encoding: 'utf8' }).trim();
log(`Node ${nodeVer} incluido (${Math.round(nodeSize / 1048576)} MB)`);

// ---------- 5. lanzadores ----------
fs.mkdirSync(path.join(pkgDir, 'data'), { recursive: true });
if (isWin) {
    fs.writeFileSync(path.join(pkgDir, 'WSPanel.vbs'), [
        "' Abre WSPanel sin ventana de consola.",
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'dir = fso.GetParentFolderName(WScript.ScriptFullName)',
        'Set sh = CreateObject("WScript.Shell")',
        'sh.CurrentDirectory = dir & "\\app\\panel"',
        'sh.Run """" & dir & "\\node\\node.exe"" """ & dir & "\\app\\panel\\app.js""", 0, False',
        '',
    ].join('\r\n'));
    fs.writeFileSync(path.join(pkgDir, 'WSPanel (consola).cmd'), [
        '@echo off',
        'rem Igual que WSPanel.vbs pero mostrando los mensajes (útil si algo falla).',
        'cd /d "%~dp0app\\panel"',
        '"%~dp0node\\node.exe" app.js %*',
        'pause',
        '',
    ].join('\r\n'));
} else {
    const sh = path.join(pkgDir, 'wspanel');
    fs.writeFileSync(sh, [
        '#!/bin/sh',
        '# Abre WSPanel. Opciones: --no-open, --start, --fake… (ver LEEME.txt)',
        'DIR="$(cd "$(dirname "$0")" && pwd)"',
        'cd "$DIR/app/panel" || exit 1',
        'exec "$DIR/node/node" "$DIR/app/panel/app.js" "$@"',
        '',
    ].join('\n'));
    fs.chmodSync(sh, 0o755);
}

fs.writeFileSync(path.join(pkgDir, 'LEEME.txt'), [
    `WSPanel ${version} (${plat}-${arch})`,
    '',
    'CÓMO SE USA',
    isWin ? '  Doble clic en WSPanel.vbs.' : '  Ejecuta ./wspanel (o doble clic si tu escritorio lo permite).',
    '  Se abre el panel en una ventana del navegador. Desde Ajustes → Escritorio puedes',
    '  crear un acceso directo y hacer que arranque con el sistema.',
    '',
    'REQUISITOS',
    '  Google Chrome, Chromium, Microsoft Edge o Brave instalado (se usa el tuyo).',
    isWin ? '  En Windows 10/11 Edge ya viene instalado.' : '',
    '',
    'TUS DATOS',
    '  Todo se guarda en la carpeta data/: configuración, sesiones de WhatsApp,',
    '  historial y ajustes de Telegram. No la compartas: contiene tus sesiones.',
    '',
    'ACTUALIZAR',
    '  Cierra WSPanel (Ajustes → Cerrar WSPanel), descarga la versión nueva y copia',
    '  tu carpeta data/ dentro de ella (o sustituye solo app/ y node/).',
    '',
    isWin ? 'Si Windows muestra «Windows protegió su PC»: «Más información» → «Ejecutar de todas formas»'
        + ' (la aplicación no está firmada).' : '',
    '',
].join(isWin ? '\r\n' : '\n'));

// ---------- 6. comprobación rápida ----------
log('comprobando que arranca…');
const check = `
const path = require('path');
const dir = ${JSON.stringify(panelDst)};
const p = require(path.join(dir, 'paths.js'));
if (!p.isPortable) throw new Error('no detecta el modo portable');
if (p.DATA_DIR !== ${JSON.stringify(path.join(pkgDir, 'data'))}) throw new Error('carpeta de datos incorrecta: ' + p.DATA_DIR);
require(path.join(dir, 'panel-core.js'));
require(path.join(dir, 'server.js'));
require(path.join(p.BOT_DIR, 'lib', 'bot-core.js'));
require(require.resolve('whatsapp-web.js', { paths: [p.BOT_DIR] }));
console.log(p.VERSION + ' · datos en ' + p.DATA_DIR);`;
const env = { ...process.env };
delete env.WSPANEL_DATA_DIR;
delete env.WSPANEL_BOT_DIR;
const out = execFileSync(nodeDst, ['-e', check], { encoding: 'utf8', env }).trim();
log(`ok: ${out}`);
console.log(path.join(outRoot, name));
