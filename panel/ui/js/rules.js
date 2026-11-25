// WSPanel — reglas: resumen en la tarjeta, editor (varias reglas, exclusiones,
// varias respuestas, grupos por regla, horario) y probador.
// Usa los globales de app.js (S, inst, chatName, fmtPhone, drawer, section, field, sw…).
'use strict';

const DAYS = [
    { d: 1, short: 'L', long: 'lunes' }, { d: 2, short: 'M', long: 'martes' }, { d: 3, short: 'X', long: 'miércoles' },
    { d: 4, short: 'J', long: 'jueves' }, { d: 5, short: 'V', long: 'viernes' }, { d: 6, short: 'S', long: 'sábado' },
    { d: 0, short: 'D', long: 'domingo' },
];

// ---------- horario (misma lógica que bot/lib/filter.js) ----------

const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const hasSchedule = (sc) => Boolean(sc && ((sc.days && sc.days.length) || sc.from || sc.to));

function inScheduleNow(sc, date = new Date()) {
    if (!hasSchedule(sc)) return true;
    const days = sc.days || [];
    const dayOk = (d) => !days.length || days.includes(d);
    const f = hm(sc.from);
    const t = hm(sc.to);
    const day = date.getDay();
    const now = date.getHours() * 60 + date.getMinutes();
    if (f == null && t == null) return dayOk(day);
    const a = f ?? 0;
    const b = t ?? 1440;
    if (a === b) return dayOk(day);
    if (a < b) return dayOk(day) && now >= a && now < b;
    if (now >= a) return dayOk(day);
    return now < b && dayOk((day + 6) % 7);
}

function daysText(days) {
    if (!days || !days.length) return 'todos los días';
    const set = new Set(days);
    const key = DAYS.map((x) => (set.has(x.d) ? '1' : '0')).join('');
    if (key === '1111100') return 'de lunes a viernes';
    if (key === '0000011') return 'los fines de semana';
    // tramos consecutivos L–V, etc.
    const parts = [];
    let i = 0;
    while (i < 7) {
        if (key[i] !== '1') { i++; continue; }
        let j = i;
        while (j + 1 < 7 && key[j + 1] === '1') j++;
        parts.push(j - i >= 2 ? `${DAYS[i].long} a ${DAYS[j].long}` : DAYS.slice(i, j + 1).map((x) => x.long).join(', '));
        i = j + 1;
    }
    return parts.join(', ');
}

function scheduleText(sc) {
    if (!hasSchedule(sc)) return '';
    const hours = sc.from && sc.to ? `de ${sc.from} a ${sc.to}` : sc.from ? `desde las ${sc.from}` : sc.to ? `hasta las ${sc.to}` : '';
    return [daysText(sc.days), hours].filter(Boolean).join(', ');
}

// ---------- resumen en la tarjeta ----------

function kwList(list, max = 5) {
    const out = [];
    list.slice(0, max).forEach((k, i) => {
        if (i) out.push(i === Math.min(list.length, max) - 1 && list.length <= max ? ' o ' : ', ');
        out.push(h('span', { class: 'kw', text: k }));
    });
    if (list.length > max) out.push(` y ${list.length - max} más`);
    return out;
}

function rulesSummary(id) {
    const c = S.cfg[id];
    const box = h('div', { class: 'sentence' });
    if (!c) return h('span', { class: 'muted', text: 'Cargando reglas…' });
    const rules = (c.rules || []).filter((r) => r.keywords.length);
    if (!rules.length) {
        append(box, [h('span', { class: 'warn', text: 'Sin palabras clave: no responderá a nada. ' }), h('button', { class: 'link', text: 'Añadir una regla', onclick: () => openRules(id) })]);
        return box;
    }
    const replyText = (r) => (r.replies.length > 1 ? `«${r.replies[0]}» (o ${r.replies.length - 1} más)` : `«${r.replies[0]}»`);
    const list = h('div', { class: 'rule-lines' });
    for (const r of rules) {
        list.append(h('div', { class: 'rule-line' },
            r.name ? h('span', { class: 'rule-name', text: r.name }) : null,
            'Responde ', h('span', { class: 'q', text: replyText(r) }), ' si escriben ', ...kwList(r.keywords),
            r.exclude.length ? [' (salvo ', ...kwList(r.exclude, 3).map((n) => (n.classList ? (n.classList.add('kw-x'), n) : n)), ')'] : '',
            r.groups.length ? h('span', { class: 'muted', text: ` · solo en ${r.groups.length === 1 ? (chatName(id, r.groups[0]) ? `«${chatName(id, r.groups[0])}»` : '1 grupo') : `${r.groups.length} grupos`}` }) : ''));
    }
    const g = c.allowed_groups.length;
    const u = c.allowed_users.length;
    const scope = [
        'En ', g ? hintTrigger({
            className: 'scope',
            text: g === 1 ? (chatName(id, c.allowed_groups[0]) ? `«${chatName(id, c.allowed_groups[0])}»` : '1 grupo') : `${g} grupos`,
            hint: c.allowed_groups.map((x) => chatName(id, x) || x).join('\n'),
        }) : h('span', { class: 'warn', text: 'cualquier grupo' }),
        u ? [', solo a ', hintTrigger({
            className: 'scope',
            text: u === 1 ? (chatName(id, c.allowed_users[0]) || fmtPhone(c.allowed_users[0])) : `${u} personas`,
            hint: c.allowed_users.map((x) => chatName(id, x) || fmtPhone(x)).join('\n'),
        })] : ', a cualquiera',
        '. ',
    ];
    const extra = [
        hasSchedule(c.schedule) ? `Horario: ${scheduleText(c.schedule)}` : null,
        c.reply_delay_ms ? `espera ${(c.reply_delay_ms / 1000).toLocaleString()} s` : 'al instante',
        c.cooldown_ms ? `máx. 1 cada ${Math.round(c.cooldown_ms / 1000)} s ${c.cooldown_scope === 'global' ? 'en total' : 'por grupo'}` : null,
    ].filter(Boolean).join(' · ');
    append(box, [list, h('div', { class: 'rule-scope' }, ...scope, h('span', { class: 'muted', text: extra.charAt(0).toUpperCase() + extra.slice(1) + '.' }))]);
    return box;
}

// ---------- componentes del editor ----------

// Etiquetas editables (palabras clave, exclusiones) → { el, get, pending, commit }
function chipInput(initial, placeholder) {
    let items = [...initial];
    const input = h('input', { type: 'text', placeholder });
    const box = h('div', { class: 'chips' }, input);
    const draw = () => {
        for (const x of [...box.querySelectorAll('.chip')]) x.remove();
        items.forEach((k, i) => input.before(h('span', { class: 'chip' }, k,
            h('button', { type: 'button', text: '×', 'aria-label': `Quitar ${k}`, onclick: () => { items.splice(i, 1); draw(); input.focus(); } }))));
    };
    const commit = () => {
        for (const p of input.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) if (!items.some((k) => norm(k) === norm(p))) items.push(p);
        input.value = '';
        draw();
    };
    input.addEventListener('keydown', (e) => {
        // Con un IME (chino, japonés, coreano…) Enter confirma la conversión: no es nuestro.
        // keyCode 229 cubre a Safari, que a veces informa isComposing tarde.
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
        else if (e.key === 'Backspace' && !input.value && items.length) { items.pop(); draw(); }
    });
    input.addEventListener('blur', () => { if (input.value.trim()) commit(); });
    box.addEventListener('click', (e) => { if (e.target === box) input.focus(); });
    draw();
    return { el: box, input, get: () => (commit(), [...items]), pending: () => input.value.trim() !== '' };
}

// Lista de respuestas (una o varias) → { el, get }
function repliesInput(initial) {
    const list = h('div', { class: 'replies' });
    const add = (text = '') => {
        const ta = h('textarea', { rows: 2, value: text, placeholder: 'Texto de la respuesta' });
        const row = h('div', { class: 'reply-row' }, ta,
            h('button', { type: 'button', class: 'icon-btn sm', title: 'Quitar esta respuesta', 'aria-label': 'Quitar respuesta', text: '×',
                onclick: () => { if (list.childElementCount > 1) row.remove(); else ta.value = ''; } }));
        list.append(row);
        return ta;
    };
    (initial.length ? initial : ['']).forEach((t) => add(t));
    const more = h('button', { type: 'button', class: 'link small', text: '+ Otra respuesta (se elige una al azar)', onclick: () => add().focus() });
    return { el: h('div', { class: 'stack' }, list, more), get: () => [...list.querySelectorAll('textarea')].map((t) => t.value.trim()).filter(Boolean) };
}

// Selector de grupos con casillas → { el, get }  (lista: grupos cargados + los ya marcados)
function groupPicker(id, initial, emptyText) {
    const sel = new Set(initial);
    const search = h('input', { type: 'search', placeholder: 'Buscar grupo…' });
    const list = h('div', { class: 'picker-list short' });
    const draw = () => {
        const src = S.groups[id] || [];
        const known = new Map(src.map((x) => [x.id, x]));
        const all = [...[...sel].map((x) => known.get(x) || { id: x, name: '' }), ...src.filter((x) => !sel.has(x.id))];
        const q = norm(search.value.trim());
        const shown = (q ? all.filter((x) => norm(x.name).includes(q) || x.id.includes(q)) : all).slice(0, 200);
        list.replaceChildren(...(shown.length ? shown.map((x) => {
            const cb = h('input', { type: 'checkbox', checked: sel.has(x.id) });
            cb.addEventListener('change', () => (cb.checked ? sel.add(x.id) : sel.delete(x.id)));
            return h('label', { class: 'pick' }, cb, h('div', { class: 'who' }, h('div', { class: 'name', text: x.name || '(grupo sin cargar)' }), h('div', { class: 'id', text: x.id })));
        }) : [h('div', { class: 'pick-empty', text: S.groups[id] ? 'Sin resultados' : emptyText }) ]));
    };
    search.addEventListener('input', draw);
    draw();
    return { el: h('div', { class: 'stack' }, search, list), get: () => [...sel], redraw: draw };
}

// ---------- editor de reglas ----------

function openRules(id) {
    const c = S.cfg[id];
    if (!c) return toast('Las reglas aún se están cargando', 'warn');
    const initial = JSON.stringify(c);
    const ready = () => inst(id).status === 'ready';

    // --- reglas ---
    const rulesBox = h('div', { class: 'rule-cards' });
    const editors = [];
    function ruleCard(r, open) {
        const name = h('input', { type: 'text', value: r.name || '', placeholder: 'Nombre (opcional), p. ej. «Aeropuerto»' });
        const kws = chipInput(r.keywords || [], 'Palabras o frases; Enter para añadir');
        const exc = chipInput(r.exclude || [], 'Opcional: p. ej. «no voy»');
        const reps = repliesInput(r.replies || []);
        const onlyGroups = h('input', { type: 'checkbox', checked: (r.groups || []).length > 0 });
        const picker = groupPicker(id, r.groups || [], 'Carga los grupos (abajo, en «Dónde y a quién») para elegir.');
        picker.el.hidden = !onlyGroups.checked;
        onlyGroups.addEventListener('change', () => { picker.el.hidden = !onlyGroups.checked; });
        const title = h('span', { class: 'grow rule-title' });
        const updTitle = () => { title.textContent = name.value.trim() || `Regla ${editors.indexOf(ed) + 1}`; };
        name.addEventListener('input', updTitle);
        const body = h('div', { class: 'rule-body stack', hidden: !open },
            field('Nombre', name),
            field('Responder si el mensaje contiene', kws.el, 'Como palabra completa, sin importar mayúsculas ni acentos.'),
            field('Excepto si contiene', exc.el, 'Opcional. Déjalo vacío si no hace falta.'),
            field('Respuesta', reps.el),
            sw(onlyGroups, 'Solo en algunos grupos', 'Opcional: esta regla solo vale en los grupos que marques'),
            picker.el);
        const toggle = h('button', { type: 'button', class: 'icon-btn sm', title: 'Mostrar u ocultar', text: open ? '▾' : '▸' });
        const head = h('div', { class: 'rule-head' }, toggle, title,
            h('button', { type: 'button', class: 'icon-btn sm', title: 'Subir', 'aria-label': 'Subir regla', text: '↑', onclick: () => move(-1) }),
            h('button', { type: 'button', class: 'icon-btn sm', title: 'Bajar', 'aria-label': 'Bajar regla', text: '↓', onclick: () => move(1) }),
            h('button', { type: 'button', class: 'icon-btn sm danger', title: 'Borrar regla', 'aria-label': 'Borrar regla', text: '🗑', onclick: () => remove() }));
        const card = h('div', { class: 'rule-card' }, head, body);
        head.addEventListener('click', (e) => {
            if (e.target.closest('button') && e.target !== toggle) return;
            body.hidden = !body.hidden;
            toggle.textContent = body.hidden ? '▸' : '▾';
        });
        const ed = {
            card,
            redrawGroups: picker.redraw,
            pending: () => kws.pending() || exc.pending(),
            get: () => ({ name: name.value.trim(), keywords: kws.get(), exclude: exc.get(), replies: reps.get(), groups: onlyGroups.checked ? picker.get() : [] }),
        };
        function move(d) {
            const i = editors.indexOf(ed);
            const j = i + d;
            if (j < 0 || j >= editors.length) return;
            editors.splice(i, 1);
            editors.splice(j, 0, ed);
            redraw();
        }
        async function remove() {
            if (!(await confirmDialog('¿Borrar esta regla?', 'Borrar'))) return;
            editors.splice(editors.indexOf(ed), 1);
            redraw();
        }
        ed.updTitle = updTitle;
        return ed;
    }
    function redraw() {
        rulesBox.replaceChildren(...editors.map((e) => e.card));
        editors.forEach((e) => e.updTitle());
        if (!editors.length) rulesBox.append(h('div', { class: 'pick-empty', text: 'Sin reglas: el bot no responderá a nada.' }));
    }
    (c.rules.length ? c.rules : [{ keywords: [], replies: [] }]).forEach((r, i, arr) => editors.push(ruleCard(r, arr.length === 1 || i === 0)));
    redraw();
    const addRule = h('button', { type: 'button', class: 'btn ghost sm', text: '+ Nueva regla',
        onclick: () => { const e = ruleCard({ keywords: [], replies: [] }, true); editors.push(e); redraw(); e.card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } });

    // --- dónde y a quién (cuenta) ---
    const sel = { groups: new Set(c.allowed_groups), users: new Set(c.allowed_users) };
    let tab = 'groups';
    const tabs = h('div', { class: 'tabs2' });
    const search = h('input', { type: 'search', placeholder: 'Buscar…' });
    const list = h('div', { class: 'picker-list' });
    const manual = h('input', { type: 'text', placeholder: 'O añade un id: 34600000000, …@c.us, …@g.us' });
    const loadBtn = h('button', { type: 'button', class: 'btn ghost sm' });
    const source = () => (tab === 'groups' ? S.groups[id] : S.contacts[id]);
    const drawTabs = () => renderTabs(tabs, {
        label: 'Dónde y a quién',
        selected: tab,
        items: [
            { key: 'groups', content: ['Grupos', h('span', { class: 'count-pill', text: String(sel.groups.size || 'todos') })], panel: list },
            { key: 'users', content: ['Personas', h('span', { class: 'count-pill', text: String(sel.users.size || 'todas') })], panel: list },
        ],
        onSelect: (k) => { tab = k; drawTabs(); drawList(); },
    });
    function drawList() {
        const set = sel[tab];
        const src = source() || [];
        loadBtn.textContent = source() ? '↻ Actualizar' : (tab === 'groups' ? 'Cargar mis grupos' : 'Cargar mis contactos');
        loadBtn.disabled = !ready();
        loadBtn.title = ready() ? '' : 'La cuenta tiene que estar conectada';
        const known = new Map(src.map((x) => [x.id, x]));
        const all = [...[...set].map((x) => known.get(x) || { id: x, name: '' }), ...src.filter((x) => !set.has(x.id))];
        const q = norm(search.value.trim());
        const shown = (q ? all.filter((x) => norm(x.name).includes(q) || x.id.includes(q)) : all).slice(0, 300);
        list.replaceChildren(...(shown.length ? shown.map((x) => {
            const cb = h('input', { type: 'checkbox', checked: set.has(x.id) });
            cb.addEventListener('change', () => { if (cb.checked) set.add(x.id); else set.delete(x.id); drawTabs(); });
            return h('label', { class: 'pick' }, cb, h('div', { class: 'who' },
                h('div', { class: 'name', text: x.name || (tab === 'users' ? fmtPhone(x.id) : '(grupo sin cargar)') }), h('div', { class: 'id', text: x.id })));
        }) : [h('div', { class: 'pick-empty', text: source() ? 'Sin resultados' : `Ninguno marcado: vale ${tab === 'groups' ? 'cualquier grupo' : 'cualquier persona'}. Carga la lista para elegir.` })]));
    }
    loadBtn.addEventListener('click', () => withBusy(loadBtn, async () => {
        const kind = tab === 'groups' ? 'groups' : 'contacts';
        await loadChats(id, [kind], { refresh: Boolean(S[kind][id]) });
        drawList();
        if (kind === 'groups') editors.forEach((e) => e.redrawGroups());
    }));
    let st;
    search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(drawList, 120); });
    manual.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (e.isComposing || e.keyCode === 229) return; // Enter del IME, no de añadir
        let v = manual.value.trim().replace(/\s+/g, '');
        if (/^\+?\d{6,}$/.test(v)) v = v.replace('+', '') + '@c.us';
        if (!CHAT_ID.test(v)) return toast('Formato no válido: número, …@c.us o …@g.us', 'err');
        tab = v.endsWith('@g.us') ? 'groups' : 'users';
        sel[tab].add(v);
        manual.value = '';
        drawTabs();
        drawList();
    });
    drawTabs();
    drawList();

    // --- horario ---
    const sc = c.schedule || { days: [], from: '', to: '' };
    const dayBtns = DAYS.map((x) => {
        const b = h('button', { type: 'button', class: `day ${sc.days.includes(x.d) ? 'on' : ''}`, title: x.long, 'aria-pressed': sc.days.includes(x.d), text: x.short });
        b.addEventListener('click', () => { b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on')); updSched(); });
        b.dataset.d = x.d;
        return b;
    });
    const from = h('input', { type: 'time', value: sc.from });
    const to = h('input', { type: 'time', value: sc.to });
    const schedNote = h('div', { class: 'hint' });
    const schedValue = () => ({ days: dayBtns.filter((b) => b.classList.contains('on')).map((b) => Number(b.dataset.d)), from: from.value, to: to.value });
    function updSched() {
        const v = schedValue();
        schedNote.textContent = hasSchedule(v)
            ? `Responde ${scheduleText(v)}.${hm(v.from) != null && hm(v.to) != null && hm(v.from) > hm(v.to) ? ' (El tramo cruza la medianoche.)' : ''} Fuera de ese horario no contesta.`
            : 'Sin horario: responde siempre.';
    }
    from.addEventListener('input', updSched);
    to.addEventListener('input', updSched);
    const clearSched = h('button', { type: 'button', class: 'link small', text: 'Quitar horario', onclick: () => { dayBtns.forEach((b) => b.classList.remove('on')); from.value = ''; to.value = ''; updSched(); } });
    updSched();

    // --- tiempos y opciones ---
    const delay = h('input', { type: 'number', min: 0, step: 0.5, value: c.reply_delay_ms / 1000 });
    const cool = h('input', { type: 'number', min: 0, step: 1, value: c.cooldown_ms / 1000 });
    const coolScope = h('select', {},
        h('option', { value: 'group', text: 'en cada grupo' }),
        h('option', { value: 'global', text: 'en total (todos los grupos)' }));
    coolScope.value = c.cooldown_scope === 'global' ? 'global' : 'group';
    const coolNote = h('div', { class: 'hint' });
    const updCool = () => {
        const s = Math.round(parseFloat(cool.value) || 0);
        coolScope.disabled = !s;
        coolNote.textContent = !s ? 'Sin límite: responde a todos los mensajes que cumplan las reglas.'
            : coolScope.value === 'global'
                ? `Tras responder en cualquier grupo, no vuelve a responder en ninguno durante ${s} s.`
                : `Tras responder en un grupo, no vuelve a responder en ese mismo grupo durante ${s} s; en los demás sí.`;
    };
    cool.addEventListener('input', updCool);
    coolScope.addEventListener('change', updCool);
    updCool();
    const debug = h('input', { type: 'checkbox', checked: c.debug });
    const mobile = h('input', { type: 'checkbox', checked: !c.suppress_mobile_notifications });
    const show = h('input', { type: 'checkbox', checked: c.headless === false });

    const values = () => ({
        ...c,
        rules: editors.map((e) => e.get()),
        allowed_groups: [...sel.groups],
        allowed_users: [...sel.users],
        schedule: schedValue(),
        reply_delay_ms: Math.max(0, Math.round((parseFloat(delay.value) || 0) * 1000)),
        cooldown_ms: Math.max(0, Math.round((parseFloat(cool.value) || 0) * 1000)),
        cooldown_scope: coolScope.value,
        debug: debug.checked,
        suppress_mobile_notifications: !mobile.checked,
        headless: !show.checked,
    });
    const isDirty = () => editors.some((e) => e.pending()) || JSON.stringify(values()) !== initial;

    const save = h('button', { class: 'btn', text: 'Guardar reglas' });
    save.addEventListener('click', () => withBusy(save, async () => {
        const v = values();
        const empty = v.rules.findIndex((r) => !r.keywords.length);
        if (empty >= 0 && v.rules.length > 1) throw new Error(`La regla ${empty + 1} no tiene palabras clave: añade alguna o bórrala.`);
        const fresh = await api.get(api.inst(id, 'config')); // conservar claves que no edita el panel
        S.cfg[id] = await api.put(api.inst(id, 'config'), { ...fresh, ...v });
        S.columns[id].refreshRules();
        await drawer.close(true); // cerrado del todo antes del aviso (si no, iría dentro del panel)
        toast('Reglas guardadas · se aplican al momento');
    }));

    drawer.open(`Reglas · ${inst(id).name}`, {
        acc: accClass(id),
        isDirty,
        body: [
            section('Reglas', 'Se comprueban en orden: responde la primera que encaje. Usa ↑ ↓ para cambiar el orden.', rulesBox, h('div', { class: 'row' }, addRule)),
            section('Dónde y a quién', 'Para toda la cuenta. Si no marcas ninguno, vale cualquiera.',
                tabs, h('div', { class: 'row' }, h('div', { class: 'grow' }, search), loadBtn), list, manual),
            section('Horario', 'Opcional. Sin días ni horas = responde siempre.',
                h('div', { class: 'days' }, ...dayBtns),
                h('div', { class: 'pair' }, field('Desde', from), field('Hasta', to)),
                schedNote, h('div', {}, clearSched)),
            section('Tiempos', null,
                h('div', { class: 'pair' }, field('Esperar antes de responder (s)', delay, '0 = al instante'), field('Máx. 1 respuesta cada (s)', cool, '0 = sin límite')),
                field('Contar ese límite', coolScope), coolNote),
            section('Opciones', null,
                sw(mobile, 'Notificaciones en el móvil', 'El móvil sigue avisando aunque el bot esté conectado'),
                sw(debug, 'Registrar todos los mensajes', 'Guarda en el registro técnico también los que no disparan respuesta'),
                sw(show, 'Mostrar la ventana del navegador', 'Para depurar; se aplica al reiniciar')),
        ],
        foot: [
            h('button', { class: 'btn ghost', text: '🧪 Probar', title: 'Probar las reglas guardadas con un mensaje de ejemplo', onclick: async () => { if (await drawer.close()) openTester(id); } }),
            h('span', { class: 'grow' }), h('button', { class: 'btn ghost', text: 'Cancelar', onclick: () => drawer.close() }), save,
        ],
    });
}

// ---------- probador ----------

const REASONS = {
    not_group: ['plain', 'No es un grupo', 'El bot solo responde en grupos.'],
    group: ['warn', 'Este grupo no está permitido', 'Añádelo en «Dónde y a quién» o deja la lista vacía para todos.'],
    no_keyword: ['plain', 'Ninguna regla encaja', 'El mensaje no contiene ninguna de las palabras clave (como palabra completa).'],
    excluded: ['warn', 'Encaja, pero está excluido', ''],
    user: ['warn', 'Esta persona no está permitida', 'Añádela en «Dónde y a quién» o deja la lista vacía para todas.'],
    schedule: ['warn', 'Fuera de horario', ''],
    paused: ['warn', 'La auto-respuesta está en pausa', 'Encaja con las reglas, pero ahora mismo la cuenta está en pausa.'],
};

function openTester(id) {
    const groupSel = h('select');
    const userSel = h('select');
    const userOther = h('input', { type: 'text', placeholder: 'Número, p. ej. 34600000000', hidden: true });
    const text = h('textarea', { rows: 3, placeholder: 'Escribe el mensaje que llegaría al grupo…' });
    const when = h('input', { type: 'datetime-local' });
    const out = h('div', { class: 'test-result' });

    const fillSelects = () => {
        const c = S.cfg[id] || { allowed_groups: [], allowed_users: [] };
        const groups = c.allowed_groups.length ? c.allowed_groups.map((g) => ({ id: g, name: chatName(id, g) || g })) : (S.groups[id] || []);
        groupSel.replaceChildren(
            ...(groups.length ? groups.map((g) => h('option', { value: g.id, text: g.name || g.id })) : [h('option', { value: '000@g.us', text: 'Un grupo cualquiera' })]),
            ...(c.allowed_groups.length ? [h('option', { value: '000@g.us', text: 'Otro grupo (no permitido)' })] : []));
        const users = c.allowed_users.map((u) => ({ id: u, name: chatName(id, u) || fmtPhone(u) }));
        userSel.replaceChildren(
            ...users.map((u) => h('option', { value: u.id, text: u.name })),
            h('option', { value: '', text: users.length ? 'Otra persona…' : 'Cualquier persona' }));
        userOther.hidden = Boolean(userSel.value) || !users.length;
    };
    userSel.addEventListener('change', () => { userOther.hidden = Boolean(userSel.value) || !(S.cfg[id] || {}).allowed_users?.length; run(); });

    let t;
    const run = () => { clearTimeout(t); t = setTimeout(go, 200); };
    async function go() {
        if (!text.value.trim()) { out.replaceChildren(h('div', { class: 'msg plain' }, 'Escribe un mensaje para ver qué haría el bot.')); return; }
        try {
            const r = await api.post(api.inst(id, 'test'), {
                groupId: groupSel.value, user: userSel.value || userOther.value || '0@c.us', text: text.value,
                at: when.value ? new Date(when.value).toISOString() : undefined,
            });
            if (r.ok) {
                out.replaceChildren(h('div', { class: 'msg ok' },
                    h('b', { text: 'Respondería' }),
                    h('div', { class: 'bubble out test-bubble', text: r.reply }),
                    h('div', { class: 'small muted', text: `Regla: ${r.ruleName || `Regla ${r.rule + 1}`} · palabra «${r.keyword}»${r.delayMs ? ` · tras ${(r.delayMs / 1000).toLocaleString()} s` : ''}` })));
            } else {
                const [kind, title, why] = REASONS[r.reason] || ['plain', r.reason, ''];
                let detail = why;
                if (r.reason === 'excluded') detail = r.excluded.map((e) => `«${e.keyword}» encaja con ${e.ruleName || `la regla ${e.rule + 1}`}, pero el mensaje contiene «${e.by}».`).join(' ');
                if (r.reason === 'schedule') detail = `Las reglas encajan, pero solo responde ${scheduleText((S.cfg[id] || {}).schedule)}.`;
                out.replaceChildren(h('div', { class: `msg ${kind}` }, h('b', { text: `No respondería: ${title.toLowerCase()}` }), detail,
                    r.keyword ? h('div', { class: 'small muted', text: `Encaja con ${r.ruleName || `la regla ${r.rule + 1}`} (palabra «${r.keyword}»).` }) : null));
            }
        } catch (e) { out.replaceChildren(h('div', { class: 'msg bad' }, e.message)); }
    }
    for (const el of [groupSel, userOther, text, when]) el.addEventListener('input', run);
    groupSel.addEventListener('change', run);
    fillSelects();
    go();

    drawer.open(`Probar reglas · ${inst(id).name}`, {
        acc: accClass(id),
        focus: text,
        body: [
            section('Mensaje de ejemplo', 'Comprueba qué haría el bot con las reglas guardadas, sin enviar nada a WhatsApp.',
                field('Grupo', groupSel), field('Quién lo escribe', h('div', { class: 'stack' }, userSel, userOther)), field('Mensaje', text),
                field('Fecha y hora', when, 'Opcional, para probar el horario. Vacío = ahora.')),
            section('Resultado', null, out),
        ],
        foot: [h('span', { class: 'grow muted small', text: 'No se envía nada.' }), h('button', { class: 'btn ghost', text: '✎ Editar reglas', onclick: () => openRules(id) })],
    });
}
