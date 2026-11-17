// Resolución @lid ↔ @c.us con caché persistente y caché negativa.
// `lookup(ids)` devuelve [{ lid, pn }] (en producción: client.getContactLidAndPhone).
const fs = require('fs');
const path = require('path');

class LidResolver {
    constructor({ lookup, cacheFile = null, negativeTtlMs = 10 * 60 * 1000, now = Date.now } = {}) {
        this.lookup = lookup;
        this.cacheFile = cacheFile;
        this.negativeTtlMs = negativeTtlMs;
        this.now = now;
        this.lidToPn = new Map();
        this.pnToLid = new Map();
        this.misses = new Map(); // lid -> timestamp del último fallo
        this.inflight = new Map(); // lid -> Promise (deduplica búsquedas simultáneas)
        this.saveTimer = null;
    }

    load() {
        if (!this.cacheFile) return 0;
        try {
            const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
            for (const [lid, pn] of Object.entries(data || {})) this._store(lid, pn, false);
        } catch { /* primer arranque o caché corrupta */ }
        return this.lidToPn.size;
    }

    _store(lid, pn, persist = true) {
        if (!lid || !pn || !lid.endsWith('@lid') || !pn.endsWith('@c.us')) return;
        this.lidToPn.set(lid, pn);
        this.pnToLid.set(pn, lid);
        this.misses.delete(lid);
        if (persist) this._scheduleSave();
    }

    _scheduleSave() {
        if (!this.cacheFile || this.saveTimer) return;
        this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 1000);
        if (this.saveTimer.unref) this.saveTimer.unref();
    }

    saveNow() {
        if (!this.cacheFile) return;
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        try {
            fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
            const tmp = this.cacheFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.lidToPn)), 'utf8');
            fs.renameSync(tmp, this.cacheFile);
        } catch { /* no crítico */ }
    }

    cachedPhone(id) {
        if (!id) return null;
        if (id.endsWith('@c.us')) return id;
        return this.lidToPn.get(id) || null;
    }

    // @lid → @c.us. Devuelve null si no se puede resolver (y lo recuerda un rato).
    async toPhone(id) {
        const hit = this.cachedPhone(id);
        if (hit || !id || !id.endsWith('@lid')) return hit;
        const miss = this.misses.get(id);
        if (miss !== undefined && this.now() - miss < this.negativeTtlMs) return null;
        if (this.inflight.has(id)) return this.inflight.get(id);

        const p = (async () => {
            try {
                const [r] = (await this.lookup([id])) || [];
                if (r && r.pn) {
                    this._store(r.lid || id, r.pn);
                    return r.pn;
                }
            } catch { /* red/página caída: tratar como fallo temporal */ }
            this.misses.set(id, this.now());
            return null;
        })().finally(() => this.inflight.delete(id));
        this.inflight.set(id, p);
        return p;
    }

    // Pre-resuelve una lista de @c.us (p. ej. allowed_users) en un solo lookup.
    async warm(pns) {
        const missing = (pns || []).filter((pn) => pn.endsWith('@c.us') && !this.pnToLid.has(pn));
        if (!missing.length) return { resolved: 0, total: (pns || []).length };
        let resolved = 0;
        try {
            for (const r of (await this.lookup(missing)) || []) {
                if (r && r.lid && r.pn) { this._store(r.lid, r.pn); resolved++; }
            }
        } catch { /* se resolverán bajo demanda */ }
        return { resolved, total: pns.length };
    }
}

module.exports = { LidResolver };
