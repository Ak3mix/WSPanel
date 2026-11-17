// Cliente de la API local + conexión de eventos en vivo (SSE).
'use strict';

const api = {
    async call(method, path, body) {
        const r = await fetch(path, {
            method,
            headers: { 'X-WSPanel': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            credentials: 'same-origin',
        });
        let data = null;
        try { data = await r.json(); } catch { /* sin cuerpo JSON */ }
        if (r.status === 401) throw new Error('La sesión del panel cambió: abre el enlace nuevo que aparece en la terminal.');
        if (!r.ok) throw new Error((data && data.error) || `Error ${r.status}`);
        return data;
    },
    get(p) { return this.call('GET', p); },
    post(p, body = {}) { return this.call('POST', p, body); },
    put(p, body) { return this.call('PUT', p, body); },
    inst(id, action) { return `/api/instances/${encodeURIComponent(id)}/${action}`; },
};

// onSnapshot(snapshot), onBot(id, ev), onConn('ok' | 'retry' | 'lost')
function connectEvents({ onSnapshot, onBot, onConn }) {
    let es;
    const open = () => {
        es = new EventSource('/api/events');
        es.addEventListener('open', () => onConn('ok'));
        es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data)));
        es.addEventListener('bot', (e) => {
            const { id, ev } = JSON.parse(e.data);
            onBot(id, ev);
        });
        es.addEventListener('error', async () => {
            if (es.readyState !== EventSource.CLOSED) return onConn('retry'); // reintenta solo
            // cerrado del todo: ¿panel apagado o token nuevo?
            try {
                const r = await fetch('/api/state', { credentials: 'same-origin' });
                if (r.status === 401) return onConn('lost');
            } catch { /* panel apagado */ }
            onConn('retry');
            setTimeout(open, 3000);
        });
    };
    open();
}
