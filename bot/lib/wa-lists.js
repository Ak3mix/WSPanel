// Listas de grupos y contactos, pensadas para cuentas grandes.
//
// client.getChats() / client.getContacts() de whatsapp-web.js serializan cada
// chat/contacto completo (último mensaje, metadatos, perfil de empresa…) y
// getContacts() devuelve también a todos los participantes de todos los grupos.
// Aquí se lee solo id + nombre directamente en la página, con tope de
// resultados, caché, una sola consulta a la vez y tiempo máximo.
// Si la lectura interna falla (cambio de WhatsApp Web), se usa la API estándar.

const LIMITS = Object.freeze({ groups: 5000, contacts: 20000, timeoutMs: 60000, cacheMs: 60000 });

function withTimeout(p, ms, what) {
    let timer;
    const limit = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${what}: tiempo agotado (${Math.round(ms / 1000)} s)`)), ms);
    });
    return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

// --- lectura ligera dentro de la página ---
function pageGroups(max) {
    /* eslint-disable no-undef */
    const chats = window.require('WAWebCollections').Chat.getModelsArray();
    const items = [];
    let total = 0;
    for (const c of chats) {
        try {
            const id = c && c.id && c.id._serialized;
            if (!id || !id.endsWith('@g.us')) continue;
            total++;
            if (items.length < max) {
                const name = c.name || c.formattedTitle || (c.groupMetadata && c.groupMetadata.subject) || '';
                items.push({ id, name: String(name) });
            }
        } catch { /* chat raro: se ignora */ }
    }
    return { items, total };
}

function pageContacts(max) {
    const Contact = window.require('WAWebCollections').Contact;
    const G = window.require('WAWebContactGetters');
    const { getIsMyContact } = window.require('WAWebFrontendContactGetters');
    const WidFactory = window.require('WAWebWidFactory');
    const seen = new Set();
    const items = [];
    let total = 0;
    for (const c of Contact.getModelsArray()) {
        try {
            if (!getIsMyContact(c) || G.getIsMe(c) || G.getIsGroup(c) || !G.getIsUser(c)) continue;
            let id = c.id && c.id._serialized;
            const wid = WidFactory.createWidFromWidLike(c.id);
            if (wid.isLid() && c.phoneNumber) {
                id = typeof c.phoneNumber === 'object' ? c.phoneNumber._serialized : String(c.phoneNumber);
            }
            if (!id || !id.endsWith('@c.us') || seen.has(id)) continue;
            seen.add(id);
            total++;
            if (items.length < max) items.push({ id, name: String(G.getName(c) || G.getPushname(c) || '') });
        } catch { /* contacto raro: se ignora */ }
    }
    return { items, total };
}

// --- respaldo con la API estándar (más pesada, pero filtrada y limitada) ---
async function fallbackGroups(client, max) {
    const chats = await client.getChats();
    const all = chats.filter((c) => c.isGroup && c.id && c.id._serialized);
    return { items: all.slice(0, max).map((c) => ({ id: c.id._serialized, name: c.name || '' })), total: all.length };
}

async function fallbackContacts(client, max) {
    const seen = new Set();
    const all = [];
    for (const c of await client.getContacts()) {
        const id = c && c.id && c.id._serialized;
        if (!id || !id.endsWith('@c.us') || !c.isMyContact || c.isMe || c.isGroup || seen.has(id)) continue;
        seen.add(id);
        all.push({ id, name: c.name || c.pushname || '' });
    }
    return { items: all.slice(0, max), total: all.length };
}

function createLists(client, { limits = LIMITS, now = Date.now, log = () => {} } = {}) {
    const cache = {}; // kind -> { at, data }
    const inflight = {}; // kind -> Promise

    async function load(kind) {
        const max = limits[kind];
        const page = client.pupPage;
        if (page && typeof page.evaluate === 'function') {
            try {
                return await page.evaluate(kind === 'groups' ? pageGroups : pageContacts, max);
            } catch (e) {
                log('LISTS', `Lectura ligera de ${kind} falló, usando la API estándar`, { error: e.message });
            }
        }
        return kind === 'groups' ? fallbackGroups(client, max) : fallbackContacts(client, max);
    }

    async function get(kind, { refresh = false } = {}) {
        const c = cache[kind];
        if (!refresh && c && now() - c.at < limits.cacheMs) return { ...c.data, cached: true };
        if (inflight[kind]) return inflight[kind]; // ya hay una consulta en marcha: se comparte
        inflight[kind] = (async () => {
            try {
                const t0 = now();
                const r = await withTimeout(load(kind), limits.timeoutMs, kind === 'groups' ? 'Cargar grupos' : 'Cargar contactos');
                const items = (r.items || []).sort((a, b) => a.name.localeCompare(b.name));
                const data = { items, total: r.total ?? items.length, truncated: (r.total ?? items.length) > items.length, ms: now() - t0 };
                cache[kind] = { at: now(), data };
                return { ...data, cached: false };
            } finally {
                delete inflight[kind];
            }
        })();
        return inflight[kind];
    }

    return { get, invalidate: () => { for (const k of Object.keys(cache)) delete cache[k]; } };
}

module.exports = { createLists, LIMITS, pageGroups, pageContacts };
