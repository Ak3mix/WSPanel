// Historial de respuestas en disco: <dataDir>/history/<id>.jsonl (una línea por respuesta).
// Sobrevive a los reinicios del panel; de aquí salen las estadísticas y el
// contador de "respuestas hoy". Se conservan los últimos `keepDays` días.
const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function createHistoryStore({ dataDir, ids, keepDays = 90, maxPerAccount = 50000, now = Date.now }) {
    const dir = path.join(dataDir, 'history');
    const file = (id) => path.join(dir, `${id}.jsonl`);
    const entries = new Map(ids.map((id) => [id, []]));

    // carga + poda de lo antiguo (reescribe el archivo solo si sobraba algo)
    for (const id of ids) {
        let lines = [];
        try { lines = fs.readFileSync(file(id), 'utf8').split('\n'); } catch { continue; }
        const minTs = now() - keepDays * DAY;
        const arr = [];
        let dropped = 0;
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const e = JSON.parse(line);
                if (typeof e.ts === 'number' && e.ts >= minTs) arr.push(e); else dropped++;
            } catch { dropped++; } // línea corrupta (p. ej. corte de luz a mitad de escritura)
        }
        if (arr.length > maxPerAccount) { dropped += arr.length - maxPerAccount; arr.splice(0, arr.length - maxPerAccount); }
        entries.set(id, arr);
        if (dropped) {
            try {
                const tmp = file(id) + '.tmp';
                fs.writeFileSync(tmp, arr.map((e) => JSON.stringify(e)).join('\n') + (arr.length ? '\n' : ''), { mode: 0o600 });
                fs.renameSync(tmp, file(id));
            } catch { /* no crítico */ }
        }
    }

    function add(id, ev, ts = now()) {
        const arr = entries.get(id);
        if (!arr) return null;
        const e = {
            ts,
            group: ev.group || '', group_id: ev.group_id || '', sender: ev.sender || '',
            keyword: ev.keyword || '', rule: ev.rule || '', reply: ev.reply || '', text: String(ev.text || '').slice(0, 500),
        };
        if (Number.isFinite(ev.latency_ms)) e.latency_ms = ev.latency_ms; // tiempo de respuesta
        if (Number.isFinite(ev.delay_ms)) e.delay_ms = ev.delay_ms; // de ello, espera configurada
        if (Number.isFinite(ev.age_ms)) e.age_ms = ev.age_ms; // antigüedad del mensaje al llegar
        if (ev.delivery && ev.delivery !== 'sent') e.delivery = ev.delivery; // 'unconfirmed'
        arr.push(e);
        if (arr.length > maxPerAccount) arr.splice(0, arr.length - maxPerAccount);
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(file(id), JSON.stringify(e) + '\n', { mode: 0o600 });
        } catch { /* disco lleno o sin permisos: se mantiene en memoria */ }
        return e;
    }

    const recent = (id, limit = 200) => (entries.get(id) || []).slice(-limit);

    function countToday(id) {
        const today = dayKey(now());
        let n = 0;
        const arr = entries.get(id) || [];
        for (let i = arr.length - 1; i >= 0 && dayKey(arr[i].ts) === today; i--) n++;
        return n;
    }

    // Estadísticas de los últimos `days` días: por día (rellenando ceros), por grupo y por regla.
    function stats(id, days = 14) {
        const arr = entries.get(id) || [];
        const end = new Date(now());
        const keys = [];
        for (let i = days - 1; i >= 0; i--) keys.push(dayKey(new Date(end.getFullYear(), end.getMonth(), end.getDate() - i).getTime()));
        const byDay = Object.fromEntries(keys.map((k) => [k, 0]));
        const groups = new Map();
        const rules = new Map();
        let total = 0;
        for (const e of arr) {
            const k = dayKey(e.ts);
            if (!(k in byDay)) continue;
            byDay[k]++;
            total++;
            const gk = e.group_id || e.group;
            const g = groups.get(gk) || { id: e.group_id, name: e.group || e.group_id, count: 0 };
            g.count++;
            groups.set(gk, g);
            const rk = e.rule || '—';
            rules.set(rk, (rules.get(rk) || 0) + 1);
        }
        const top = (m) => [...m.values()].sort((a, b) => b.count - a.count).slice(0, 8);
        return {
            days: keys.map((k) => ({ day: k, count: byDay[k] })),
            total,
            groups: top(groups),
            rules: [...rules.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        };
    }

    return { add, recent, countToday, stats, file };
}

module.exports = { createHistoryStore, dayKey };
