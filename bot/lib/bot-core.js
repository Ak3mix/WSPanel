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

// Tiempos de la vigilancia de envío y de conexión (inyectables en tests)
const TIMINGS = Object.freeze({
    replyTimeoutMs: 45000, // máximo esperando a que WhatsApp confirme una respuesta
    healthIntervalMs: 60000, // cada cuánto se comprueba la conexión
    healthTimeoutMs: 20000, // máximo esperando a que la página conteste
    healthMisses: 3, // comprobaciones sin contestar seguidas → reiniciar
    stuckMs: 180000, // conexión fuera de CONNECTED tanto tiempo → reiniciar
});

const TIMEOUT = Symbol('timeout');
// Corre `p` con tiempo límite: resuelve TIMEOUT si no termina a tiempo (el
// rechazo tardío de `p` se silencia para no ensuciar el registro).
function within(p, ms) {
    let timer;
    const guarded = Promise.resolve(p);
    guarded.catch(() => {});
    return Promise.race([guarded, new Promise((r) => { timer = setTimeout(() => r(TIMEOUT), ms); })])
        .finally(() => clearTimeout(timer));
}

function createBot({ client, protocol, lid, config, paused = false, exit, sleep, now = Date.now, listLimits, clock = () => performance.now(), timings = {} }) {
    const T = { ...TIMINGS, ...timings };
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
        clearInterval(healthTimer);
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
        const arrivedAt = now();
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
        // por grupo, o una sola ventana para todos los grupos de la cuenta
        const coolKey = cfg.cooldown_scope === 'global' ? '*' : groupId;
        if (!cooldown.take(coolKey)) {
            log('FILTER', 'Cooldown — skipping reply', { group_id: groupId, cooldown_ms: cfg.cooldown_ms, scope: cfg.cooldown_scope });
            return;
        }

        const delayMs = cfg.reply_delay_ms;
        if (delayMs > 0) await wait(delayMs);
        if (isPaused || exiting) return; // pausado durante la espera

        const reply = pickReply(rule, lastReply.get(groupId));
        lastReply.set(groupId, reply);
        const { delivery, error } = await deliver(msg, reply);
        // desde que llegó el mensaje hasta que WhatsApp confirmó la respuesta (incluye la espera configurada)
        const latencyMs = Math.max(0, Math.round(clock() - t0));
        const sender = (lid && lid.cachedPhone(author)) || author;
        const group = await groupName(msg, groupId);
        const ruleName = rule.name || `Regla ${rule.index + 1}`;
        // antigüedad del mensaje al llegar al bot (hora de envío según WhatsApp): distingue
        // "llegó tarde" (red, mensaje sin descifrar) de "el bot tardó en responder"
        const ts = Number(msg.timestamp);
        const ageMs = ts > 0 ? Math.max(0, arrivedAt - ts * 1000) : undefined;
        const info = {
            group, group_id: groupId, sender, keyword, rule: ruleName, latency_ms: latencyMs,
            ...(ageMs !== undefined ? { age_ms: ageMs } : {}),
        };
        const original = String(msg.body || '').slice(0, 500);

        if (delivery === 'failed') {
            cooldown.release(coolKey); // no se respondió: que el siguiente mensaje sí pueda
            log('ERROR', 'Auto-reply failed', { ...info, error });
            say({ type: 'notification', event: 'reply_failed', ...info, reply, text: original, error });
            healthCheck(); // un envío fallido suele ser la conexión: comprobarla ya
            return;
        }
        if (delivery === 'unconfirmed') {
            log('REPLY', 'Auto-reply not confirmed by WhatsApp', { ...info, error });
            healthCheck();
        } else {
            log('REPLY', 'Auto-reply sent', info);
        }
        // incluye el mensaje que disparó la respuesta (solo estos, no el resto del grupo)
        say({ type: 'notification', event: 'auto_reply', ...info, reply, text: original, delay_ms: delayMs, delivery, ...(error ? { error } : {}) });
    }

    // ---------- envío con confirmación ----------
    // msg.reply() de whatsapp-web.js termina en cuanto el mensaje se crea en la
    // página (reloj ⏱), no cuando llega al servidor. Aquí se espera al resultado
    // real (waitUntilMsgSent + ack), siempre con tiempo límite. Sin sendSeen: marcar
    // el chat como leído es otra ida y vuelta al servidor que bloqueaba el envío
    // mientras la conexión se recuperaba.
    // → { delivery: 'sent' | 'unconfirmed' | 'failed', error? }
    const ackWaiters = new Map(); // id del mensaje → resolve(ack)
    client.on('message_ack', (m, ack) => {
        const id = m && m.id && m.id._serialized;
        const w = id && ackWaiters.get(id);
        if (w && (ack >= 1 || ack < 0)) w(ack);
    });
    const waitAck = (id, ms) => new Promise((resolve) => {
        const timer = setTimeout(() => { ackWaiters.delete(id); resolve(0); }, Math.max(0, ms));
        ackWaiters.set(id, (ack) => { clearTimeout(timer); ackWaiters.delete(id); resolve(ack); });
    });

    async function deliver(msg, text) {
        const started = now();
        const secs = Math.round(T.replyTimeoutMs / 1000);
        let sent;
        try {
            sent = await within(msg.reply(text, undefined, { sendSeen: false, waitUntilMsgSent: true }), T.replyTimeoutMs);
        } catch (e) {
            return { delivery: 'failed', error: (e && e.message) || String(e) };
        }
        if (sent === TIMEOUT) return { delivery: 'unconfirmed', error: `WhatsApp no confirmó el envío en ${secs} s` };
        if (!sent) return { delivery: 'failed', error: 'WhatsApp no creó el mensaje (¿chat no encontrado?)' };
        let ack = Number(sent.ack);
        if (!(ack >= 1 || ack < 0) && sent.id && sent.id._serialized) {
            ack = await waitAck(sent.id._serialized, T.replyTimeoutMs - (now() - started));
        }
        if (ack >= 1) return { delivery: 'sent' };
        if (ack < 0) return { delivery: 'failed', error: 'WhatsApp rechazó el mensaje' };
        return { delivery: 'unconfirmed', error: `WhatsApp no confirmó el envío en ${secs} s` };
    }

    // ---------- vigilancia de la conexión ----------
    // whatsapp-web.js da por buena una conexión en TIMEOUT/OPENING y no avisa si la
    // página se cuelga: la cuenta seguiría "conectada" sin recibir ni enviar.
    // Si la página no contesta varias veces seguidas, o la conexión lleva demasiado
    // fuera de CONNECTED, se sale con DISCONNECTED y el panel la reinicia.
    let healthTimer = null;
    let healthBusy = false;
    let healthMisses = 0;
    let badSince = null; // desde cuándo la conexión no está en CONNECTED

    function noteState(state) {
        if (state === 'CONNECTED') badSince = null;
        else if (badSince == null) badSince = now();
    }

    client.on('change_state', (state) => {
        log('STATE', 'Connection state', { state: String(state) });
        noteState(String(state));
    });

    async function healthCheck() {
        if (healthBusy || exiting || status !== 'ready' || typeof client.getState !== 'function') return;
        healthBusy = true;
        try {
            let state;
            try { state = await within(client.getState(), T.healthTimeoutMs); } catch { state = TIMEOUT; }
            if (exiting) return;
            if (state === TIMEOUT) {
                healthMisses++;
                log('STATE', 'WhatsApp Web did not answer the health check', { misses: healthMisses });
            } else {
                healthMisses = 0;
                noteState(String(state));
            }
            const stuckFor = badSince == null ? 0 : now() - badSince;
            if (healthMisses >= T.healthMisses || stuckFor >= T.stuckMs) {
                log('ERROR', 'Connection stuck — restarting', {
                    misses: healthMisses, state: state === TIMEOUT ? null : state, stuck_ms: stuckFor,
                });
                setStatus('disconnected');
                shutdown(EXIT.DISCONNECTED, 'watchdog');
            }
        } finally {
            healthBusy = false;
        }
    }

    function startHealth() {
        clearInterval(healthTimer);
        healthMisses = 0;
        badSince = null;
        healthTimer = setInterval(healthCheck, T.healthIntervalMs);
        if (healthTimer.unref) healthTimer.unref();
    }

    // ---------- config ----------
    function applyConfig(next) {
        const changes = diffConfig(cfg, next);
        const usersChanged = 'allowed_users' in changes;
        cfg = next;
        rules = compileConfig(cfg);
        cooldown.setWindow(cfg.cooldown_ms);
        if ('cooldown_scope' in changes) cooldown.clear(); // las claves cambian de significado
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
        startHealth();
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
            const sent = await within(client.sendMessage(req.to, req.text, { sendSeen: false, waitUntilMsgSent: true }), T.replyTimeoutMs);
            if (sent === TIMEOUT) throw new Error(`WhatsApp no confirmó el envío en ${Math.round(T.replyTimeoutMs / 1000)} s`);
            if (sent && Number(sent.ack) < 0) throw new Error('WhatsApp rechazó el mensaje');
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

module.exports = { createBot, EXIT, stackOf, TIMINGS };
