const test = require('node:test');
const assert = require('node:assert/strict');
const { TelegramService } = require('../telegram');
const { Notifier } = require('../notifier');

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
const fail = (code, description, extra = {}) => ({ status: code, json: async () => ({ ok: false, error_code: code, description, ...extra }) });

// Telegram falso: getUpdates "cuelga" hasta que hay updates o se aborta
function fakeTelegram({ backlog = [{ update_id: 41, message: { text: '/pause todos', chat: { id: -1 } } }] } = {}) {
    const sent = [];
    const calls = [];
    const queue = [];
    let waiter = null;
    let inflight = 0;
    let maxInflight = 0;
    let hook = null; // permite inyectar respuestas especiales
    const fetchImpl = async (url, { body, signal }) => {
        const method = url.split('/').pop();
        const b = JSON.parse(body);
        calls.push({ method, b, token: url.split('/')[3] });
        if (hook) { const r = hook(method, b); if (r) return r; }
        if (method === 'sendMessage') { sent.push(b); return ok({}); }
        if (method === 'deleteWebhook') return ok(true);
        if (method === 'getUpdates' && b.offset === -1) return ok(backlog);
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        try {
            if (!queue.length) {
                await new Promise((resolve, reject) => {
                    waiter = resolve;
                    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
                });
            }
            return ok(queue.splice(0).filter((u) => u.update_id >= b.offset));
        } finally { inflight--; }
    };
    return {
        fetchImpl, sent, calls,
        setHook(fn) { hook = fn; },
        push(u) { queue.push(u); if (waiter) { const w = waiter; waiter = null; w(); } },
        get maxInflight() { return maxInflight; },
    };
}

const fast = { groupIntervalMs: 0, privateIntervalMs: 0, retryMs: [10] };
const cfg = (over = {}) => () => ({ token: 't', chatId: '-1', ...over });

const fakeMgr = () => ({
    defs: [{ id: 'personal', name: 'Personal' }, { id: 'trabajo', name: 'Trabajo' }],
    paused: {},
    events: [],
    getStatus: () => 'ready',
    isPaused(id) { return Boolean(this.paused[id]); },
    async setPaused(id, v) { this.paused[id] = v; },
});
const fakeTg = () => { const msgs = []; return { msgs, configured: true, sendSafe: async (t) => { msgs.push(t); return true; } }; };

// ---------- TelegramService ----------

test('stop + start durante un long-poll no duplica el bucle ni procesa el backlog', async () => {
    const ft = fakeTelegram();
    const tg = new TelegramService(cfg(), { fetchImpl: ft.fetchImpl, ...fast });
    const handled = [];
    const onCmd = async (text) => { handled.push(text); return null; };
    tg.startPolling(onCmd); await tick();
    tg.stopPolling(); tg.startPolling(onCmd); await tick();
    tg.stopPolling(); tg.startPolling(onCmd); await tick();
    ft.push({ update_id: 42, message: { text: '/status', chat: { id: -1 } } });
    await tick(60);
    tg.stopPolling();
    assert.deepEqual(handled, ['/status']);
    assert.equal(ft.maxInflight, 1);
});

test('ignora otros chats y responde citando el comando', async () => {
    const ft = fakeTelegram({ backlog: [] });
    const tg = new TelegramService(cfg(), { fetchImpl: ft.fetchImpl, ...fast });
    tg.startPolling(async (t) => `ok ${t}`); await tick();
    ft.push({ update_id: 50, message: { message_id: 7, text: '/a', chat: { id: 999 } } });
    ft.push({ update_id: 51, message: { message_id: 8, text: '/b', chat: { id: -1 } } });
    await tick(60);
    tg.stopPolling();
    assert.deepEqual(ft.sent.map((s) => s.text), ['ok /b']);
    assert.equal(ft.sent[0].reply_parameters.message_id, 8);
});

test('cambiar de bot (token) reinicia el offset: no se pierden comandos del bot nuevo', async () => {
    const ft = fakeTelegram({ backlog: [] });
    let token = 'A';
    const tg = new TelegramService(() => ({ token, chatId: '-1' }), { fetchImpl: ft.fetchImpl, ...fast });
    const handled = [];
    tg.startPolling(async (t) => { handled.push(t); return null; }); await tick();
    ft.push({ update_id: 900, message: { text: '/viejo', chat: { id: -1 } } });
    await tick(40);
    tg.stopPolling();
    token = 'B';
    tg.startPolling(async (t) => { handled.push(t); return null; }); await tick();
    ft.push({ update_id: 3, message: { text: '/nuevo', chat: { id: -1 } } }); // ids del bot nuevo son menores
    await tick(40);
    tg.stopPolling();
    assert.deepEqual(handled, ['/viejo', '/nuevo']);
});

test('cola: envía en orden respetando el intervalo de grupo', async () => {
    const ft = fakeTelegram({ backlog: [] });
    const waits = [];
    const tg = new TelegramService(cfg(), { fetchImpl: ft.fetchImpl, groupIntervalMs: 3100, sleep: async (ms) => { waits.push(ms); } });
    await Promise.all([tg.send('1'), tg.send('2'), tg.send('3')]);
    assert.deepEqual(ft.sent.map((s) => s.text), ['1', '2', '3']);
    assert.equal(waits.length, 2); // entre mensajes, no antes del primero
    assert.ok(waits.every((w) => w > 3000));
});

test('429: espera retry_after y reintenta el mismo mensaje', async () => {
    const ft = fakeTelegram({ backlog: [] });
    let first = true;
    ft.setHook((method) => {
        if (method === 'sendMessage' && first) { first = false; return fail(429, 'Too Many Requests: retry after 2', { parameters: { retry_after: 2 } }); }
        return null;
    });
    const waits = [];
    const tg = new TelegramService(cfg(), { fetchImpl: ft.fetchImpl, ...fast, sleep: async (ms) => { waits.push(ms); } });
    await tg.send('hola');
    assert.deepEqual(ft.sent.map((s) => s.text), ['hola']);
    assert.ok(waits.some((w) => w >= 2000));
});

test('desbordamiento de la cola: descarta los más antiguos y lo avisa en el siguiente', async () => {
    const ft = fakeTelegram({ backlog: [] });
    let release;
    const gate = new Promise((r) => { release = r; });
    let firstSend = true;
    ft.setHook((method, b) => {
        if (method === 'sendMessage' && firstSend) { firstSend = false; return gate.then(() => { ft.sent.push(b); return ok({}); }); }
        return null;
    });
    const tg = new TelegramService(cfg(), { fetchImpl: ft.fetchImpl, ...fast, queueMax: 3 });
    const results = ['a', 'b', 'c', 'd', 'e'].map((t) => tg.sendSafe(t));
    release();
    await Promise.all(results);
    const texts = ft.sent.map((s) => s.text);
    // 'a' estaba enviándose; de b..e caben 3 en cola → se descarta 'b'
    assert.equal(texts[0], 'a');
    assert.equal(texts.length, 4);
    assert.equal(texts[1], '(1 aviso omitido por exceso)\nc');
    assert.deepEqual(texts.slice(2), ['d', 'e']);
});

test('respuesta no JSON (502) da un error legible', async () => {
    const tg = new TelegramService(cfg(), { fetchImpl: async () => ({ status: 502, json: async () => { throw new SyntaxError('x'); } }), ...fast });
    await assert.rejects(tg.send('x'), /HTTP 502/);
});

test('webhook activo: lo quita una vez y sigue leyendo', async () => {
    const ft = fakeTelegram({ backlog: [] });
    let webhook = true;
    ft.setHook((method) => {
        if (method === 'deleteWebhook') { webhook = false; return ok(true); }
        if (method === 'getUpdates' && webhook) return fail(409, "Conflict: can't use getUpdates method while webhook is active");
        return null;
    });
    const tg = new TelegramService(cfg(), { fetchImpl: ft.fetchImpl, ...fast });
    const handled = [];
    tg.startPolling(async (t) => { handled.push(t); return null; }); await tick();
    ft.push({ update_id: 5, message: { text: '/status', chat: { id: -1 } } });
    await tick(60);
    tg.stopPolling();
    assert.equal(ft.calls.filter((c) => c.method === 'deleteWebhook').length, 1);
    assert.deepEqual(handled, ['/status']);
});

test('errores visibles en status: token incorrecto y otro lector', async () => {
    const ft = fakeTelegram({ backlog: [] });
    ft.setHook((method) => (method === 'getUpdates' ? fail(401, 'Unauthorized') : null));
    const tg = new TelegramService(cfg(), { fetchImpl: ft.fetchImpl, ...fast });
    tg.startPolling(async () => null); await tick(40);
    assert.equal(tg.status.polling, false);
    assert.match(tg.status.lastError, /Token incorrecto/);
    ft.setHook((method) => (method === 'getUpdates' ? fail(409, 'Conflict: terminated by other getUpdates request') : null));
    await tick(40);
    assert.match(tg.status.lastError, /panel abierto dos veces/);
    tg.stopPolling();
});

test('sin configurar, send rechaza sin llamar a la red', async () => {
    let called = false;
    const tg = new TelegramService(() => ({ token: '', chatId: '' }), { fetchImpl: async () => { called = true; return ok({}); }, ...fast });
    await assert.rejects(tg.send('x'), /no configurado/);
    assert.equal(called, false);
});

// ---------- Notifier ----------

test('comandos: /status legible, /status@bot, /help y autorización con el id del usuario', async () => {
    const mgr = fakeMgr();
    let allowed = [];
    const n = new Notifier(fakeTg(), mgr, { getAllowedUserIds: () => allowed });
    assert.match((await n.handleCommand('/status@MiBot')).text, /🟢 Personal: conectada · 0 respuestas hoy/);
    assert.match(await n.handleCommand('/help'), /\/pause personal\|trabajo\|todos/);
    assert.equal(await n.handleCommand('hola'), null);
    assert.equal(await n.handleCommand('/otro'), null);
    assert.match(await n.handleCommand('/pause personal', { id: 1 }), /En pausa: Personal/);
    assert.equal(mgr.paused.personal, true);
    assert.match((await n.handleCommand('/status')).text, /⏸ Personal: conectada · en pausa/);
    assert.match(await n.handleCommand('/pause nadie'), /Uso/);
    allowed = ['7'];
    assert.match(await n.handleCommand('/resume todos', { id: 1 }), /No autorizado.*tu id de Telegram es 1/i);
    assert.match(await n.handleCommand('/resume todos', { id: 7 }), /Activa: Personal, Trabajo/);
});

test('/pause por Telegram no genera un segundo aviso de pausa', async () => {
    const tg = fakeTg();
    const mgr = fakeMgr();
    const n = new Notifier(tg, mgr);
    mgr.setPaused = async (id, v) => { mgr.paused[id] = v; n.onEvent({ type: 'paused', value: v }, id); };
    await n.handleCommand('/pause personal', { id: 1 });
    assert.equal(tg.msgs.length, 0);
    // una pausa desde el panel sí se avisa (y solo si cambia)
    n.quietPause.clear();
    n.onEvent({ type: 'paused', value: false }, 'personal');
    n.onEvent({ type: 'paused', value: false }, 'personal');
    assert.deepEqual(tg.msgs, ['▶️ [Personal] Auto-respuesta activa']);
});

test('respuestas: aviso con el mensaje que la provocó y ráfagas agrupadas', async () => {
    const tg = fakeTg();
    const n = new Notifier(tg, fakeMgr(), { windowMs: 50 });
    for (let i = 0; i < 4; i++) n.onEvent({ type: 'notification', event: 'auto_reply', group: 'G', text: 'voy al   aeropuerto' }, 'personal');
    assert.deepEqual(tg.msgs, ['🤖 [Personal] Respondió en "G"\n«voy al aeropuerto»']);
    await tick(80);
    assert.equal(tg.msgs[1], '🤖 [Personal] …y 3 respuestas más en "G"');
    assert.equal(n.repliesToday('personal'), 4);
});

test('estados: sin repetir, recuperación y caídas en bucle limitadas', () => {
    const tg = fakeTg();
    const n = new Notifier(tg, fakeMgr());
    n.onEvent({ type: 'status', value: 'ready' }, 'personal');
    n.onEvent({ type: 'status', value: 'ready' }, 'personal');
    for (let i = 0; i < 6; i++) {
        n.onEvent({ type: 'status', value: 'crashed', code: 1, retryInMs: 5000 }, 'personal');
        n.onEvent({ type: 'status', value: 'starting' }, 'personal');
    }
    n.onEvent({ type: 'status', value: 'ready' }, 'personal');
    assert.equal(tg.msgs[0], '🟢 [Personal] Conectada a WhatsApp');
    assert.equal(tg.msgs.filter((m) => m.startsWith('🔴')).length, 3);
    assert.match(tg.msgs[3], /no avisaré más/);
    assert.equal(tg.msgs[4], '🟢 [Personal] Conectada a WhatsApp (recuperada tras caerse)');
    assert.equal(tg.msgs.length, 5);
});

test('sin Telegram configurado no se envía nada, pero se cuentan las respuestas', () => {
    const msgs = [];
    const n = new Notifier({ configured: false, sendSafe: async (t) => msgs.push(t) }, fakeMgr());
    n.onEvent({ type: 'status', value: 'ready' }, 'personal');
    n.onEvent({ type: 'notification', event: 'auto_reply', group: 'G' }, 'personal');
    assert.equal(msgs.length, 0);
    assert.equal(n.repliesToday('personal'), 1);
});

// ---------- botones de /status ----------

test('/status trae botones según el estado de cada cuenta', async () => {
    const mgr = fakeMgr();
    const st = { personal: 'ready', trabajo: 'stopped' };
    mgr.getStatus = (id) => st[id];
    const control = { start: async () => ({ ok: true }), stop: async () => {}, restart: async () => {} };
    const n = new Notifier(fakeTg(), mgr, { control });
    const datas = (await n.handleCommand('/status')).keyboard.flat().map((b) => b.data);
    assert.deepEqual(datas, ['pause:personal', 'restart:personal', 'stop:personal', 'start:trabajo', 'refresh']);
    mgr.paused.personal = true;
    st.trabajo = 'crashed';
    assert.deepEqual(n.statusKeyboard().flat().map((b) => b.data), ['resume:personal', 'restart:personal', 'stop:personal', 'start:trabajo', 'stop:trabajo', 'refresh']);
    st.trabajo = 'logged_out'; // hace falta QR: no se ofrece conectar desde Telegram
    assert.ok(!n.statusKeyboard().flat().some((b) => b.data.endsWith(':trabajo')));
    // sin control (p. ej. modo antiguo) solo pausar/reanudar
    assert.deepEqual(new Notifier(fakeTg(), mgr).statusKeyboard().flat().map((b) => b.data), ['resume:personal', 'refresh']);
});

test('pulsar un botón ejecuta la acción, respeta la autorización y devuelve el estado nuevo', async () => {
    const mgr = fakeMgr();
    const calls = [];
    const control = {
        start: async (id) => { calls.push(['start', id]); return id === 'trabajo' ? { ok: false, reason: 'browser_missing' } : { ok: true }; },
        stop: async (id) => { calls.push(['stop', id]); },
        restart: async (id) => { calls.push(['restart', id]); },
    };
    let allowed = [];
    const tg = fakeTg();
    const n = new Notifier(tg, mgr, { control, getAllowedUserIds: () => allowed });
    const r = await n.handleCallback('pause:personal', { id: 1 });
    assert.equal(mgr.paused.personal, true);
    assert.match(r.toast, /Personal en pausa/);
    assert.match(r.text, /⏸ Personal/);
    assert.ok(r.keyboard.flat().some((b) => b.data === 'resume:personal'));
    n.onEvent({ type: 'paused', value: true }, 'personal');
    assert.equal(tg.msgs.length, 0, 'sin aviso duplicado de pausa');
    assert.match((await n.handleCallback('stop:trabajo', { id: 1 })).toast, /Trabajo desconectada/);
    assert.match((await n.handleCallback('restart:personal', { id: 1 })).toast, /Reiniciando Personal/);
    assert.match((await n.handleCallback('start:trabajo', { id: 1 })).toast, /no hay navegador/);
    assert.deepEqual(calls, [['stop', 'trabajo'], ['restart', 'personal'], ['start', 'trabajo']]);
    assert.match((await n.handleCallback('stop:nadie', { id: 1 })).toast, /desconocida/);
    allowed = ['7'];
    const denied = await n.handleCallback('stop:personal', { id: 1 });
    assert.match(denied.toast, /No autorizado/);
    assert.equal(denied.text, undefined);
    assert.equal(calls.length, 3);
});

test('TelegramService: envía los botones y atiende las pulsaciones (solo del grupo configurado)', async () => {
    const t = fakeTelegram({ backlog: [] });
    t.setHook((method) => (['answerCallbackQuery', 'editMessageText'].includes(method) ? ok(true) : null));
    const tg = new TelegramService(cfg(), { fetchImpl: t.fetchImpl, ...fast });
    const pressed = [];
    tg.startPolling(async (text) => (text === '/status' ? { text: 'estado', keyboard: [[{ text: 'Pausar', data: 'pause:personal' }]] } : null),
        async (data) => { pressed.push(data); return { toast: 'hecho', text: 'estado nuevo', keyboard: [[{ text: 'Reanudar', data: 'resume:personal' }]] }; });
    await tick();
    t.push({ update_id: 50, message: { message_id: 9, text: '/status', chat: { id: -1 }, from: { id: 1 } } });
    await tick(60);
    assert.deepEqual(t.sent[0].reply_markup, { inline_keyboard: [[{ text: 'Pausar', callback_data: 'pause:personal' }]] });
    t.push({ update_id: 51, callback_query: { id: 'cq1', data: 'pause:personal', from: { id: 1 }, message: { message_id: 10, chat: { id: -1 } } } });
    t.push({ update_id: 52, callback_query: { id: 'cq2', data: 'stop:personal', from: { id: 1 }, message: { message_id: 11, chat: { id: -999 } } } });
    await tick(80);
    tg.stopPolling();
    assert.deepEqual(pressed, ['pause:personal'], 'el botón de otro chat no ejecuta nada');
    const answers = t.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.b);
    assert.deepEqual(answers, [{ callback_query_id: 'cq1', text: 'hecho' }, { callback_query_id: 'cq2' }]);
    const edit = t.calls.find((c) => c.method === 'editMessageText').b;
    assert.equal(edit.message_id, 10);
    assert.equal(edit.text, 'estado nuevo');
    assert.equal(edit.reply_markup.inline_keyboard[0][0].callback_data, 'resume:personal');
    assert.ok(t.calls.some((c) => c.method === 'getUpdates' && (c.b.allowed_updates || []).includes('callback_query')));
});
