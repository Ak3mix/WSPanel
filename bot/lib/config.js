// Carga, validación y hot-reload de config-<id>.yaml.
// Si el YAML no se puede leer o parsear (p. ej. se está escribiendo), se conserva
// la última configuración buena: nunca se cae a {} (que abriría todas las listas).
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULT_REPLY = 'Yo, estoy al tanto.';

const DEFAULTS = Object.freeze({
    debug: false, // loguear cada mensaje recibido (texto incluido)
    // Reglas en orden: gana la primera que casa. Cada una:
    //   name (opcional), keywords, exclude (opcional), replies (1 o varias: se elige una),
    //   groups (opcional: limita la regla a esos grupos; vacío = los permitidos de la cuenta)
    rules: [],
    allowed_groups: [],
    allowed_users: [],
    // Horario opcional: días (0 = domingo … 6 = sábado) y tramo HH:MM. Vacío = siempre.
    schedule: { days: [], from: '', to: '' },
    reply_delay_ms: 1500,
    cooldown_ms: 0, // 0 = sin límite; >0 = máx. 1 respuesta en esa ventana…
    cooldown_scope: 'group', // …por grupo ('group') o en total, entre todos los grupos ('global')
    headless: true,
    chrome_path: '',
    suppress_mobile_notifications: false, // true = NO marcar presencia "unavailable"
});

const strList = (v) =>
    Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))] : [];

const nonNegInt = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
};

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const hhmm = (v) => {
    const t = String(v ?? '').trim();
    if (!HHMM.test(t)) return '';
    const [h, m] = t.split(':');
    return `${h.padStart(2, '0')}:${m}`;
};

function normalizeSchedule(s) {
    const o = s && typeof s === 'object' ? s : {};
    const days = Array.isArray(o.days)
        ? [...new Set(o.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
        : [];
    return { days: days.length === 7 ? [] : days, from: hhmm(o.from), to: hhmm(o.to) };
}

function normalizeRule(r) {
    const o = r && typeof r === 'object' ? r : {};
    const replies = Array.isArray(o.replies)
        ? o.replies.map((x) => String(x ?? '').trim()).filter(Boolean)
        : typeof o.reply === 'string' && o.reply.trim() ? [o.reply.trim()] : [];
    return {
        name: typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '',
        keywords: strList(o.keywords),
        exclude: strList(o.exclude),
        replies: [...new Set(replies)].length ? [...new Set(replies)] : [DEFAULT_REPLY],
        groups: strList(o.groups).filter((g) => g.endsWith('@g.us')),
    };
}

function normalizeConfig(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    // Formato antiguo (keywords + auto_reply) → una sola regla
    let rules;
    if (Array.isArray(r.rules)) {
        rules = r.rules.map(normalizeRule);
    } else {
        const kws = strList(r.keywords);
        const reply = typeof r.auto_reply === 'string' && r.auto_reply.trim() ? r.auto_reply.trim() : DEFAULT_REPLY;
        rules = kws.length ? [normalizeRule({ keywords: kws, replies: [reply] })] : [];
    }
    const { keywords, auto_reply, ...rest } = r; // las claves antiguas no se arrastran
    return {
        ...rest, // conservar claves desconocidas (no se pierden al guardar desde el panel)
        debug: r.debug === true,
        rules,
        allowed_groups: strList(r.allowed_groups),
        allowed_users: strList(r.allowed_users),
        schedule: normalizeSchedule(r.schedule),
        reply_delay_ms: nonNegInt(r.reply_delay_ms, DEFAULTS.reply_delay_ms),
        cooldown_ms: nonNegInt(r.cooldown_ms, DEFAULTS.cooldown_ms),
        cooldown_scope: r.cooldown_scope === 'global' ? 'global' : 'group',
        headless: r.headless !== false,
        chrome_path: typeof r.chrome_path === 'string' ? r.chrome_path.trim() : '',
        suppress_mobile_notifications: r.suppress_mobile_notifications === true,
    };
}

function parseConfig(text) {
    const data = yaml.load(text);
    if (data != null && (typeof data !== 'object' || Array.isArray(data))) {
        throw new Error('el YAML no es un objeto');
    }
    return normalizeConfig(data || {});
}

function loadConfigFile(file) {
    return parseConfig(fs.readFileSync(file, 'utf8'));
}

// Vigila el DIRECTORIO (sobrevive a editores que guardan con rename atómico) con
// debounce; solo notifica si el contenido cambió de verdad y es válido.
function watchConfig(file, { onChange, onError, debounceMs = 300 } = {}) {
    const dir = path.dirname(file);
    const base = path.basename(file);
    let lastText = null;
    try { lastText = fs.readFileSync(file, 'utf8'); } catch { /* aún no existe */ }
    let timer = null;

    const check = () => {
        timer = null;
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
            if (onError) onError(e);
            return;
        }
        if (text === lastText) return;
        let cfg;
        try { cfg = parseConfig(text); } catch (e) {
            if (onError) onError(e);
            return; // no actualizamos lastText: reintentará en el próximo evento
        }
        lastText = text;
        onChange(cfg);
    };

    const watcher = fs.watch(dir, (event, name) => {
        if (name && name !== base) return;
        clearTimeout(timer);
        timer = setTimeout(check, debounceMs);
    });
    return {
        close() { clearTimeout(timer); watcher.close(); },
    };
}

function diffConfig(a, b) {
    const diff = {};
    for (const k of Object.keys({ ...a, ...b })) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diff[k] = { from: a[k], to: b[k] };
    }
    return diff;
}

module.exports = { DEFAULTS, DEFAULT_REPLY, normalizeRule, normalizeSchedule, normalizeConfig, parseConfig, loadConfigFile, watchConfig, diffConfig };
