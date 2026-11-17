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

function toast(msg, kind = 'ok', ms = 3800) {
    const t = h('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, msg);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), ms);
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
