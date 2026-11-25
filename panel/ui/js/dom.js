// Utilidades de DOM. Todo se crea con textContent (nunca innerHTML con datos),
// así nombres de grupos o mensajes no pueden inyectar HTML.
'use strict';

function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
        for (const [k, v] of Object.entries(props)) {
            if (v == null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
            else if (k === 'value') el.value = v;
            else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') el[k] = Boolean(v);
            else if (k === 'dataset') Object.assign(el.dataset, v);
            else el.setAttribute(k, v === true ? '' : String(v));
        }
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c == null || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- tooltips accesibles (popover="hint" + interestfor) ----------
// Botón que muestra información extra al pasar el ratón, enfocar o pulsación
// larga (interestfor) y también al tocarlo o pulsar Enter (popovertarget=show):
// así llega a teclado, móvil y lectores de pantalla, no solo al ratón.
// Devuelve [botón, popover]: el popover va justo después del botón.
let hintSeq = 0;
function hintTrigger({ text, hint, className = '', label }) {
    const pid = `hint-${++hintSeq}`;
    const pop = h('div', { id: pid, class: 'hint', popover: 'hint', role: 'tooltip' }, hint);
    const btn = h('button', {
        type: 'button', class: `hint-trigger ${className}`, interestfor: pid,
        popovertarget: pid, popovertargetaction: 'show', 'aria-expanded': 'false', 'aria-label': label,
    }, text);
    return [btn, pop];
}

(function setupHints() {
    const triggersFor = (pop) => document.querySelectorAll(`[interestfor="${CSS.escape(pop.id)}"]`);
    // aria-expanded sigue al popover (toggle no burbujea: fase de captura)
    document.addEventListener('toggle', (e) => {
        const pop = e.target;
        if (!(pop instanceof HTMLElement) || !pop.classList.contains('hint')) return;
        const open = e.newState === 'open';
        for (const t of triggersFor(pop)) {
            t.setAttribute('aria-expanded', String(open));
            if (open && typeof placeNear === 'function') placeNear(pop, t, { align: 'center' });
        }
    }, true);

    // popover="hint" no soportado → sería "manual" y no se cerraría al tocar:
    // convertirlo en "auto" justo al abrir (debe ser en beforetoggle)
    const probe = document.createElement('div');
    probe.popover = 'hint';
    if (probe.popover !== 'hint') {
        document.addEventListener('beforetoggle', (e) => {
            const t = e.target;
            if (e.newState === 'open' && t.getAttribute?.('popover') === 'hint') t.popover = 'auto';
        }, true);
    }

    // Sin interestfor nativo (Firefox, Safari, Chromium < 149): alternativa ligera.
    // Se puede pasar el ratón por encima del tooltip sin que se cierre (WCAG 1.4.13).
    if ('interestForElement' in HTMLButtonElement.prototype) return;
    const timers = new WeakMap();
    const later = (el, fn, ms) => { clearTimeout(timers.get(el)); timers.set(el, setTimeout(fn, ms)); };
    const targetOf = (el) => el && document.getElementById(el.getAttribute('interestfor'));
    const show = (trigger) => {
        const pop = targetOf(trigger);
        if (pop && !pop.matches(':popover-open')) { try { pop.showPopover({ source: trigger }); } catch { /* ya no está en el DOM */ } }
    };
    const hide = (pop) => { if (pop && pop.matches(':popover-open') && !pop.matches(':hover')) pop.hidePopover(); };
    document.addEventListener('pointerover', (e) => {
        const t = e.target.closest?.('[interestfor]');
        if (t) later(t, () => show(t), 400);
        const pop = e.target.closest?.('.hint');
        if (pop) clearTimeout(timers.get(pop));
    });
    document.addEventListener('pointerout', (e) => {
        const t = e.target.closest?.('[interestfor]');
        if (t && !t.contains(e.relatedTarget)) { clearTimeout(timers.get(t)); const pop = targetOf(t); later(pop, () => hide(pop), 250); }
        const pop = e.target.closest?.('.hint');
        if (pop && !pop.contains(e.relatedTarget)) later(pop, () => hide(pop), 250);
    });
    document.addEventListener('focusin', (e) => { const t = e.target.closest?.('[interestfor]'); if (t) show(t); });
    document.addEventListener('focusout', (e) => { const t = e.target.closest?.('[interestfor]'); if (t) hide(targetOf(t)); });
})();

// Anuncio para lectores de pantalla: ariaNotify() si existe; si no, región live.
function announce(msg, urgent = false) {
    if (typeof document.ariaNotify === 'function') {
        try { document.ariaNotify(msg, { priority: urgent ? 'high' : 'normal' }); return; } catch { /* sigue con la alternativa */ }
    }
    const region = document.getElementById(urgent ? 'announce-assertive' : 'announce-polite');
    if (!region) return;
    region.textContent = '';
    setTimeout(() => { region.textContent = msg; }, 50); // vaciar y rellenar para que se repita el anuncio
}

// Avisos breves. Los errores se quedan hasta cerrarlos; los demás se van solos,
// pero no mientras el ratón o el foco están encima. Con el panel lateral abierto
// (modal: lo de fuera queda inerte) el aviso se muestra dentro del panel.
function toast(msg, kind = 'ok', ms = 3800) {
    const persistent = kind === 'err';
    const drawerEl = document.getElementById('drawer');
    const inDrawer = Boolean(drawerEl && drawerEl.open);
    const host = inDrawer ? document.getElementById('drawer-status') : document.getElementById('toasts');
    const kindClass = { ok: 'ok', warn: 'warn', err: 'bad' }[kind] || 'plain';
    const close = h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Cerrar aviso', text: '×' });
    const t = inDrawer
        ? h('div', { class: `msg ${kindClass}` }, h('span', { class: 'grow', text: msg }), close)
        : h('div', { class: `toast ${kind}` }, h('span', { text: msg }), close);
    if (inDrawer) host.replaceChildren(t); else host.append(t);
    announce(msg, persistent);

    const dismiss = () => {
        if (!t.isConnected) return;
        const hadFocus = t.contains(document.activeElement);
        const next = t.nextElementSibling || t.previousElementSibling;
        t.remove();
        if (hadFocus) {
            const nextClose = next && next.querySelector('.toast-close');
            if (nextClose) nextClose.focus();
            else if (inDrawer && drawerEl.open) document.getElementById('drawer-close').focus();
        }
    };
    close.addEventListener('click', dismiss);
    if (persistent) return;
    let timer = setTimeout(dismiss, ms);
    const pause = () => clearTimeout(timer);
    const resume = () => { if (!t.matches(':hover') && !t.contains(document.activeElement)) { clearTimeout(timer); timer = setTimeout(dismiss, 1500); } };
    t.addEventListener('pointerenter', pause);
    t.addEventListener('focusin', pause);
    t.addEventListener('pointerleave', resume);
    t.addEventListener('focusout', () => setTimeout(resume));
}

function confirmDialog(text, okLabel = 'Confirmar') {
    const dlg = $('#confirm');
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((resolve) => {
        dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    });
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// minúsculas y sin acentos, para búsquedas
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

// Ejecuta una acción mostrando el botón ocupado y el error como aviso.
async function withBusy(btn, fn) {
    if (btn) btn.classList.add('busy');
    try { return await fn(); } catch (e) { toast(e.message, 'err', 6000); return undefined; } finally { if (btn) btn.classList.remove('busy'); }
}
