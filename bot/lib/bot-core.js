// Núcleo del bot: eventos de WhatsApp, filtrado, auto-respuesta y RPC.
// Recibe el `client` (whatsapp-web.js o el falso de tests) y el protocolo por
// inyección, así que se puede probar sin navegador.
const { normalizeText, compileConfig, findRule, pickReply, inSchedule } = require('./filter');
const { diffConfig } = require('./config');
const { Cooldown } = require('./cooldown');
const { createLists, LIMITS } = require('./wa-lists');

// Códigos de salida que entiende el InstanceManager del panel
const EXIT = Object.freeze({
    OK: 0,
    ERROR: 1, // fallo inesperado → el panel reintenta
    DISCONNECTED: 3, // WhatsApp desconectó → el panel reintenta
    LOGGED_OUT: 4, // sesión cerrada → no reintentar (hace falta QR)
    AUTH_FAILURE: 5, // sesión inválida → no reintentar
    CONFIG: 78, // configuración inválida o el navegador no arranca → no reintentar
    BROWSER_MISSING: 79, // no hay navegador Chromium instalado → no reintentar
});

// primeras líneas de la traza (para diagnosticar caídas sin inundar el registro)
const stackOf = (e) => String((e && e.stack) || '').split('\n').slice(0, 12).map((l) => l.trim()).join('\n');

const NEEDS_READY = new Set(['FETCH_GROUPS', 'FETCH_CONTACTS', 'SEND_MESSAGE', 'LOGOUT']);
const VALID_CHAT_ID = /^[\w.-]+@(c\.us|g\.us)$/;

function createBot({ client, protocol, lid, config, paused = false, exit, sleep, now = Date.now, listLimits, clock = () => performance.now() }) {
    const { say, log } = protocol;
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    let cfg = config;
    let rules = compileConfig(cfg);
    const lastReply = new Map(); // grupo -> última respuesta (para no repetir si hay varias)
    let status = 'connecting';
    let isPaused = Boolean(paused);
    let exiting = false;
    const cooldown = new Cooldown(cfg.cooldown_ms, now);
    const groupNames = new Map();
    let contactsCache = [];
    const lists = createLists(client, { limits: listLimits || LIMITS, log });

    function setStatus(v, extra) {
        status = v;
        say({ type: 'status', value: v, ...extra });
    }

    async function shutdown(code, reason) {
        if (exiting) return;
        exiting = true;
        log('CORE', 'Shutting down', { code, reason });
        if (lid) lid.saveNow();
        try {
            await Promise.race([Promise.resolve(client.destroy()), wait(4000)]);
        } catch { /* noop */ }
        exit(code);
    }

    // ---------- filtrado ----------
    async function isUserAllowed(author) {
        if (!rules.users) return true;
        if (!author) return false;
        if (rules.users.has(author)) return true; // @c.us directo
        if (!author.endsWith('@lid') || !lid) return false;
        const pn = await lid.toPhone(author); // caché O(1); red solo la 1ª vez por @lid
        return Boolean(pn && rules.users.has(pn));
    }

    async function groupName(msg, groupId) {
        if (groupNames.has(groupId)) return groupNames.get(groupId);
        try {
            const chat = await msg.getChat();
            const name = (chat && chat.name) || groupId;
            groupNames.set(groupId, name);
            return name;
        } catch {
            return groupId;
        }
    }

    // Orden: de lo más barato a lo más caro. Los mensajes que no son de un grupo
    // permitido o no traen keyword se descartan sin tocar el navegador.
    async function handleMessage(msg) {
        const t0 = clock(); // llegada del mensaje al bot (para medir el tiempo de respuesta)
        if (!msg || msg.fromMe) return;
        const groupId = String(msg.from || '');
        if (!groupId.endsWith('@g.us')) return;
        if (rules.groups && !rules.groups.has(groupId)) return;

        const text = normalizeText(msg.body);
        const match = findRule(rules, groupId, text);
        const author = String(msg.author || '').trim();
        if (cfg.debug) {
            log('MESSAGE', 'Incoming message', { group_id: groupId, author, text: msg.body, keyword: match.rule ? match.keyword : null });
        }
        if (!match.rule) {
            if (match.excluded.length) {
                const e = match.excluded[0];
                log('FILTER', 'Excluded word — skipping reply', { group_id: groupId, keyword: e.keyword, excluded_by: e.by, rule: e.rule.name || e.rule.index + 1 });
            }
            return;
        }
        const { rule, keyword } = match;

        if (!(await isUserAllowed(author))) {
            if (cfg.debug) log('FILTER', 'User not allowed', { author, group_id: groupId });
            return;
        }
        if (rules.schedule && !inSchedule(rules.schedule, new Date(now()))) {
            log('FILTER', 'Outside schedule — skipping reply', { group_id: groupId, keyword });
            return;
        }
        if (isPaused) {
            log('FILTER', 'Paused — skipping reply', { group_id: groupId, keyword });
            return;
        }
        if (!cooldown.take(groupId)) {
            log('FILTER', 'Cooldown — skipping reply', { group_id: groupId, cooldown_ms: cfg.cooldown_ms });
            return;
        }

        const delayMs = cfg.reply_delay_ms;
        if (delayMs > 0) await wait(delayMs);
        if (isPaused || exiting) return; // pausado durante la espera

        const reply = pickReply(rule, lastReply.get(groupId));
        lastReply.set(groupId, reply);
        await msg.reply(reply);
        // desde que llegó el mensaje hasta que WhatsApp aceptó la respuesta (incluye la espera configurada)
        const latencyMs = Math.max(0, Math.round(clock() - t0));
        const sender = (lid && lid.cachedPhone(author)) || author;
        const group = await groupName(msg, groupId);
        const ruleName = rule.name || `Regla ${rule.index + 1}`;
        log('REPLY', 'Auto-reply sent', { group, group_id: groupId, sender, keyword, rule: ruleName, latency_ms: latencyMs });
        // incluye el mensaje que disparó la respuesta (solo estos, no el resto del grupo)
        say({
            type: 'notification', event: 'auto_reply', group, group_id: groupId, sender, keyword, reply,
            rule: ruleName, text: String(msg.body || '').slice(0, 500),
            latency_ms: latencyMs, delay_ms: delayMs,
        });
    }

    // ---------- config ----------
    function applyConfig(next) {
        const changes = diffConfig(cfg, next);
        const usersChanged = 'allowed_users' in changes;
        cfg = next;
        rules = compileConfig(cfg);
        cooldown.setWindow(cfg.cooldown_ms);
        log('CONFIG', 'Config hot-reloaded', {
            rules_count: cfg.rules.length,
            groups_count: cfg.allowed_groups.length,
            users_count: cfg.allowed_users.length,
            changes: Object.keys(changes),
        });
        if (usersChanged && status === 'ready') warmAllowedUsers();
    }

    async function warmAllowedUsers() {
        if (!lid || !cfg.allowed_users.length) return;
        const r = await lid.warm(cfg.allowed_users);
        log('CACHE', `Pre-resolved ${r.resolved} new allowed_users to @lid`, { total: r.total });
    }

    // ---------- eventos del cliente ----------
    client.on('qr', (qr) => {
        say({ type: 'qr', qr });
        setStatus('qr');
        if (protocol.humanLogs) {
            try { require('qrcode-terminal').generate(qr, { small: true }, (s) => process.stderr.write(s + '\n')); } catch { /* noop */ }
        }
    });

    // WhatsApp Web puede emitir authenticated/ready varias veces seguidas al
    // vincular (reinyección de la página): solo se procesa la primera.
    client.on('authenticated', () => {
        if (status === 'authenticated' || status === 'ready') return;
        log('AUTH', 'Session authenticated');
        setStatus('authenticated');
    });

    client.on('auth_failure', (m) => {
        log('AUTH', 'Authentication failure', { message: String(m) });
        setStatus('auth_failure');
        shutdown(EXIT.AUTH_FAILURE, 'auth_failure');
    });

    client.on('ready', async () => {
        if (status === 'ready') return;
        log('READY', 'Bot connected and ready');
        setStatus('ready');
        if (isPaused) say({ type: 'paused', value: true });
        await warmAllowedUsers();
        if (!cfg.suppress_mobile_notifications && typeof client.sendPresenceUnavailable === 'function') {
            try {
                await client.sendPresenceUnavailable();
                log('READY', 'Presence set to unavailable — mobile notifications ON');
            } catch (e) {
                log('READY', 'sendPresenceUnavailable failed', { error: e.message });
            }
        }
    });

    client.on('disconnected', (reason) => {
        const r = String(reason);
        log('DISCONNECT', 'Client disconnected', { reason: r });
        if (r === 'LOGOUT') {
            setStatus('logged_out');
            shutdown(EXIT.LOGGED_OUT, r);
        } else {
            setStatus('disconnected');
            shutdown(EXIT.DISCONNECTED, r);
        }
    });

    client.on('message_create', (msg) => {
        handleMessage(msg).catch((e) =>
            log('ERROR', 'Message handler error', { error: e.message, stack: stackOf(e) })
        );
    });

    // ---------- RPC ----------
    const result = (id, data) => say({ type: 'rpc_result', id, ok: true, data });
    const failure = (id, error) => say({ type: 'rpc_result', id, ok: false, error });

    const handlers = {
        PING: () => ({ pong: true }),
        GET_STATE: () => ({ status, paused: isPaused }),
        SET_PAUSED: (req) => {
            isPaused = Boolean(req.value);
            say({ type: 'paused', value: isPaused });
            return { paused: isPaused };
        },
        // Listas ligeras y limitadas (ver lib/wa-lists.js). Contactos = solo la
        // agenda de la cuenta, no los participantes de los grupos.
        FETCH_GROUPS: async (req) => {
            const r = await lists.get('groups', { refresh: Boolean(req.refresh) });
            for (const g of r.items) groupNames.set(g.id, g.name || g.id);
            return { groups: r.items, total: r.total, truncated: r.truncated, cached: r.cached };
        },
        FETCH_CONTACTS: async (req) => {
            const r = await lists.get('contacts', { refresh: Boolean(req.refresh) });
            contactsCache = r.items;
            return { contacts: r.items, total: r.total, truncated: r.truncated, cached: r.cached };
        },
        SEARCH_CONTACTS: (req) => {
            const q = normalizeText(req.query);
            const matches = q
                ? contactsCache.filter((c) => normalizeText(c.name).includes(q) || c.id.includes(q))
                : [];
            return { matches: matches.slice(0, 100), count: matches.length };
        },
        SEND_MESSAGE: async (req) => {
            if (!VALID_CHAT_ID.test(String(req.to || '')) || typeof req.text !== 'string' || !req.text.trim()) {
                throw new Error('SEND_MESSAGE requiere "to" (…@c.us | …@g.us) y "text"');
            }
            await client.sendMessage(req.to, req.text);
            return { sent: true, to: req.to };
        },
        LOGOUT: async () => {
            setStatus('logging_out');
            try {
                await client.logout();
            } catch (e) {
                log('CORE', 'Remote logout failed, clearing local session anyway', { error: e.message });
                try { await client.authStrategy.logout(); } catch { /* noop */ }
            }
            setStatus('logged_out');
            setTimeout(() => shutdown(EXIT.LOGGED_OUT, 'logout'), 500);
            return { loggedOut: true };
        },
    };

    async function handleRequest(req) {
        if (req.type === 'shutdown') return shutdown(EXIT.OK, 'requested');
        if (req.type !== 'rpc') return;
        const fn = handlers[req.cmd];
        if (!fn) return failure(req.id, 'unknown cmd: ' + req.cmd);
        if (NEEDS_READY.has(req.cmd) && status !== 'ready') {
            return failure(req.id, `instancia no lista (estado: ${status})`);
        }
        try {
            result(req.id, await fn(req));
        } catch (e) {
            failure(req.id, e.message || String(e));
        }
    }

    async function start() {
        log('CONFIG', 'Starting bot', {
            debug: cfg.debug,
            rules_count: cfg.rules.length,
            groups_count: cfg.allowed_groups.length,
            users_count: cfg.allowed_users.length,
            schedule: rules.schedule ? cfg.schedule : null,
            paused: isPaused,
        });
        setStatus('connecting');
        try {
            await client.initialize();
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            log('ERROR', 'Initialize failed', { error: msg, stack: stackOf(e) });
            const isBrowser = /browser was not found|executable|ENOENT|Failed to launch/i.test(msg);
            shutdown(isBrowser ? EXIT.CONFIG : EXIT.ERROR, 'initialize');
        }
    }

    return {
        start,
        handleRequest,
        handleMessage,
        applyConfig,
        shutdown,
        get status() { return status; },
        get paused() { return isPaused; },
        get config() { return cfg; },
    };
}

module.exports = { createBot, EXIT, stackOf };
