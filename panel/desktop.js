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
        // Windows: WScript.Shell.Run con 0 = sin ventana de consola
        const vbq = (s) => String(s).replace(/"/g, '""');
        return [
            "' WSPanel: generado por el panel. Puedes borrarlo desde Ajustes.",
            'Set sh = CreateObject("WScript.Shell")',
            `sh.CurrentDirectory = "${vbq(path.win32.dirname(appEntry))}"`,
            `sh.Run """${vbq(nodePath)}"" ""${vbq(appEntry)}""${background ? ' --no-open' : ''}", 0, False`,
            '',
        ].join('\r\n');
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
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, content(kind), { mode: platform === 'linux' ? 0o755 : 0o644 });
            } else {
                try { fs.unlinkSync(file); } catch { /* ya no estaba */ }
            }
        }
        return status();
    }

    return { status, set, supported, content };
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
