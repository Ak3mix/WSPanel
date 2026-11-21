// WSPanel — interfaz.
// Diseño: las dos cuentas lado a lado (en móvil, una cada vez), un interruptor
// grande de auto-respuesta, las reglas resumidas en una frase y la actividad
// como conversación. Todo lo que se edita vive en paneles laterales, así los
// eventos en vivo nunca pisan lo que se está escribiendo.
'use strict';

const ICON = { personal: '👤', trabajo: '💼' };
const CHAT_ID = /^[\w.-]+@(c\.us|g\.us)$/;
const NOT_RUNNING = new Set(['stopped', 'crashed', 'logged_out', 'auth_failure', 'config_error', 'browser_missing']);
const ITEMS_MAX = 1000;

const S = {
    snap: null,
    items: {}, // id -> [{ ts, type: 'log'|'notification', ... }] (actividad + registro)
    cfg: {}, // id -> config cargada
    groups: {},
    contacts: {},
    lastReply: {}, // id -> ts
    qrVersion: 0,
    current: null, // cuenta visible en móvil
    columns: {},
};

const inst = (id) => S.snap.instances[id];
const ids = () => Object.keys(S.snap.instances);
const running = (st) => !NOT_RUNNING.has(st);
const accClass = (id) => (ICON[id] ? `acc-${id}` : 'acc-default');

// ---------- utilidades de presentación ----------

function outOfHours(id) {
    const c = S.cfg[id];
    return Boolean(c && hasSchedule(c.schedule) && !inScheduleNow(c.schedule));
}

function statusInfo(i, id) {
    const map = {
        ready: i.paused ? ['st-warn', 'En pausa · no responde']
            : id && outOfHours(id) ? ['st-warn', 'Fuera de horario · no responde'] : ['st-ok', 'Conectada · respondiendo'],
        starting: ['st-wait', 'Arrancando…'], connecting: ['st-wait', 'Abriendo WhatsApp Web…'],
        authenticated: ['st-wait', 'Sesión verificada, cargando…'], qr: ['st-wait', 'Esperando que escanees el QR'],
        logging_out: ['st-wait', 'Cerrando sesión…'], disconnected: ['st-warn', 'Desconectada · reconectando'],
        logged_out: ['st-warn', 'Sesión cerrada'], crashed: ['st-bad', 'Se cayó'],
        auth_failure: ['st-bad', 'La sesión ya no es válida'], config_error: ['st-bad', 'Error de configuración'],
        browser_missing: ['st-bad', 'Falta el navegador'], stopped: ['', 'Desconectada'],
    };
    return map[i.status] || ['', i.status];
}

const fmtPhone = (jid) => {
    if (!jid) return 'alguien';
    if (jid.endsWith('@c.us')) return '+' + jid.split('@')[0];
    return 'contacto';
};

function chatName(id, chatId) {
    const hit = [...(S.groups[id] || []), ...(S.contacts[id] || [])].find((x) => x.id === chatId);
    return hit && hit.name ? hit.name : null;
}

function ago(ts) {
    if (!ts) return '—';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return 'ahora';
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
    return new Date(ts).toLocaleDateString();
}

// Tiempo de respuesta: desde que llegó el mensaje hasta que se envió la respuesta
const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString('es-ES', { maximumFractionDigits: 2 })} s`);
function latencyBadge(it) {
    if (!Number.isFinite(it.latency_ms)) return null; // respuestas antiguas, sin medir
    const delay = Number.isFinite(it.delay_ms) ? it.delay_ms : 0;
    const work = Math.max(0, it.latency_ms - delay);
    const title = delay
        ? `Respondió ${fmtMs(it.latency_ms)} después de recibir el mensaje: ${fmtMs(delay)} de espera configurada + ${fmtMs(work)} de proceso.`
        : `Respondió ${fmtMs(it.latency_ms)} después de recibir el mensaje.`;
    return h('span', { class: `latency ${work > 3000 ? 'slow' : ''}`, title, 'aria-label': title }, `⏱ ${fmtMs(it.latency_ms)}`);
}

// Resalta la keyword dentro del texto original (sin distinguir acentos)
function highlight(text, kw) {
    if (!kw) return [text];
    const chars = [];
    const map = [];
    for (let i = 0; i < text.length; i++) {
        for (const c of norm(text[i])) { chars.push(c); map.push(i); }
    }
    const idx = chars.join('').indexOf(norm(kw));
    if (idx < 0) return [text];
    const a = map[idx];
    const b = map[idx + norm(kw).length - 1] + 1;
    return [text.slice(0, a), h('mark', { text: text.slice(a, b) }), text.slice(b)];
}

// ---------- panel lateral ----------

const drawer = {
    dirty: null,
    open(title, { body, foot, acc = 'acc-default', isDirty, focus } = {}) {
        $('#drawer-title').textContent = title;
        $('#drawer-body').replaceChildren(...[].concat(body || []));
        $('#drawer-foot').replaceChildren(...[].concat(foot || []));
        $('.drawer-panel').className = `drawer-panel ${acc}`;
        this.dirty = isDirty || null;
        $('#drawer').classList.add('open');
        $('#drawer').setAttribute('aria-hidden', 'false');
        $('#drawer-body').scrollTop = 0;
        if (focus) setTimeout(() => focus.focus({ preventScroll: true }), 260);
    },
    async close(force) {
        if (!force && this.dirty && this.dirty()) {
            if (!(await confirmDialog('Hay cambios sin guardar. ¿Cerrar igualmente?', 'Descartar cambios'))) return false;
        }
        $('#drawer').classList.remove('open');
        $('#drawer').setAttribute('aria-hidden', 'true');
        this.dirty = null;
        return true;
    },
};
$('#drawer-close').addEventListener('click', () => drawer.close());
$('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') drawer.close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#drawer').classList.contains('open') && !$('#confirm').open) drawer.close(); });
$('#btn-settings').addEventListener('click', () => openSettings());

function section(title, desc, ...content) {
    return h('div', { class: 'section' }, h('h3', { text: title }), desc ? h('p', { class: 'desc', text: desc }) : null, ...content);
}
const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { class: 'label', text: label }), control, hint ? h('span', { class: 'hint', text: hint }) : null);
const sw = (input, title, sub) => h('label', { class: 'switch' }, input, h('span', { class: 't' }, h('b', { text: title }), sub ? h('span', { text: sub }) : null));

// ---------- menú ⋯ ----------

let openMenu = null;
function menuButton(itemsFn) {
    const btn = h('button', { class: 'icon-btn', title: 'Más acciones', 'aria-label': 'Más acciones', text: '⋯' });
    const wrap = h('div', { class: 'menu-wrap' }, btn);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasMine = openMenu && openMenu._owner === wrap;
        if (openMenu) { openMenu.remove(); openMenu = null; }
        if (wasMine) return; // segundo clic: cerrar
        const menu = h('div', { class: 'menu', role: 'menu' }, ...itemsFn().map((it) => (it === '-' ? h('hr')
            : h('button', { class: it.danger ? 'danger' : '', disabled: it.disabled, role: 'menuitem',
                onclick: () => { menu.remove(); openMenu = null; it.run(); } }, it.icon || '', it.label))));
        menu._owner = wrap;
        wrap.append(menu);
        openMenu = menu;
    });
    return wrap;
}
document.addEventListener('click', () => { if (openMenu) { openMenu.remove(); openMenu = null; } });

// ---------- columna de una cuenta ----------

function accountColumn(id) {
    const col = h('section', { class: `account ${accClass(id)}`, 'aria-label': inst(id).name });
    const hero = h('div', { class: 'hero' });
    const rules = h('div', { class: 'rules' });
    let mode = 'conv';
    const feed = h('div', { class: 'feed' });
    const log = h('div', { class: 'log', hidden: true });
    const stats = statsView(id);
    stats.el.hidden = true;
    const seg = h('div', { class: 'seg' });
    const activity = h('div', { class: 'activity' },
        h('div', { class: 'activity-head' }, h('h3', { text: 'Actividad' }), seg,
            h('button', { class: 'btn ghost sm', text: '✉ Enviar', title: 'Enviar un mensaje desde esta cuenta', onclick: () => openSend(id) })),
        feed, log, stats.el);
    col.append(hero, rules, activity);

    // --- cabecera: estado + interruptor + menú ---
    const act = (fn) => () => withBusy(null, fn);
    const menuItems = () => {
        const i = inst(id);
        return [
            { icon: '✎', label: 'Editar reglas…', run: () => openRules(id) },
            { icon: '🧪', label: 'Probar reglas…', run: () => openTester(id) },
            { icon: '✉', label: 'Enviar mensaje…', run: () => openSend(id) },
            '-',
            { icon: '↻', label: 'Reiniciar', disabled: !running(i.status), run: act(() => api.post(api.inst(id, 'restart'))) },
            { icon: '■', label: 'Desconectar', disabled: !running(i.status) && i.status !== 'crashed', run: act(() => api.post(api.inst(id, 'stop'))) },
            '-',
            { icon: '⎋', label: 'Cerrar sesión de WhatsApp', danger: true, disabled: i.status !== 'ready', run: () => logout(id) },
        ];
    };

    function renderHero() {
        const i = inst(id);
        const [cls, text] = statusInfo(i, id);
        let ctrl;
        if (!running(i.status)) {
            ctrl = h('button', { class: 'btn', text: i.status === 'logged_out' || i.status === 'auth_failure' ? 'Vincular' : 'Conectar' });
            ctrl.addEventListener('click', () => withBusy(ctrl, async () => {
                const r = await api.post(api.inst(id, 'start'));
                if (r && r.ok === false && r.reason === 'browser_missing') openSettings();
            }));
        } else {
            const input = h('input', { type: 'checkbox', checked: !i.paused, 'aria-label': 'Auto-respuesta' });
            input.addEventListener('change', () => withBusy(null, async () => {
                try { await api.post(api.inst(id, 'pause'), { paused: !input.checked }); } catch (e) { input.checked = !input.checked; throw e; }
            }));
            ctrl = h('label', { class: `power ${i.paused ? '' : 'on'}`, title: i.paused ? 'Activar la respuesta automática' : 'Pausar la respuesta automática' },
                h('span', { text: i.paused ? 'En pausa' : 'Activa' }), input);
        }
        const groups = (S.cfg[id] && S.cfg[id].allowed_groups.length) || 0;
        hero.replaceChildren(
            h('div', { class: 'hero-top' },
                h('div', { class: 'avatar', text: ICON[id] || '💬' }),
                h('div', { class: 'hero-main' },
                    h('div', { class: 'hero-name', text: i.name }),
                    h('div', { class: `hero-status ${cls}` }, h('span', { class: 'dot' }), text)),
                h('div', { class: 'hero-ctrl' }, ctrl, menuButton(menuItems))),
            heroBody(i) || '',
            h('div', { class: 'stats' },
                h('div', { class: 'stat' }, h('div', { class: 'n', text: String(i.repliesToday || 0) }), h('div', { class: 'l', text: 'respuestas hoy' })),
                h('div', { class: 'stat' }, h('div', { class: 'n', dataset: { ago: id }, text: ago(S.lastReply[id]) }), h('div', { class: 'l', text: 'última respuesta' })),
                h('div', { class: 'stat' }, h('div', { class: 'n', text: S.cfg[id] ? (groups ? String(groups) : 'todos') : '·' }), h('div', { class: 'l', text: groups === 1 ? 'grupo vigilado' : 'grupos vigilados' }))));
    }

    function heroBody(i) {
        const box = (kind, title, txt, extra) => h('div', { class: 'hero-body' }, h('div', { class: `msg ${kind}` }, h('b', { text: title }), txt, extra || null));
        switch (i.status) {
            case 'qr':
                return h('div', { class: 'hero-body' }, h('div', { class: 'qr' },
                    h('img', { src: `${api.inst(id, 'qr.svg')}?v=${S.qrVersion}`, alt: `Código QR para vincular ${i.name}` }),
                    h('div', {}, h('h4', { text: 'Vincula esta cuenta' }), h('ol', {},
                        h('li', {}, 'Abre ', h('b', { text: 'WhatsApp' }), ' en el móvil de esta cuenta'),
                        h('li', {}, h('b', { text: 'Ajustes → Dispositivos vinculados' })),
                        h('li', {}, h('b', { text: 'Vincular un dispositivo' }), ' y escanea'),
                        h('li', { text: 'El código se renueva solo cada ~20 s' })))));
            case 'starting': case 'connecting': case 'authenticated':
                return box('info', 'Conectando…', 'La primera vez puede tardar hasta un minuto.');
            case 'disconnected':
                return box('warn', 'Se perdió la conexión', 'Se reconecta sola en unos segundos.');
            case 'crashed':
                return box('bad', 'El bot se cayó', i.retryInMs != null ? `Reintento automático en ${Math.round(i.retryInMs / 1000)} s.` : 'Mira el registro técnico.');
            case 'auth_failure':
                return box('bad', 'Hay que volver a vincular', 'La sesión guardada ya no sirve. Pulsa «Vincular» y escanea el QR.');
            case 'config_error':
                return box('bad', 'No pudo arrancar', 'El YAML no es válido o el navegador no arranca. Mira el registro técnico.');
            case 'browser_missing':
                return box('bad', 'Falta el navegador', 'WhatsApp Web necesita Chrome, Chromium, Edge o Brave. ',
                    h('button', { class: 'link', text: 'Indicar navegador', onclick: () => openSettings() }));
            case 'logged_out':
                return box('plain', 'Sesión cerrada', 'Pulsa «Vincular» para conectar esta u otra cuenta.');
            case 'ready':
                if (i.paused) return box('warn', 'Auto-respuesta en pausa', 'Sigue conectada, pero no contestará hasta que la actives.');
                if (outOfHours(id)) return box('plain', 'Fuera de horario', `Responde ${scheduleText(S.cfg[id].schedule)}. Ahora no contestará.`);
                return null;
            default:
                return null;
        }
    }

    // --- reglas resumidas ---
    function renderRules() {
        rules.replaceChildren(
            h('div', { class: 'rules-head' }, h('h3', { class: 'grow', text: 'Reglas' }),
                h('button', { class: 'btn ghost sm', text: '🧪 Probar', title: 'Probar qué haría el bot con un mensaje', onclick: () => openTester(id) }),
                h('button', { class: 'btn ghost sm', text: 'Editar', onclick: () => openRules(id) })),
            rulesSummary(id));
    }

    // --- actividad ---
    const drawSeg = () => seg.replaceChildren(
        h('button', { class: mode === 'conv' ? 'active' : '', text: 'Respuestas', onclick: () => { mode = 'conv'; drawSeg(); drawFeed(); } }),
        h('button', { class: mode === 'log' ? 'active' : '', text: 'Registro', onclick: () => { mode = 'log'; drawSeg(); drawFeed(); } }),
        h('button', { class: mode === 'stats' ? 'active' : '', text: 'Estadísticas', onclick: () => { mode = 'stats'; drawSeg(); drawFeed(); } }));

    function feedNode(it) {
        if (it.type === 'notification' && it.event === 'auto_reply') {
            return h('div', { class: 'ev-reply' },
                h('div', { class: 'ev-meta' }, h('span', { class: 'group', text: it.group || it.group_id || 'Grupo' }), '·', fmtTime(it.ts),
                    h('span', { class: 'ev-tags' },
                        it.rule && /^Regla \d+$/.test(it.rule) === false ? h('span', { class: 'rule-tag', text: it.rule }) : null,
                        latencyBadge(it))),
                h('div', { class: 'bubble in' }, h('span', { class: 'who', text: chatName(id, it.sender) || fmtPhone(it.sender) }),
                    ...(it.text ? highlight(it.text, it.keyword) : [h('i', { class: 'muted', text: `(contenía «${it.keyword}»)` })])),
                h('div', { class: 'bubble out', text: it.reply }));
        }
        const sys = sysText(it);
        if (!sys) return null;
        return h('div', { class: `ev-sys ${sys[0]}` }, h('span', { class: 'line' }), `${sys[1]} · ${fmtTime(it.ts)}`, h('span', { class: 'line' }));
    }
    function sysText(it) {
        if (it.type !== 'log') return null;
        const d = it.data || {};
        if (it.tag === 'READY' && it.msg === 'Bot connected and ready') return ['', 'Conectada a WhatsApp'];
        if (it.tag === 'DISCONNECT') return ['bad', `Desconectada (${d.reason || '?'})`];
        if (it.tag === 'AUTH' && /failure/i.test(it.msg)) return ['bad', 'Fallo de autenticación'];
        if (it.tag === 'ERROR') return ['bad', `Error: ${d.error || it.msg}`];
        if (it.tag === 'CORE' && /Shutting down/.test(it.msg)) return ['', 'Bot detenido'];
        if (it.tag === 'FILTER' && /Paused/.test(it.msg)) return ['', `En pausa: no respondió a «${d.keyword || '…'}»`];
        if (it.tag === 'FILTER' && /Cooldown/.test(it.msg)) return ['', 'No respondió (límite por grupo)'];
        if (it.tag === 'FILTER' && /Excluded/.test(it.msg)) return ['', `No respondió: «${d.keyword || '…'}» con «${d.excluded_by || '…'}» (excepción)`];
        if (it.tag === 'FILTER' && /Outside schedule/.test(it.msg)) return ['', `Fuera de horario: no respondió a «${d.keyword || '…'}»`];
        if (it.tag === 'CONFIG' && /hot-reloaded/.test(it.msg)) return ['', 'Reglas actualizadas'];
        return null;
    }
    function logNode(it) {
        if (it.type !== 'log') return null;
        return h('div', { class: `log-line t-${it.tag}` }, fmtTime(it.ts), h('span', { class: 'tag', text: it.tag }), it.msg,
            it.data !== undefined ? ' ' + JSON.stringify(it.data) : '');
    }
    function drawFeed() {
        feed.hidden = mode !== 'conv';
        log.hidden = mode !== 'log';
        stats.el.hidden = mode !== 'stats';
        if (mode === 'stats') { stats.load(); return; }
        const items = S.items[id] || [];
        if (mode === 'conv') {
            const nodes = [];
            for (let k = items.length - 1; k >= 0 && nodes.length < 150; k--) { const n = feedNode(items[k]); if (n) nodes.push(n); }
            feed.replaceChildren(...(nodes.length ? nodes : [h('div', { class: 'feed-empty' }, h('span', { class: 'big', text: '💬' }),
                'Aquí aparecerá cada respuesta del bot junto al mensaje que la provocó.')]));
        } else {
            const nodes = [];
            for (let k = items.length - 1; k >= 0 && nodes.length < 400; k--) { const n = logNode(items[k]); if (n) nodes.push(n); }
            log.replaceChildren(...(nodes.length ? nodes : [h('div', { class: 'feed-empty', text: 'Sin entradas' })]));
        }
    }
    function addItem(it) {
        if (mode === 'stats') { if (it.type === 'notification') stats.load(); return; }
        if (mode === 'conv') {
            const n = feedNode(it);
            if (!n) return;
            const empty = feed.querySelector('.feed-empty');
            if (empty) empty.remove();
            feed.prepend(n);
            while (feed.childElementCount > 150) feed.lastElementChild.remove();
        } else {
            const n = logNode(it);
            if (!n) return;
            const empty = log.querySelector('.feed-empty');
            if (empty) empty.remove();
            log.prepend(n);
            while (log.childElementCount > 400) log.lastElementChild.remove();
        }
    }

    drawSeg();
    renderHero();
    renderRules();
    drawFeed();
    return {
        el: col,
        onEvent(ev, item) {
            if (item) addItem(item);
            if (ev.type !== 'log') renderHero();
        },
        refreshAll() { renderHero(); renderRules(); drawFeed(); },
        refreshRules() { renderRules(); renderHero(); },
        tick() { renderHero(); }, // «hace X min» y entrada/salida del horario
    };
}

async function logout(id) {
    const ok = await confirmDialog(`¿Cerrar la sesión de WhatsApp de «${inst(id).name}»?\n\nEl dispositivo se desvincula y tendrás que escanear el QR otra vez (puede ser con otra cuenta).`, 'Cerrar sesión');
    if (ok) withBusy(null, () => api.post(api.inst(id, 'logout')));
}

async function loadConfig(id) {
    try { S.cfg[id] = await api.get(api.inst(id, 'config')); } catch (e) { toast(e.message, 'err'); }
    if (S.columns[id]) S.columns[id].refreshRules();
}

async function loadChats(id, which = ['groups', 'contacts'], { refresh = false } = {}) {
    for (const w of which) {
        const r = await api.get(api.inst(id, w) + (refresh ? '?refresh=1' : ''));
        S[w][id] = w === 'groups' ? r.groups : r.contacts; // ya vienen ordenadas y limitadas
        if (r.truncated) {
            toast(`Cuenta muy grande: se muestran ${S[w][id].length.toLocaleString()} de ${r.total.toLocaleString()} ${w === 'groups' ? 'grupos' : 'contactos'}. Usa el buscador.`, 'warn', 7000);
        }
    }
    if (S.columns[id]) S.columns[id].refreshAll();
}

// ---------- panel: enviar ----------

function openSend(id) {
    let target = '';
    const input = h('input', { type: 'text', placeholder: 'Busca un grupo o contacto, o pega un id', autocomplete: 'off' });
    const pop = h('div', { class: 'combo-list', hidden: true });
    const text = h('textarea', { rows: 5, placeholder: 'Mensaje… (Ctrl+Enter para enviar)' });
    const loadBtn = h('button', { class: 'btn ghost sm', text: 'Cargar grupos y contactos' });
    const hint = h('div', { class: 'row' }, h('span', { class: 'muted small grow', text: 'Carga la lista para buscar por nombre.' }), loadBtn);
    const label = (cid) => { const n = chatName(id, cid); return n ? `${n} — ${cid}` : cid; };
    const updateHint = () => {
        hint.hidden = Boolean(S.groups[id] && S.contacts[id]);
        loadBtn.disabled = inst(id).status !== 'ready';
    };
    loadBtn.addEventListener('click', () => withBusy(loadBtn, async () => { await loadChats(id); updateHint(); }));

    const choose = (cid) => { target = cid; input.value = label(cid); pop.hidden = true; text.focus(); };
    const suggest = () => {
        const raw = input.value.trim();
        target = CHAT_ID.test(raw) ? raw : '';
        const q = norm(raw);
        const all = [...(S.groups[id] || []).map((g) => ({ ...g, k: '👥' })), ...(S.contacts[id] || []).map((x) => ({ ...x, k: '👤' }))];
        if (!q || !all.length) { pop.hidden = true; return; }
        const hits = all.filter((x) => norm(x.name).includes(q) || x.id.includes(q)).slice(0, 30);
        pop.replaceChildren(...hits.map((x) => h('button', { type: 'button', onmousedown: (e) => { e.preventDefault(); choose(x.id); } },
            `${x.k} `, h('span', { text: x.name || x.id }), h('span', { class: 'id', text: x.id.split('@')[0] }))));
        pop.hidden = !hits.length;
    };
    input.addEventListener('input', suggest);
    input.addEventListener('focus', suggest);
    input.addEventListener('blur', () => setTimeout(() => { pop.hidden = true; }, 120));

    const send = h('button', { class: 'btn', text: 'Enviar' });
    const doSend = () => withBusy(send, async () => {
        const to = target || input.value.trim();
        if (!CHAT_ID.test(to)) throw new Error('Elige un destinatario de la lista o pega un id …@g.us / …@c.us');
        if (!text.value.trim()) throw new Error('Escribe el mensaje');
        await api.post(api.inst(id, 'send'), { to, text: text.value });
        text.value = '';
        toast(`Enviado a ${label(to)}`);
    });
    send.addEventListener('click', doSend);
    text.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doSend(); });
    updateHint();

    drawer.open(`Enviar mensaje · ${inst(id).name}`, {
        acc: accClass(id),
        focus: input,
        isDirty: () => text.value.trim() !== '',
        body: [section('Para', null, h('div', { class: 'combo' }, input, pop), hint), section('Mensaje', null, text)],
        foot: [h('span', { class: 'muted small grow', text: inst(id).status === 'ready' ? 'Se envía desde esta cuenta.' : 'La cuenta tiene que estar conectada.' }), send],
    });
}

// ---------- panel: ajustes ----------

function openSettings() {
    // navegador
    const brState = h('div', { class: 'stack' });
    const detected = h('div', { class: 'picker-list' });
    const brPath = h('input', { type: 'text', placeholder: 'chrome.exe, msedge.exe, /usr/bin/chromium…' });
    const brSave = h('button', { class: 'btn ghost sm', text: 'Usar esta ruta' });
    const brAuto = h('button', { class: 'link small', text: 'Volver a detectar automáticamente' });
    const drawBrowser = (b) => {
        const cur = b.current;
        brState.replaceChildren(cur.path
            ? h('div', { class: 'msg ok' }, h('b', { text: `Usando ${cur.name}` }), h('span', { class: 'mono', text: cur.path }))
            : h('div', { class: 'msg bad' }, h('b', { text: 'No se encontró ningún navegador' }), b.hint),
        ...(cur.warnings || []).map((w) => h('div', { class: 'msg warn small', text: w })));
        detected.replaceChildren(...(b.detected.length ? b.detected.map((d) => {
            const on = d.path === cur.path;
            const rb = h('input', { type: 'radio', name: 'browser', checked: on });
            rb.addEventListener('change', () => setPath(null, d.path));
            return h('label', { class: 'pick' }, rb, h('div', { class: 'who' }, h('div', { class: 'name', text: d.name }), h('div', { class: 'id', text: d.path })));
        }) : [h('div', { class: 'pick-empty', text: 'No hay ninguno en las rutas habituales.' })]));
        brAuto.hidden = !b.saved;
    };
    const setPath = (btn, p) => withBusy(btn, async () => {
        const r = await api.put('/api/browser', { path: p });
        S.snap.browser = r.status;
        drawBrowser(r.status);
        renderBanner();
        brPath.value = '';
        toast(p ? `Navegador: ${r.name || p}` : 'Detección automática');
    });
    brSave.addEventListener('click', () => { if (brPath.value.trim()) setPath(brSave, brPath.value.trim()); });
    brAuto.addEventListener('click', () => setPath(null, ''));
    drawBrowser(S.snap.browser);

    // telegram
    const tgState = h('div');
    const token = h('input', { type: 'password', autocomplete: 'off' });
    const chat = h('input', { type: 'text', placeholder: '-100xxxxxxxxxx' });
    const users = h('input', { type: 'text', placeholder: 'Ids separados por comas' });
    const tgSave = h('button', { class: 'btn sm', text: 'Guardar' });
    const tgTest = h('button', { class: 'btn ghost sm', text: 'Enviar prueba' });
    const drawTg = (c) => {
        const st = c.status || {};
        tgState.replaceChildren(!c.configured
            ? h('div', { class: 'msg plain' }, h('b', { text: 'Sin configurar' }), 'Crea un bot con @BotFather, añádelo a un grupo y pega aquí el token y el id del grupo.')
            : st.lastError
                ? h('div', { class: 'msg bad' }, h('b', { text: 'Problema con Telegram' }), st.lastError)
                : st.polling
                    ? h('div', { class: 'msg ok' }, h('b', { text: 'Conectado · escuchando comandos' }), `Bot ${c.tokenMasked} · grupo ${c.chatId}`)
                    : h('div', { class: 'msg info' }, h('b', { text: 'Conectando…' }), `Bot ${c.tokenMasked} · grupo ${c.chatId}`));
        chat.value = c.chatId || '';
        users.value = (c.allowedUserIds || []).join(', ');
        token.placeholder = c.tokenMasked || '123456:ABC-DEF…';
        tgTest.disabled = !c.configured;
    };
    tgSave.addEventListener('click', () => withBusy(tgSave, async () => {
        const body = { chatId: chat.value.trim(), allowedUserIds: users.value.split(/[,\s]+/).filter(Boolean) };
        if (token.value.trim()) body.token = token.value.trim();
        drawTg(await api.put('/api/telegram', body));
        token.value = '';
        toast('Telegram guardado');
        setTimeout(refreshTg, 1500); // da tiempo a la primera conexión
    }));
    tgTest.addEventListener('click', () => withBusy(tgTest, async () => { await api.post('/api/telegram/test'); toast('Prueba enviada al grupo'); }));
    const refreshTg = () => api.get('/api/telegram').then(drawTg).catch((e) => toast(e.message, 'err'));
    refreshTg();
    // el estado (escuchando / error) cambia solo: se refresca mientras el panel está abierto
    const tgTimer = setInterval(() => { if ($('#drawer').classList.contains('open') && document.body.contains(tgState)) refreshTg(); else clearInterval(tgTimer); }, 4000);

    // avisos del sistema (en este navegador)
    const notifSw = h('input', { type: 'checkbox', checked: notifyEnabled() });
    const notifNote = h('span');
    const drawNotif = () => {
        const perm = 'Notification' in window ? Notification.permission : 'unsupported';
        notifNote.textContent = perm === 'unsupported' ? 'Este navegador no admite avisos.'
            : perm === 'denied' ? 'El navegador los tiene bloqueados: permítelos en la configuración del sitio.'
                : 'Un aviso cada vez que el bot responde, si la ventana del panel no está a la vista.';
        notifSw.disabled = perm === 'unsupported' || perm === 'denied';
    };
    notifSw.addEventListener('change', async () => {
        if (notifSw.checked && Notification.permission !== 'granted') {
            const p = await Notification.requestPermission();
            if (p !== 'granted') notifSw.checked = false;
        }
        try { localStorage.setItem('wspanel.notify', notifSw.checked ? '1' : '0'); } catch { /* sin almacenamiento */ }
        drawNotif();
        if (notifSw.checked) toast('Avisos del sistema activados');
    });
    drawNotif();

    // escritorio: acceso directo, arranque con el sistema, cerrar
    const deskBox = h('div', { class: 'stack' }, h('span', { class: 'muted small', text: 'Cargando…' }));
    api.get('/api/desktop').then((d) => {
        if (!d.supported) { deskBox.replaceChildren(h('span', { class: 'muted small', text: 'No disponible en este sistema.' })); return; }
        const launcher = h('input', { type: 'checkbox', checked: d.launcher });
        const autostart = h('input', { type: 'checkbox', checked: d.autostart });
        const setD = (patch, input) => withBusy(null, async () => {
            try { const r = await api.put('/api/desktop', patch); launcher.checked = r.launcher; autostart.checked = r.autostart; toast('Hecho'); }
            catch (e) { input.checked = !input.checked; throw e; }
        });
        launcher.addEventListener('change', () => setD({ launcher: launcher.checked }, launcher));
        autostart.addEventListener('change', () => setD({ autostart: autostart.checked }, autostart));
        deskBox.replaceChildren(
            sw(launcher, 'Acceso directo en el menú de aplicaciones', d.platform === 'win32' ? 'En el Menú Inicio' : 'Aparece como «WSPanel» en tus aplicaciones'),
            sw(autostart, 'Arrancar con el sistema', 'Al iniciar sesión se conectan las cuentas en segundo plano, sin abrir ventana'));
    }).catch(() => deskBox.replaceChildren(h('span', { class: 'muted small', text: 'No disponible.' })));
    const quit = h('button', { class: 'btn danger sm', text: 'Cerrar WSPanel' });
    quit.addEventListener('click', async () => {
        if (!(await confirmDialog('¿Cerrar WSPanel?\n\nSe desconectan las cuentas y dejan de responder hasta que lo vuelvas a abrir.', 'Cerrar WSPanel'))) return;
        await withBusy(quit, () => api.post('/api/quit'));
        $('#board').replaceChildren(h('div', { class: 'section' }, h('h3', { text: 'WSPanel cerrado' }), h('p', { text: 'Ya puedes cerrar esta ventana.' })));
        drawer.close(true);
    });

    drawer.open('Ajustes', {
        body: [
            section('Navegador', 'WhatsApp Web funciona dentro de Chrome, Chromium, Edge o Brave. Se usa el que ya tengas; cada cuenta con su propio perfil.',
                brState, field('Detectados', detected), field('Otra ubicación', h('div', { class: 'row' }, h('div', { class: 'grow' }, brPath), brSave)), brAuto),
            section('Telegram', 'Avisa de cada respuesta y de las caídas. En el grupo: /status, /pause y /resume.',
                tgState, field('Token del bot', token, 'Déjalo vacío para conservar el actual'), field('Id del grupo', chat),
                field('Usuarios autorizados', users, 'Vacío = cualquier miembro del grupo puede usar los comandos'),
                h('div', { class: 'row end' }, tgTest, tgSave)),
            section('Avisos en este equipo', null, sw(notifSw, 'Avisos del sistema al responder', ''), notifNote),
            section('Escritorio', 'WSPanel solo se abre una vez: si ya está en marcha, lanzarlo de nuevo abre esta ventana.',
                deskBox, h('div', { class: 'row' }, h('span', { class: 'grow muted small', text: 'Cerrar la ventana no detiene el bot.' }), quit)),
            h('p', { class: 'muted small', style: 'text-align:center', text: `WSPanel ${S.snap.version || ''}` }),
        ],
    });
}

function notifyEnabled() {
    try { return 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem('wspanel.notify') === '1'; } catch { return false; }
}

// ---------- tablero ----------

function renderBanner() {
    const b = $('#banner');
    if (S.snap.fake) {
        b.replaceChildren('Modo simulado: no hay WhatsApp real conectado.');
        b.hidden = false;
    } else if (!S.snap.browser.found) {
        b.replaceChildren('No se encontró Chrome, Chromium, Edge ni Brave.', h('button', { class: 'link', text: 'Indicar navegador', onclick: () => openSettings() }));
        b.hidden = false;
    } else b.hidden = true;
}

function renderSwitcher() {
    const sw = $('#switcher');
    sw.replaceChildren(...ids().map((id) => {
        const [cls] = statusInfo(inst(id));
        return h('button', { class: `${accClass(id)} ${S.current === id ? 'active' : ''}`, role: 'tab', 'aria-selected': S.current === id,
            onclick: () => { S.current = id; renderSwitcher(); markCurrent(); } }, h('span', { class: `dot ${cls}` }), inst(id).name);
    }));
}
function markCurrent() {
    for (const [id, c] of Object.entries(S.columns)) c.el.classList.toggle('current', id === S.current);
}

function buildBoard() {
    const board = $('#board');
    S.columns = {};
    board.replaceChildren(...ids().map((id) => { S.columns[id] = accountColumn(id); return S.columns[id].el; }));
    if (!S.current || !ids().includes(S.current)) S.current = ids()[0];
    renderSwitcher();
    markCurrent();
    renderBanner();
}

// ---------- eventos en vivo ----------

function pushItem(id, it) {
    const arr = S.items[id] || (S.items[id] = []);
    arr.push(it);
    if (arr.length > ITEMS_MAX) arr.splice(0, arr.length - ITEMS_MAX);
    if (it.type === 'notification' && it.event === 'auto_reply') S.lastReply[id] = it.ts;
}

function applyBot(id, ev) {
    const i = inst(id);
    if (!i) return;
    let item = null;
    if (ev.type === 'status') {
        i.status = ev.value;
        i.retryInMs = ev.value === 'crashed' ? ev.retryInMs : null;
        if (ev.value !== 'qr') i.qr = null;
        if (ev.value === 'ready') loadConfig(id);
    } else if (ev.type === 'paused') {
        i.paused = Boolean(ev.value);
    } else if (ev.type === 'qr') {
        i.qr = ev.qr;
        S.qrVersion++;
    } else if (ev.type === 'log' || ev.type === 'notification') {
        item = { ts: Date.now(), ...ev };
        pushItem(id, item);
        if (ev.type === 'notification') {
            i.repliesToday = (i.repliesToday || 0) + 1;
            if (document.hidden && notifyEnabled()) {
                try {
                    const n = new Notification(`${i.name} respondió en ${ev.group || 'un grupo'}`, { body: ev.text ? `«${ev.text.slice(0, 120)}»` : ev.reply, icon: 'icon.svg', tag: `wspanel-${id}` });
                    n.onclick = () => { window.focus(); n.close(); };
                } catch { /* noop */ }
            }
        }
        if (ev.type === 'log' && ev.tag === 'CONFIG' && /hot-reloaded/.test(ev.msg)) loadConfig(id);
    }
    if (S.columns[id]) S.columns[id].onEvent(ev, item);
    if (ev.type === 'status' || ev.type === 'paused') renderSwitcher();
}

async function applySnapshot(snap) {
    const first = !S.snap;
    S.snap = snap;
    S.qrVersion++;
    await Promise.all(ids().map(async (id) => {
        try {
            const hist = await api.get(`${api.inst(id, 'history')}?limit=${ITEMS_MAX}`);
            S.items[id] = [];
            for (const it of hist) pushItem(id, it);
        } catch { S.items[id] = S.items[id] || []; }
    }));
    if (first) buildBoard();
    else { for (const c of Object.values(S.columns)) c.refreshAll(); renderSwitcher(); renderBanner(); }
    for (const id of ids()) loadConfig(id);
}

function setConn(state) {
    const c = $('#conn');
    c.className = 'conn ' + (state === 'ok' ? 'ok' : state === 'lost' ? 'bad' : '');
    $('.conn-text', c).textContent = state === 'ok' ? 'Conectado' : state === 'lost' ? 'Sesión caducada' : 'Reconectando…';
    if (state === 'lost') {
        $('#board').replaceChildren(h('div', { class: 'section' }, h('h3', { text: 'El panel se reinició' }),
            h('p', { text: 'Abre el enlace nuevo que aparece en la terminal (Panel: http://127.0.0.1:…/login?token=…).' })));
        S.columns = {};
    }
}

setInterval(() => { for (const c of Object.values(S.columns)) c.tick(); }, 30000);
connectEvents({ onSnapshot: applySnapshot, onBot: applyBot, onConn: setConn });
