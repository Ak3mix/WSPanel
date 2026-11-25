// Núcleo del panel sin UI: une instancias, config, Telegram y notificaciones.
// El futuro main.js de Electron solo tendrá que exponer estos métodos por IPC.
const fs = require('fs');
const path = require('path');
const { InstanceManager, INSTANCES } = require('./instances');
const { createConfigStore } = require('./config-store');
const { TelegramService } = require('./telegram');
const { Notifier } = require('./notifier');
const { createHistoryStore } = require('./history-store');

function createPanel({ dataDir, botDir, fake = false, managerOptions = {}, browserDetect = {}, fetchImpl, onError, version = 'dev' } = {}) {
    const yaml = require(require.resolve('js-yaml', { paths: [botDir] }));
    const panelCfgPath = path.join(dataDir, 'panel-config.yaml');

    const readPanelCfg = () => {
        try { return yaml.load(fs.readFileSync(panelCfgPath, 'utf8')) || {}; } catch { return {}; }
    };
    let panelCfg = readPanelCfg();

    const tgCfg = () => {
        const t = panelCfg.telegram || {};
        return {
            token: String(t.token || process.env.TELEGRAM_BOT_TOKEN || ''),
            chatId: String(t.chatId || process.env.TELEGRAM_GROUP_ID || ''),
            allowedUserIds: Array.isArray(t.allowed_user_ids) ? t.allowed_user_ids.map(String) : [],
        };
    };

    const savePanelCfg = () => {
        const tmp = panelCfgPath + '.tmp';
        fs.writeFileSync(tmp, yaml.dump(panelCfg), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, panelCfgPath);
    };

    const browserLib = require(path.join(botDir, 'lib', 'browser.js'));
    const browserOpts = { ...browserDetect }; // inyectable en tests

    const mgr = new InstanceManager({
        botDir,
        dataDir,
        extraArgs: fake ? ['--fake'] : [],
        ...managerOptions,
    });
    // la ruta elegida en el panel llega a cada bot como CHROME_PATH
    // (el chrome_path del YAML de una instancia sigue teniendo prioridad)
    const applyBrowserEnv = () => {
        if (panelCfg.browser_path) mgr.env.CHROME_PATH = panelCfg.browser_path;
        else delete mgr.env.CHROME_PATH;
    };
    applyBrowserEnv();
    const configs = createConfigStore({ dataDir, botDir });
    for (const i of INSTANCES) {
        try { configs.load(i.id); } catch { /* YAML roto: el bot lo reportará al arrancar */ }
    }
    // respuestas guardadas en disco (estadísticas, "respuestas hoy" y actividad tras reiniciar)
    const store = createHistoryStore({ dataDir, ids: INSTANCES.map((i) => i.id) });
    const filterLib = require(path.join(botDir, 'lib', 'filter.js'));

    const tg = new TelegramService(tgCfg, { fetchImpl, onError });
    const notifier = new Notifier(tg, mgr, {
        getAllowedUserIds: () => tgCfg().allowedUserIds,
        countToday: (id) => store.countToday(id),
        // botones de /status en Telegram: mismas acciones que el panel
        control: {
            start: (id) => startInstance(id),
            stop: (id) => actions.stop(id),
            restart: (id) => actions.restart(id),
        },
    });

    // ---------- preferencias por cuenta (se recuerdan entre arranques) ----------
    // instances: { personal: { autostart: true, paused: false }, ... }
    const prefs = (id) => (panelCfg.instances && panelCfg.instances[id]) || {};
    const setPref = (id, patch) => {
        const cur = prefs(id);
        if (Object.entries(patch).every(([k, v]) => cur[k] === v)) return;
        panelCfg = { ...panelCfg, instances: { ...(panelCfg.instances || {}), [id]: { ...cur, ...patch } } };
        try { savePanelCfg(); } catch { /* no crítico */ }
    };
    for (const i of INSTANCES) if (prefs(i.id).paused) mgr.state.get(i.id).paused = true; // pausa recordada

    // Historial por instancia: la UI lo pide al abrirse (los eventos en vivo van aparte)
    const HISTORY_MAX = 1000;
    const history = new Map(INSTANCES.map((i) => [i.id, []]));
    const lastQr = new Map();
    let seq = 0;
    for (const i of INSTANCES) {
        // la actividad reciente sobrevive al reinicio
        for (const e of store.recent(i.id, 200)) history.get(i.id).push({ seq: ++seq, type: 'notification', event: 'auto_reply', ...e });
    }
    mgr.on('event', (id, ev) => {
        if (ev.type === 'qr') lastQr.set(id, ev.qr);
        else if (ev.type === 'status' && ev.value !== 'qr') lastQr.delete(id);
        if (ev.type === 'status' && ev.value === 'ready') setPref(id, { autostart: true });
        if (ev.type === 'status' && (ev.value === 'logged_out' || ev.value === 'auth_failure')) setPref(id, { autostart: false });
        if (ev.type === 'paused') setPref(id, { paused: Boolean(ev.value) });
        if (ev.type === 'notification' && ev.event === 'auto_reply') store.add(id, ev);
        if (ev.type !== 'log' && ev.type !== 'notification') return;
        const arr = history.get(id);
        if (!arr) return;
        arr.push({ seq: ++seq, ts: Date.now(), ...ev });
        if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
    });
    mgr.on('event', (id, ev) => notifier.onEvent(ev, id));

    // registro de errores en disco (logs/<cuenta>.log): sobrevive a los reinicios del panel
    const errLogDir = path.join(dataDir, 'logs');
    mgr.on('event', (id, ev) => {
        const isErr = (ev.type === 'log' && (ev.tag === 'ERROR' || ev.tag === 'STDERR'))
            || (ev.type === 'status' && ['crashed', 'config_error', 'auth_failure', 'browser_missing'].includes(ev.value));
        if (!isErr || (ev.tag === 'STDERR' && /DeprecationWarning|trace-deprecation/.test(ev.msg))) return;
        try {
            fs.mkdirSync(errLogDir, { recursive: true });
            const file = path.join(errLogDir, `${id}.log`);
            try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.1'); } catch { /* no existe aún */ }
            const line = ev.type === 'status'
                ? `estado: ${ev.value}${ev.code != null ? ` (código ${ev.code})` : ''}`
                : `${ev.tag}: ${ev.msg}${ev.data && ev.data.error ? ` — ${ev.data.error}` : ''}${ev.data && ev.data.stack ? '\n    ' + ev.data.stack.split('\n').join('\n    ') : ''}`;
            fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
        } catch { /* no crítico */ }
    });

    function restartTelegram() {
        tg.stopPolling();
        if (tg.configured) {
            tg.startPolling((text, from) => notifier.handleCommand(text, from), (data, from) => notifier.handleCallback(data, from));
        }
    }

    function setTelegramConfig({ token, chatId, allowedUserIds }) {
        const prev = panelCfg.telegram || {};
        panelCfg = {
            ...panelCfg,
            telegram: {
                token: token != null ? String(token).trim() : prev.token || '',
                chatId: chatId != null ? String(chatId).trim() : prev.chatId || '',
                allowed_user_ids: allowedUserIds != null ? allowedUserIds.map(String) : prev.allowed_user_ids || [],
            },
        };
        savePanelCfg();
        restartTelegram();
        return getTelegramConfig();
    }

    function getTelegramConfig() {
        const c = tgCfg();
        return {
            configured: Boolean(c.token && c.chatId),
            tokenMasked: c.token ? c.token.slice(0, 6) + '••••' + c.token.slice(-4) : '',
            chatId: c.chatId,
            allowedUserIds: c.allowedUserIds,
            status: tg.status, // { polling, lastError, lastErrorAt, lastOkAt, queued }
        };
    }

    // ---------- navegador ----------
    // Navegador que usará la instancia `id` (o el general si no se indica).
    function browserFor(id) {
        let configured = '';
        if (id) {
            try { configured = configs.load(id).chrome_path; } catch { /* YAML roto */ }
        }
        const env = { ...process.env, ...mgr.env };
        const r = browserLib.findBrowser(configured, { ...browserOpts, env });
        return { ...r, warnings: [...r.warnings, ...browserLib.browserWarnings(r.path, dataDir)] };
    }

    function browserStatus() {
        const current = browserFor(null);
        return {
            found: Boolean(current.path),
            current,
            detected: browserLib.detectBrowsers({ ...browserOpts }),
            saved: panelCfg.browser_path || null,
            hint: browserLib.installHint(browserOpts.platform),
        };
    }

    // Guarda la ruta elegida por el usuario (validada). Vacío = volver a autodetectar.
    function setBrowserPath(p) {
        if (!p) {
            delete panelCfg.browser_path;
            savePanelCfg();
            applyBrowserEnv();
            return { ok: true, status: browserStatus() };
        }
        const v = (browserOpts.validate || browserLib.validateBrowser)(p);
        if (!v.ok) return v;
        panelCfg = { ...panelCfg, browser_path: v.path };
        savePanelCfg();
        applyBrowserEnv();
        return { ...v, status: browserStatus() };
    }

    // Arranca una instancia comprobando antes que haya navegador.
    function startInstance(id) {
        if (!fake && !browserFor(id).path) {
            mgr.markStatus(id, 'browser_missing');
            return { ok: false, reason: 'browser_missing' };
        }
        mgr.start(id);
        return { ok: true };
    }

    // ---------- acciones por instancia ----------
    const known = (id) => {
        if (!INSTANCES.some((i) => i.id === id)) {
            throw Object.assign(new Error('instancia desconocida: ' + id), { status: 404 });
        }
        return id;
    };

    function snapshot() {
        const st = mgr.statusAll();
        for (const id of Object.keys(st)) {
            st[id].qr = lastQr.get(id) || null;
            st[id].browser = fake ? null : (({ name, path: p, source, warnings }) => ({ name, path: p, source, warnings }))(browserFor(id));
            st[id].repliesToday = store.countToday(id);
            st[id].autostart = Boolean(prefs(id).autostart);
        }
        return { instances: st, telegram: getTelegramConfig(), browser: browserStatus(), fake, version };
    }

    const actions = {
        history: (id, limit = 300) => history.get(known(id)).slice(-Math.max(1, Math.min(limit, HISTORY_MAX))),
        start: (id) => startInstance(known(id)),
        // detener a mano = no reconectar sola al abrir el panel
        stop: async (id) => { setPref(known(id), { autostart: false }); await mgr.stop(id); return { ok: true }; },
        restart: async (id) => {
            known(id);
            await mgr.stop(id);
            return startInstance(id);
        },
        pause: async (id, value) => ({ paused: await mgr.setPaused(known(id), value) }),
        logout: (id) => { setPref(known(id), { autostart: false }); return mgr.sendRpc(id, 'LOGOUT'); },
        stats: (id, days = 14) => store.stats(known(id), Math.max(1, Math.min(Number(days) || 14, 90))),
        // ¿Respondería el bot a este mensaje? Misma lógica que el bot, sin tocar WhatsApp.
        testMessage: (id, { groupId, user, text, at } = {}) => {
            const cfg = configs.load(known(id));
            const compiled = filterLib.compileConfig(cfg);
            const date = at ? new Date(at) : new Date();
            if (Number.isNaN(date.getTime())) throw Object.assign(new Error('fecha no válida'), { status: 400 });
            let u = String(user || '').trim().replace(/\s+/g, '');
            if (/^\+?\d{6,}$/.test(u)) u = u.replace('+', '') + '@c.us';
            const r = filterLib.evaluate(compiled, { groupId: String(groupId || '').trim(), user: u, text: String(text || ''), date, paused: mgr.isPaused(id) });
            if (r.ok) {
                const rule = compiled.rules[r.rule];
                r.reply = filterLib.pickReply(rule);
                r.delayMs = cfg.reply_delay_ms;
            }
            if (r.excluded) r.excluded = r.excluded.map((e) => ({ rule: e.rule.index, ruleName: e.rule.name, keyword: e.keyword, by: e.by }));
            return r;
        },
        groups: (id, { refresh = false } = {}) => mgr.sendRpc(known(id), 'FETCH_GROUPS', { refresh }),
        contacts: (id, { refresh = false } = {}) => mgr.sendRpc(known(id), 'FETCH_CONTACTS', { refresh }),
        send: (id, to, text) => mgr.sendRpc(known(id), 'SEND_MESSAGE', { to, text }),
        getConfig: (id) => configs.load(known(id)),
        saveConfig: (id, cfg) => configs.save(known(id), cfg),
        telegramTest: async () => { await tg.send('WSPanel: prueba de notificaciones ✅'); return { ok: true }; },
    };

    // Añadir/quitar de allowed_groups / allowed_users partiendo de lo que hay en disco
    function allow(id, key, value, on = true) {
        if (!['allowed_groups', 'allowed_users'].includes(key)) {
            throw Object.assign(new Error('lista desconocida: ' + key), { status: 400 });
        }
        known(id);
        return configs.update(id, (cfg) => {
            const set = new Set(cfg[key]);
            if (on) set.add(value); else set.delete(value);
            cfg[key] = [...set];
            return cfg;
        });
    }

    return {
        instances: INSTANCES,
        botDir,
        mgr,
        configs,
        tg,
        notifier,
        startServices() { restartTelegram(); }, // Telegram (las instancias se arrancan con start(id))
        // cuentas que estaban conectadas la última vez (para reconectarlas al abrir)
        autostartIds: () => INSTANCES.map((i) => i.id).filter((id) => prefs(id).autostart),
        async shutdown() { tg.stopPolling(); await mgr.stopAll(); },
        setTelegramConfig,
        getTelegramConfig,
        browserFor,
        browserStatus,
        setBrowserPath,
        startInstance,
        snapshot,
        ...actions,
        allow,
    };
}

module.exports = { createPanel };
