// API local del panel: REST (acciones) + SSE (eventos en vivo) + archivos de la UI.
// Solo módulos de Node, sin dependencias.
//
// Seguridad:
// - escucha en 127.0.0.1 por defecto
// - token aleatorio por arranque: se entra con /login?token=… (queda en una
//   cookie HttpOnly + SameSite=Strict) o con la cabecera Authorization: Bearer …
// - comprobación de Host (contra DNS rebinding) y de Origin
// - las peticiones que cambian algo exigen la cabecera X-WSPanel: 1 (contra CSRF)
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { qrToSvg } = require('./qr-svg');

const MAX_BODY = 1024 * 1024;
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2',
};

const RAW = Symbol('respuesta ya enviada');

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

const safeEqual = (a, b) => {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) { reject(new HttpError(413, 'cuerpo demasiado grande')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON inválido')); }
        });
        req.on('error', reject);
    });
}

function createApiServer(panel, {
    host = '127.0.0.1', port = 0, token = crypto.randomBytes(24).toString('hex'), uiDir = path.join(__dirname, 'ui'),
    desktop = null, // createDesktop() (acceso directo / arranque con el sistema)
    onQuit = null, // cerrar el panel desde la interfaz
} = {}) {
    const clients = new Set(); // respuestas SSE abiertas
    let actualPort = port;
    const lan = host === '0.0.0.0' || host === '::';

    const allowedHosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`, `${host}:${actualPort}`]);

    const send = (res, status, body, headers = {}) => {
        const data = typeof body === 'string' ? body : JSON.stringify(body);
        res.writeHead(status, {
            'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...headers,
        });
        res.end(data);
    };

    // ---------- rutas ----------
    const routes = [];
    const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
    const I = '/api/instances/([a-z0-9_-]+)';

    route('GET', '/api/state', () => panel.snapshot());
    route('GET', `${I}/history`, ({ m, url }) => panel.history(m[1], Number(url.searchParams.get('limit')) || 300));
    route('GET', `${I}/qr.svg`, ({ m, res }) => {
        const qr = panel.snapshot().instances[m[1]] && panel.snapshot().instances[m[1]].qr;
        if (!qr) throw new HttpError(404, 'no hay QR ahora mismo');
        const svg = qrToSvg(qr, { botDir: panel.botDir });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(svg);
        return RAW;
    });
    route('POST', `${I}/start`, ({ m }) => panel.start(m[1]));
    route('POST', `${I}/stop`, ({ m }) => panel.stop(m[1]));
    route('POST', `${I}/restart`, ({ m }) => panel.restart(m[1]));
    route('POST', `${I}/logout`, ({ m }) => panel.logout(m[1]));
    route('POST', `${I}/pause`, ({ m, body }) => panel.pause(m[1], Boolean(body.paused)));
    route('GET', `${I}/config`, ({ m }) => panel.getConfig(m[1]));
    route('PUT', `${I}/config`, ({ m, body }) => panel.saveConfig(m[1], body));
    route('POST', `${I}/allow`, ({ m, body }) => {
        if (typeof body.value !== 'string' || !body.value) throw new HttpError(400, '"value" requerido');
        return panel.allow(m[1], body.list, body.value, body.on !== false);
    });
    route('GET', `${I}/groups`, ({ m, url }) => panel.groups(m[1], { refresh: url.searchParams.has('refresh') }));
    route('GET', `${I}/contacts`, ({ m, url }) => panel.contacts(m[1], { refresh: url.searchParams.has('refresh') }));
    route('POST', `${I}/send`, ({ m, body }) => panel.send(m[1], body.to, body.text));
    // solo en modo --fake: simular un mensaje entrante (demos y pruebas de la UI)
    if (panel.snapshot().fake) {
        route('POST', `${I}/simulate`, ({ m, body }) => {
            panel.mgr.injectFakeMessage(m[1], { from: String(body.from || ''), author: String(body.author || ''), body: String(body.body || '') });
            return { ok: true };
        });
    }
    route('POST', `${I}/test`, ({ m, body }) => panel.testMessage(m[1], body));
    route('GET', `${I}/stats`, ({ m, url }) => panel.stats(m[1], Number(url.searchParams.get('days')) || 14));
    route('GET', '/api/desktop', () => (desktop ? desktop.status() : { supported: false }));
    route('PUT', '/api/desktop', ({ body }) => {
        if (!desktop) throw new HttpError(400, 'No disponible');
        return desktop.set({ launcher: body.launcher, autostart: body.autostart });
    });
    route('POST', '/api/quit', () => {
        if (!onQuit) throw new HttpError(400, 'No disponible');
        setTimeout(onQuit, 200); // responder antes de cerrar
        return { ok: true };
    });
    route('GET', '/api/telegram', () => panel.getTelegramConfig());
    route('PUT', '/api/telegram', ({ body }) => panel.setTelegramConfig({
        token: body.token,
        chatId: body.chatId,
        allowedUserIds: Array.isArray(body.allowedUserIds) ? body.allowedUserIds : undefined,
    }));
    route('POST', '/api/telegram/test', () => panel.telegramTest());
    route('GET', '/api/browser', () => panel.browserStatus());
    route('PUT', '/api/browser', ({ body }) => {
        const r = panel.setBrowserPath(body.path || '');
        if (!r.ok) throw new HttpError(400, r.error);
        return r;
    });

    // ---------- eventos en vivo (SSE) ----------
    function openEvents(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`retry: 2000\nevent: snapshot\ndata: ${JSON.stringify(panel.snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
    }
    const onBotEvent = (id, ev) => {
        const msg = `event: bot\ndata: ${JSON.stringify({ id, ev })}\n\n`;
        for (const res of clients) res.write(msg);
    };
    panel.mgr.on('event', onBotEvent);
    const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);
    heartbeat.unref();

    // ---------- archivos de la UI ----------
    function serveStatic(res, pathname) {
        const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
        const file = path.resolve(uiDir, rel);
        if (file !== uiDir && !file.startsWith(uiDir + path.sep)) throw new HttpError(404, 'no encontrado');
        let data;
        try { data = fs.readFileSync(file); } catch { throw new HttpError(404, 'no encontrado'); }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        });
        res.end(data);
    }

    // ---------- despachador ----------
    async function handle(req, res) {
        const url = new URL(req.url, 'http://x');

        if (!lan && !allowedHosts().has(String(req.headers.host || '').toLowerCase())) {
            throw new HttpError(421, 'host no permitido');
        }
        const origin = req.headers.origin;
        if (origin && origin !== 'null' && !allowedHosts().has(origin.replace(/^https?:\/\//, '').toLowerCase()) && !lan) {
            throw new HttpError(403, 'origen no permitido');
        }

        if (url.pathname === '/login') {
            if (!safeEqual(url.searchParams.get('token'), token)) throw new HttpError(401, 'token incorrecto');
            res.writeHead(302, {
                'Set-Cookie': `wspanel=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
                Location: '/',
                'Cache-Control': 'no-store',
            });
            return res.end();
        }

        const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const authed = safeEqual(parseCookies(req.headers.cookie).wspanel, token) || safeEqual(bearer, token);
        if (!authed) throw new HttpError(401, 'no autorizado: abre el enlace del panel que aparece al arrancar');

        if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-wspanel'] !== '1') {
            throw new HttpError(403, 'falta la cabecera X-WSPanel');
        }

        if (url.pathname === '/api/events' && req.method === 'GET') return openEvents(req, res);

        if (url.pathname.startsWith('/api/')) {
            const candidates = routes.filter((r) => r.re.test(url.pathname));
            if (!candidates.length) throw new HttpError(404, 'ruta desconocida');
            const r = candidates.find((c) => c.method === req.method);
            if (!r) throw new HttpError(405, 'método no permitido');
            const body = req.method === 'GET' ? {} : await readJson(req);
            const result = await r.handler({ m: url.pathname.match(r.re), url, body, req, res });
            if (result === RAW) return undefined;
            return send(res, 200, result === undefined ? { ok: true } : result);
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'método no permitido');
        return serveStatic(res, url.pathname);
    }

    const server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
            const msg = String(e.message || e);
            const status = e.status
                || (/rpc timeout/i.test(msg) ? 504 : /no está en marcha|no lista/i.test(msg) ? 409 : /requiere/i.test(msg) ? 400 : 500);
            if (!res.headersSent) send(res, status, { error: msg });
            else res.end();
        });
    });

    return {
        token,
        get port() { return actualPort; },
        get url() { return `http://${lan ? '127.0.0.1' : host}:${actualPort}/`; },
        get loginUrl() { return `${this.url}login?token=${token}`; },
        listen() {
            return new Promise((resolve, reject) => {
                const tryListen = (p, fallback) => {
                    server.once('error', (e) => {
                        if (e.code === 'EADDRINUSE' && fallback) return tryListen(0, false); // puerto ocupado → uno libre
                        reject(e);
                    });
                    server.listen(p, host, () => { actualPort = server.address().port; resolve(this); });
                };
                tryListen(port, port !== 0);
            });
        },
        close() {
            clearInterval(heartbeat);
            panel.mgr.off('event', onBotEvent);
            for (const res of clients) res.end();
            clients.clear();
            return new Promise((r) => server.close(() => r()));
        },
    };
}

module.exports = { createApiServer, HttpError };
