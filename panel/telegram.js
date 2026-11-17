// TelegramService: envío (con cola y límites) + long polling de comandos.
//
// - Envío en cola, de uno en uno, respetando los límites de Telegram
//   (≈20 mensajes/min en grupos, ≈1/s en privado) y los 429 con retry_after.
//   La cola tiene tope: si se desborda se descartan los más antiguos y se avisa.
// - Polling por "generaciones": stopPolling invalida la actual y aborta la
//   petición en curso, así que nunca hay dos bucles a la vez.
// - Errores visibles: `status` dice si escucha comandos y el último error.

class TelegramError extends Error {
    constructor(message, { code, retryAfter } = {}) {
        super(message);
        this.code = code;
        this.retryAfter = retryAfter;
    }
}

const isGroupChat = (chatId) => String(chatId).startsWith('-');

class TelegramService {
    constructor(getCfg, {
        fetchImpl = globalThis.fetch,
        pollTimeoutS = 25,
        retryMs = [1000, 3000, 10000, 30000],
        groupIntervalMs = 3100, // 20/min por grupo
        privateIntervalMs = 1050,
        queueMax = 60,
        onError,
        sleep,
    } = {}) {
        this.getCfg = getCfg; // () => { token, chatId }
        this.fetch = fetchImpl;
        this.pollTimeoutS = pollTimeoutS;
        this.retryMs = retryMs;
        this.groupIntervalMs = groupIntervalMs;
        this.privateIntervalMs = privateIntervalMs;
        this.queueMax = queueMax;
        this.onError = onError || (() => {});
        this.sleepFn = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.gen = 0;
        this.running = false;
        this.offset = 0;
        this.abort = null;
        this.wakeup = null;
        this.queue = [];
        this.sending = false;
        this.dropped = 0;
        this.lastSentAt = 0;
        this.state = { polling: false, lastError: null, lastErrorAt: null, lastOkAt: null };
    }

    get configured() {
        const { token, chatId } = this.getCfg();
        return Boolean(token && chatId);
    }

    get status() {
        return { ...this.state, polling: this.running && this.state.polling, queued: this.queue.length };
    }

    _fail(e) {
        this.state.lastError = e.message;
        this.state.lastErrorAt = Date.now();
        this.onError(e);
    }

    async api(method, body, { timeoutMs = 15000, signal } = {}) {
        const { token } = this.getCfg();
        if (!token) throw new TelegramError('Telegram no configurado');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const onAbort = () => ctrl.abort();
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        try {
            const r = await this.fetch(`https://api.telegram.org/bot${token}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
            let j;
            try { j = await r.json(); } catch {
                throw new TelegramError(`Telegram respondió HTTP ${r.status}`, { code: r.status });
            }
            if (!j.ok) {
                throw new TelegramError(j.description || `Error de Telegram ${r.status}`, {
                    code: j.error_code || r.status,
                    retryAfter: j.parameters && j.parameters.retry_after,
                });
            }
            return j.result;
        } catch (e) {
            if (e.name === 'AbortError' && !(signal && signal.aborted)) throw new TelegramError(`${method}: sin respuesta de Telegram`);
            throw e;
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    }

    // ---------- envío en cola ----------

    // Encola un mensaje; la promesa se resuelve cuando se envía (o falla).
    send(text, { replyTo } = {}) {
        if (!this.configured) return Promise.reject(new TelegramError('Telegram no configurado'));
        return new Promise((resolve, reject) => {
            this.queue.push({ text: String(text).slice(0, 4096), replyTo, resolve, reject });
            while (this.queue.length > this.queueMax) {
                const old = this.queue.shift();
                this.dropped++;
                old.reject(new TelegramError('descartado: demasiados avisos seguidos'));
            }
            this._pump();
        });
    }

    async sendSafe(text, opts) {
        try { await this.send(text, opts); return true; } catch (e) { this._fail(e); return false; }
    }

    async _pump() {
        if (this.sending) return;
        this.sending = true;
        try {
            while (this.queue.length) {
                const { chatId } = this.getCfg();
                const gap = (isGroupChat(chatId) ? this.groupIntervalMs : this.privateIntervalMs) - (Date.now() - this.lastSentAt);
                if (gap > 0) await this.sleepFn(gap);
                const item = this.queue.shift(); // fuera de la cola mientras se envía: el desbordamiento no lo toca
                let text = item.text;
                const announced = this.dropped; // descartes que se avisan en este mensaje
                if (announced) {
                    text = `(${announced} aviso${announced === 1 ? '' : 's'} omitido${announced === 1 ? '' : 's'} por exceso)\n${text}`.slice(0, 4096);
                }
                try {
                    const body = { chat_id: chatId, text };
                    if (item.replyTo) body.reply_parameters = { message_id: item.replyTo, allow_sending_without_reply: true };
                    await this.api('sendMessage', body);
                    this.dropped -= announced; // los descartados durante este envío se avisan en el siguiente
                    this.lastSentAt = Date.now();
                    this.state.lastOkAt = this.lastSentAt;
                    item.resolve();
                } catch (e) {
                    if (e.code === 429 && e.retryAfter) {
                        this.queue.unshift(item); // vuelve el primero
                        await this.sleepFn(e.retryAfter * 1000 + 250); // límite de Telegram: esperar y reintentar
                        continue;
                    }
                    this.lastSentAt = Date.now();
                    item.reject(e);
                }
            }
        } finally {
            this.sending = false;
        }
    }

    // ---------- polling de comandos ----------

    _sleep(ms, gen) {
        return new Promise((resolve) => {
            const t = setTimeout(resolve, ms);
            this.wakeup = () => { clearTimeout(t); resolve(); };
        }).then(() => { if (this.gen === gen) this.wakeup = null; });
    }

    // onCommand(text, from, chat) → Promise<string|null>
    startPolling(onCommand) {
        if (this.running) return undefined;
        this.running = true;
        this.offset = 0; // el offset es de cada bot: no arrastrar el de un token anterior
        const gen = ++this.gen;
        const alive = () => this.gen === gen;

        const loop = async () => {
            let failures = 0;
            let skipBacklog = true;
            let webhookCleared = false;
            while (alive()) {
                this.abort = new AbortController();
                try {
                    if (skipBacklog) {
                        // descartar comandos que llegaron con el panel apagado
                        const old = await this.api('getUpdates', { offset: -1, timeout: 0 }, { signal: this.abort.signal });
                        if (old.length) this.offset = old[old.length - 1].update_id;
                        skipBacklog = false;
                    }
                    const ups = await this.api(
                        'getUpdates',
                        { offset: this.offset + 1, timeout: this.pollTimeoutS, allowed_updates: ['message'] },
                        { signal: this.abort.signal, timeoutMs: (this.pollTimeoutS + 10) * 1000 }
                    );
                    failures = 0;
                    this.state.polling = true;
                    this.state.lastOkAt = Date.now();
                    if (this.state.lastError) { this.state.lastError = null; this.state.lastErrorAt = null; }
                    for (const u of ups) {
                        if (!alive()) return;
                        this.offset = Math.max(this.offset, u.update_id);
                        const m = u.message;
                        if (!m || !m.text || !m.chat || String(m.chat.id) !== String(this.getCfg().chatId)) continue;
                        try {
                            const reply = await onCommand(m.text.trim(), m.from || {}, m.chat);
                            if (reply && alive()) await this.sendSafe(reply, { replyTo: m.message_id });
                        } catch (e) { this._fail(e); }
                    }
                } catch (e) {
                    if (!alive()) return;
                    this.state.polling = false;
                    if (e.code === 409 && /webhook/i.test(e.message) && !webhookCleared) {
                        // el bot tenía un webhook: getUpdates no funciona hasta quitarlo
                        webhookCleared = true;
                        try { await this.api('deleteWebhook', { drop_pending_updates: false }); continue; } catch (e2) { this._fail(e2); }
                    }
                    const friendly = e.code === 409 && /terminated by other/i.test(e.message)
                        ? new TelegramError('Otro programa está leyendo este bot (¿el panel abierto dos veces?)', { code: 409 })
                        : e.code === 401 ? new TelegramError('Token incorrecto (401 Unauthorized)', { code: 401 }) : e;
                    this._fail(friendly);
                    await this._sleep(this.retryMs[Math.min(failures++, this.retryMs.length - 1)], gen);
                }
            }
        };
        this.loopPromise = loop();
        return this.loopPromise;
    }

    stopPolling() {
        this.gen++;
        this.running = false;
        this.state.polling = false;
        if (this.abort) this.abort.abort();
        if (this.wakeup) this.wakeup();
    }
}

module.exports = { TelegramService, TelegramError };
