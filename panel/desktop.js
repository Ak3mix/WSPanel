// Integración con el escritorio sin dependencias nativas:
// - acceso directo en el menú de aplicaciones
// - arranque con el sistema (en segundo plano, sin abrir ventana)
// - bloqueo de instancia única: si el panel ya está abierto, lanzarlo otra vez
//   solo abre su ventana.
//
// Linux: archivos .desktop (~/.local/share/applications y ~/.config/autostart).
// Windows: scripts .vbs (sin ventana de consola) en el Menú Inicio y en Inicio.
// macOS: no soportado todavía.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARK = 'WSPanel: generado por el panel'; // identifica los accesos que crea (y puede actualizar) WSPanel

function createDesktop({
    appEntry = path.join(__dirname, 'app.js'),
    iconPath = path.join(__dirname, 'ui', 'icon.svg'),
    nodePath = process.execPath,
    platform = process.platform,
    home = os.homedir(),
    env = process.env,
} = {}) {
    const p = platform === 'win32' ? path.win32 : path.posix;

    const paths = () => {
        if (platform === 'linux') {
            const xdgData = env.XDG_DATA_HOME || p.join(home, '.local', 'share');
            const xdgCfg = env.XDG_CONFIG_HOME || p.join(home, '.config');
            return {
                launcher: p.join(xdgData, 'applications', 'wspanel.desktop'),
                autostart: p.join(xdgCfg, 'autostart', 'wspanel.desktop'),
            };
        }
        if (platform === 'win32') {
            const appData = env.APPDATA || p.join(home, 'AppData', 'Roaming');
            const programs = p.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
            return { launcher: p.join(programs, 'WSPanel.vbs'), autostart: p.join(programs, 'Startup', 'WSPanel.vbs') };
        }
        return null;
    };

    const supported = () => Boolean(paths());

    function content(kind) {
        const background = kind === 'autostart'; // al iniciar sesión: bots en marcha, sin abrir ventana
        if (platform === 'linux') {
            const q = (s) => `"${String(s).replace(/(["\\\\`$])/g, '\\\\$1')}"`;
            return [
                `# ${MARK}`,
                '[Desktop Entry]',
                'Type=Application',
                'Name=WSPanel',
                'Comment=Panel de respuestas automáticas de WhatsApp',
                `Exec=${q(nodePath)} ${q(appEntry)}${background ? ' --no-open' : ''}`,
                `Path=${path.dirname(appEntry)}`,
                `Icon=${iconPath}`,
                'Terminal=false',
                'Categories=Network;Chat;',
                background ? 'X-GNOME-Autostart-enabled=true' : 'StartupNotify=true',
                '',
            ].join('\n');
        }
        // Windows: WScript.Shell.Run con 0 = sin ventana de consola.
        // Las rutas son absolutas: si la carpeta de WSPanel se mueve o se borra (p. ej.
        // al actualizar a una versión descomprimida en otro sitio), en vez del error de
        // Windows "no se puede encontrar la ruta" se explica qué pasó y se ofrece quitarlo.
        // Al abrir WSPanel desde su carpeta nueva, refresh() reescribe estas rutas.
        const vbq = (s) => String(s).replace(/"/g, '""');
        const what = background ? 'el arranque automático' : 'este acceso directo';
        return [
            `' ${MARK}. Puedes borrarlo desde Ajustes.`,
            'Set fso = CreateObject("Scripting.FileSystemObject")',
            `dir = "${vbq(path.win32.dirname(appEntry))}"`,
            `node = "${vbq(nodePath)}"`,
            `app = "${vbq(appEntry)}"`,
            'If Not fso.FileExists(node) Or Not fso.FileExists(app) Then',
            '    r = MsgBox("No se encuentra WSPanel en:" & vbCrLf & dir & vbCrLf & vbCrLf & _',
            '        "Seguramente esa carpeta se movió o se borró (por ejemplo, al actualizar). " & _',
            `        "Abre WSPanel desde su carpeta actual y ${what} se corregirá solo." & vbCrLf & vbCrLf & _`,
            `        "¿Quitar ${what} ahora?", vbExclamation + vbYesNo, "WSPanel")`,
            '    If r = vbYes Then fso.DeleteFile WScript.ScriptFullName',
            '    WScript.Quit 1',
            'End If',
            'Set sh = CreateObject("WScript.Shell")',
            'sh.CurrentDirectory = dir',
            `sh.Run """" & node & """ """ & app & """${background ? ' --no-open' : ''}", 0, False`,
            '',
        ].join('\r\n');
    }

    // Windows Script Host lee los .vbs en la codificación ANSI del sistema: en UTF-8
    // una ruta con tildes o ñ se estropea. Con BOM UTF-16LE la lee bien.
    const encode = (text) => (platform === 'win32'
        ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
        : Buffer.from(text, 'utf8'));
    const decode = (buf) => (buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le') : buf.toString('utf8'));

    function write(kind, file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, encode(content(kind)), { mode: platform === 'linux' ? 0o755 : 0o644 });
    }

    // Al arrancar: si hay accesos creados por WSPanel con otras rutas (carpeta movida
    // o versión nueva en otro sitio), se actualizan a la ubicación actual.
    // Devuelve los tipos reescritos.
    function refresh() {
        const ps = paths();
        if (!ps) return [];
        const fixed = [];
        for (const kind of ['launcher', 'autostart']) {
            let current;
            try { current = decode(fs.readFileSync(ps[kind])); } catch { continue; } // no existe
            if (!current.includes(MARK) || current === content(kind)) continue; // no es nuestro / ya al día
            try { write(kind, ps[kind]); fixed.push(kind); } catch { /* sin permisos: no crítico */ }
        }
        return fixed;
    }

    function status() {
        const ps = paths();
        if (!ps) return { supported: false, platform, launcher: false, autostart: false };
        return { supported: true, platform, launcher: fs.existsSync(ps.launcher), autostart: fs.existsSync(ps.autostart), paths: ps };
    }

    function set({ launcher, autostart } = {}) {
        const ps = paths();
        if (!ps) throw Object.assign(new Error('No disponible en este sistema'), { status: 400 });
        for (const [kind, want] of [['launcher', launcher], ['autostart', autostart]]) {
            if (want === undefined) continue;
            const file = ps[kind];
            if (want) {
                write(kind, file);
            } else {
                try { fs.unlinkSync(file); } catch { /* ya no estaba */ }
            }
        }
        return status();
    }

    return { status, set, supported, content, refresh };
}

// ---------- instancia única ----------

function lockFile(dataDir) { return path.join(dataDir, '.wspanel.lock'); }

function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Devuelve { url, token, port } del panel que ya está en marcha, o null.
async function findRunning(dataDir, { fetchImpl = globalThis.fetch } = {}) {
    let lock;
    try { lock = JSON.parse(fs.readFileSync(lockFile(dataDir), 'utf8')); } catch { return null; }
    if (!lock || !lock.pid || !lock.port || !lock.token || !pidAlive(lock.pid)) return null;
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetchImpl(`http://127.0.0.1:${lock.port}/api/state`, { headers: { Authorization: `Bearer ${lock.token}` }, signal: ctrl.signal });
        clearTimeout(t);
        if (r.status !== 200) return null;
    } catch { return null; }
    return { port: lock.port, token: lock.token, url: `http://127.0.0.1:${lock.port}/login?token=${lock.token}` };
}

function writeLock(dataDir, { port, token }) {
    fs.writeFileSync(lockFile(dataDir), JSON.stringify({ pid: process.pid, port, token }), { mode: 0o600 });
}

function removeLock(dataDir) {
    try {
        const lock = JSON.parse(fs.readFileSync(lockFile(dataDir), 'utf8'));
        if (lock.pid === process.pid) fs.unlinkSync(lockFile(dataDir));
    } catch { /* noop */ }
}

module.exports = { createDesktop, findRunning, writeLock, removeLock, lockFile };
