// Notifier: eventos de las instancias → Telegram (con anti-spam) y comandos del grupo.

const STATUS_LABEL = {
    stopped: 'detenida', starting: 'arrancando', connecting: 'conectando', qr: 'esperando QR',
    authenticated: 'cargando', ready: 'conectada', disconnected: 'desconectada', crashed: 'caída',
    logging_out: 'cerrando sesión', logged_out: 'sesión cerrada', auth_failure: 'fallo de autenticación',
    config_error: 'error de configuración', browser_missing: 'sin navegador',
};

const STATUS_MSG = {
    ready: (l) => `🟢 [${l}] Conectada a WhatsApp`,
    disconnected: (l) => `⚠️ [${l}] Desconectada de WhatsApp — reintentando`,
    stopped: (l) => `⏹ [${l}] Detenida`,
    logged_out: (l) => `🔑 [${l}] Sesión cerrada — hay que escanear el QR desde el panel`,
    auth_failure: (l) => `🔑 [${l}] La sesión ya no es válida — hay que escanear el QR desde el panel`,
    config_error: (l) => `⚙️ [${l}] No pudo arrancar (configuración o navegador). Mira el registro en el panel`,
    browser_missing: (l) => `🌐 [${l}] No hay Chrome, Chromium, Edge ni Brave — indica el navegador en el panel`,
    crashed: (l, ev) => `🔴 [${l}] Se cayó${ev.code != null ? ` (código ${ev.code})` : ''}`
        + (ev.retryInMs != null ? ` — reintento en ${Math.round(ev.retryInMs / 1000)} s` : ''),
};

const CRASH_NOTIFY_MAX = 3; // caídas seguidas que se avisan antes de callar hasta que vuelva
const today = () => new Date().toISOString().slice(0, 10);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

class Notifier {
    // control = { start(id), stop(id), restart(id) } del panel (para los botones de /status)
    constructor(tg, mgr, { getAllowedUserIds = () => [], windowMs = 60000, now = Date.now, countToday = null, control = null } = {}) {
        this.control = control;
        this.countToday = countToday; // si el panel guarda el historial, el contador sale de ahí
        this.tg = tg;
        this.mgr = mgr;
        this.getAllowedUserIds = getAllowedUserIds;
        this.windowMs = windowMs;
        this.now = now;
        this.windows = new Map(); // `${id}|${group}` -> { n, timer, label, group }
        this.lastStatus = new Map(); // id -> último estado avisado
        this.lastPaused = new Map(); // id -> último valor de pausa avisado
        this.quietPause = new Map(); // id -> hasta cuándo no avisar (pausa pedida por Telegram)
        this.crashes = new Map(); // id -> caídas seguidas desde la última conexión
        this.replies = { day: today(), counts: {} };
    }

    label(id) {
        const d = this.mgr.defs.find((i) => i.id === id);
        return d ? d.name : id;
    }

    onEvent(ev, id) {
        const isReply = ev.type === 'notification' && ev.event === 'auto_reply';
        if (isReply) this.countReply(id); // el contador sirve también al panel, haya o no Telegram
        if (ev.type === 'status') this._trackCrashes(id, ev.value);
        if (!this.tg.configured) return;
        const l = this.label(id);

        if (isReply && ev.delivery === 'unconfirmed') {
            // no se agrupa: puede que el mensaje no haya salido
            this.tg.sendSafe(`⚠️ [${l}] Respondió en "${ev.group || ev.group_id || '?'}", pero WhatsApp no confirmó el envío`
                + `${ev.error ? ` (${ev.error})` : ''}. Comprueba que el mensaje aparece en el grupo.`);
        } else if (isReply) {
            this.windowAutoReply(id, ev);
        } else if (ev.type === 'notification' && ev.event === 'reply_failed') {
            const quote = ev.text ? `\n«${clip(String(ev.text).replace(/\s+/g, ' ').trim(), 200)}»` : '';
            this.tg.sendSafe(`❌ [${l}] No se pudo responder en "${ev.group || ev.group_id || '?'}"${ev.error ? `: ${ev.error}` : ''}${quote}`);
        } else if (ev.type === 'paused') {
            const v = Boolean(ev.value);
            const quietUntil = this.quietPause.get(id) || 0;
            const repeated = this.lastPaused.get(id) === v;
            this.lastPaused.set(id, v);
            if (repeated || this.now() < quietUntil) return; // ya avisado / lo pidió Telegram y ya se contestó
            this.tg.sendSafe(v ? `⏸ [${l}] Auto-respuesta en pausa` : `▶️ [${l}] Auto-respuesta activa`);
        } else if (ev.type === 'status' && STATUS_MSG[ev.value]) {
            if (ev.value === 'crashed') {
                const n = this.crashes.get(id) || 0;
                if (n > CRASH_NOTIFY_MAX) return;
                const extra = n === CRASH_NOTIFY_MAX ? '\nSigue cayéndose: no avisaré más hasta que vuelva a conectar.' : '';
                this.lastStatus.set(id, ev.value);
                this.tg.sendSafe(STATUS_MSG.crashed(l, ev) + extra);
                return;
            }
            if (this.lastStatus.get(id) === ev.value) return;
            const recovered = ev.value === 'ready' && this.lastStatus.get(id) === 'crashed';
            this.lastStatus.set(id, ev.value);
            this.tg.sendSafe(STATUS_MSG[ev.value](l, ev) + (recovered ? ' (recuperada tras caerse)' : ''));
        }
    }

    _trackCrashes(id, value) {
        if (value === 'crashed') this.crashes.set(id, (this.crashes.get(id) || 0) + 1);
        else if (value === 'ready' || value === 'stopped') this.crashes.set(id, 0);
    }

    countReply(id) {
        const d = today();
        if (this.replies.day !== d) this.replies = { day: d, counts: {} };
        this.replies.counts[id] = (this.replies.counts[id] || 0) + 1;
    }

    repliesToday(id) {
        if (this.countToday) return this.countToday(id);
        return this.replies.day === today() ? this.replies.counts[id] || 0 : 0;
    }

    // 1ª respuesta del grupo → aviso inmediato (con el mensaje que la provocó);
    // las siguientes dentro de la ventana se agrupan en un único resumen.
    windowAutoReply(id, ev) {
        const group = ev.group || ev.group_id || '?';
        const key = `${id}|${group}`;
        const w = this.windows.get(key);
        if (w) { w.n++; return; }
        const label = this.label(id);
        const quote = ev.text ? `\n«${clip(String(ev.text).replace(/\s+/g, ' ').trim(), 200)}»` : '';
        this.tg.sendSafe(`🤖 [${label}] Respondió en "${group}"${quote}`);
        const nw = { n: 1, label, group, timer: null };
        nw.timer = setTimeout(() => this.flush(key), this.windowMs);
        if (nw.timer.unref) nw.timer.unref();
        this.windows.set(key, nw);
    }

    flush(key) {
        const w = this.windows.get(key);
        if (!w) return;
        this.windows.delete(key);
        clearTimeout(w.timer);
        if (w.n > 1) this.tg.sendSafe(`🤖 [${w.label}] …y ${w.n - 1} respuesta${w.n === 2 ? '' : 's'} más en "${w.group}"`);
    }

    _authorized(from) {
        const allowed = (this.getAllowedUserIds() || []).map(String);
        return !allowed.length || allowed.includes(String(from.id));
    }

    statusText() {
        return this.mgr.defs.map(({ id }) => {
            const st = this.mgr.getStatus(id);
            const icon = st === 'ready' ? (this.mgr.isPaused(id) ? '⏸' : '🟢') : ['crashed', 'auth_failure', 'config_error', 'browser_missing'].includes(st) ? '🔴' : '⚪';
            const paused = this.mgr.isPaused(id) ? ' · en pausa' : '';
            const n = this.repliesToday(id);
            return `${icon} ${this.label(id)}: ${STATUS_LABEL[st] || st}${paused} · ${n} respuesta${n === 1 ? '' : 's'} hoy`;
        }).join('\n');
    }

    // Botones de /status según el estado de cada cuenta (callback_data "acción:id").
    // Cerrar sesión no se ofrece aquí: obligaría a escanear el QR desde el panel.
    statusKeyboard() {
        const rows = [];
        const running = (st) => !['stopped', 'crashed', 'logged_out', 'auth_failure', 'config_error', 'browser_missing'].includes(st);
        for (const { id } of this.mgr.defs) {
            const st = this.mgr.getStatus(id);
            const l = this.label(id);
            if (running(st)) {
                const row = [];
                if (st === 'ready') row.push(this.mgr.isPaused(id) ? { text: `▶️ Reanudar ${l}`, data: `resume:${id}` } : { text: `⏸ Pausar ${l}`, data: `pause:${id}` });
                if (this.control) row.push({ text: `↻ Reiniciar ${l}`, data: `restart:${id}` });
                if (row.length) rows.push(row);
                if (this.control) rows.push([{ text: `■ Desconectar ${l}`, data: `stop:${id}` }]);
            } else if (this.control && !['logged_out', 'auth_failure'].includes(st)) {
                const row = [{ text: `🔌 Conectar ${l}`, data: `start:${id}` }];
                if (st === 'crashed') row.push({ text: `■ Desconectar ${l}`, data: `stop:${id}` }); // deja de reintentar
                rows.push(row);
            }
        }
        rows.push([{ text: '🔄 Actualizar', data: 'refresh' }]);
        return rows;
    }

    statusMessage() { return { text: this.statusText(), keyboard: this.statusKeyboard() }; }

    // Botón pulsado en el mensaje de /status
    async handleCallback(data, from = {}) {
        if (!this._authorized(from)) return { toast: `⛔ No autorizado (tu id de Telegram es ${from.id})` };
        const [action, id] = String(data).split(':');
        const ids = this.mgr.defs.map((i) => i.id);
        if (action === 'refresh') return { toast: 'Actualizado', ...this.statusMessage() };
        if (!ids.includes(id)) return { toast: 'Cuenta desconocida' };
        const l = this.label(id);
        let toast;
        try {
            if (action === 'pause' || action === 'resume') {
                const want = action === 'pause';
                this.quietPause.set(id, this.now() + 5000); // el propio botón ya lo refleja
                await this.mgr.setPaused(id, want);
                this.lastPaused.set(id, want);
                toast = want ? `⏸ ${l} en pausa` : `▶️ ${l} activa`;
            } else if (this.control && action === 'start') {
                const r = await this.control.start(id);
                toast = r && r.ok === false
                    ? (r.reason === 'browser_missing' ? `🌐 ${l}: no hay navegador, indícalo en el panel` : `❌ ${l}: ${r.reason}`)
                    : `🔌 Conectando ${l}…`;
            } else if (this.control && action === 'stop') {
                await this.control.stop(id);
                toast = `■ ${l} desconectada`;
            } else if (this.control && action === 'restart') {
                await this.control.restart(id);
                toast = `↻ Reiniciando ${l}…`;
            } else {
                return { toast: 'Acción no disponible' };
            }
        } catch (e) {
            toast = `❌ ${l}: ${e.message}`;
        }
        return { toast, ...this.statusMessage() };
    }

    async handleCommand(text, from = {}) {
        const [rawCmd, ...args] = String(text).trim().split(/\s+/);
        if (!rawCmd.startsWith('/')) return null;
        const cmd = rawCmd.split('@')[0].toLowerCase(); // "/status@MiBot" → "/status"
        if (!['/status', '/pause', '/resume', '/help', '/start'].includes(cmd)) return null;

        if (!this._authorized(from)) {
            return `⛔ No autorizado. Tu id de Telegram es ${from.id}: añádelo en Ajustes del panel si debe poder usar los comandos.`;
        }

        const ids = this.mgr.defs.map((i) => i.id);
        const target = (args[0] || '').toLowerCase();
        const targets = target === '' || target === 'todos' ? ids : ids.includes(target) ? [target] : null;

        if (cmd === '/help' || cmd === '/start') {
            return [
                'WSPanel — comandos:',
                '/status — estado de las cuentas, con botones para pausar, reiniciar, conectar o desconectar',
                `/pause ${ids.join('|')}|todos — dejar de responder`,
                `/resume ${ids.join('|')}|todos — volver a responder`,
            ].join('\n');
        }
        if (cmd === '/status') return this.statusMessage();
        // /pause | /resume
        if (!targets) return `Uso: ${cmd} ${ids.join('|')}|todos`;
        const want = cmd === '/pause';
        const done = [];
        const errors = [];
        for (const id of targets) {
            this.quietPause.set(id, this.now() + 5000); // la respuesta al comando ya lo dice
            try {
                await this.mgr.setPaused(id, want);
                this.lastPaused.set(id, want);
                done.push(this.label(id));
            } catch (e) { errors.push(`❌ ${this.label(id)}: ${e.message}`); }
        }
        const head = done.length ? `${want ? '⏸ En pausa' : '▶️ Activa'}: ${done.join(', ')}` : '';
        return [head, ...errors].filter(Boolean).join('\n');
    }
}

module.exports = { Notifier };
