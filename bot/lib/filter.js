// Lógica pura de decisión: normalización de texto, reglas, exclusiones y horario.
// Sin dependencias de WhatsApp → la usan el bot y el probador del panel, así
// el probador da exactamente la misma respuesta que daría el bot.

// minúsculas + sin acentos + espacios colapsados ("Aeropuérto  T1" → "aeropuerto t1")
function normalizeText(s) {
    return String(s ?? '')
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Cada palabra/frase debe aparecer completa:
// "terminal 1" casa con "voy a la terminal 1." pero NO con "terminal 10".
function compileKeywords(list) {
    return (list || [])
        .map((kw) => normalizeText(kw))
        .filter(Boolean)
        .map((kw) => ({
            kw,
            re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(kw).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'u'),
        }));
}

// devuelve la palabra que casó o null
function matchKeyword(normalizedText, compiled) {
    for (const k of compiled) if (k.re.test(normalizedText)) return k.kw;
    return null;
}

// ---------- horario ----------

const toMinutes = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h < 24 && min < 60 ? h * 60 + min : null;
};

// schedule = { days: [0..6] (0 = domingo), from: 'HH:MM', to: 'HH:MM' }
// Todo vacío = siempre. Admite tramos que cruzan medianoche (22:00 → 06:00):
// en ese caso el día que cuenta es el de inicio del tramo.
function inSchedule(schedule, date = new Date()) {
    if (!schedule) return true;
    const days = schedule.days || [];
    const from = toMinutes(schedule.from);
    const to = toMinutes(schedule.to);
    const day = date.getDay();
    const now = date.getHours() * 60 + date.getMinutes();
    const dayOk = (d) => !days.length || days.includes(d);
    if (from == null && to == null) return dayOk(day);
    const f = from ?? 0;
    const t = to ?? 24 * 60;
    if (f === t) return dayOk(day); // mismo inicio y fin = todo el día
    if (f < t) return dayOk(day) && now >= f && now < t;
    // cruza medianoche: [f, 24h) del día d, o [0, t) del día siguiente a d
    if (now >= f) return dayOk(day);
    return now < t && dayOk((day + 6) % 7);
}

function hasSchedule(schedule) {
    return Boolean(schedule && ((schedule.days && schedule.days.length) || schedule.from || schedule.to));
}

// ---------- reglas ----------

// Config normalizada → estructura lista para decidir (Sets → O(1)). null = "todos".
function compileConfig(cfg) {
    const set = (arr) => (arr && arr.length ? new Set(arr) : null);
    return {
        groups: set(cfg.allowed_groups),
        users: set(cfg.allowed_users),
        schedule: hasSchedule(cfg.schedule) ? cfg.schedule : null,
        rules: (cfg.rules || []).map((r, index) => ({
            index,
            name: r.name || '',
            keywords: compileKeywords(r.keywords),
            exclude: compileKeywords(r.exclude),
            replies: r.replies || [],
            groups: set(r.groups),
        })),
    };
}

// Primera regla (en orden) que casa con el texto en ese grupo y no está excluida.
// Devuelve { rule, keyword } o { rule: null, excluded: [{ rule, keyword, by }] }.
function findRule(compiled, groupId, normalizedText) {
    const excluded = [];
    for (const r of compiled.rules) {
        if (r.groups && !r.groups.has(groupId)) continue;
        const keyword = matchKeyword(normalizedText, r.keywords);
        if (!keyword) continue;
        const by = matchKeyword(normalizedText, r.exclude);
        if (by) { excluded.push({ rule: r, keyword, by }); continue; }
        return { rule: r, keyword, excluded };
    }
    return { rule: null, excluded };
}

// Elige una respuesta; con varias, evita repetir la última usada en ese grupo.
function pickReply(rule, lastReply, random = Math.random) {
    const opts = rule.replies.length ? rule.replies : ['Yo, estoy al tanto.'];
    if (opts.length === 1) return opts[0];
    const pool = opts.filter((o) => o !== lastReply);
    return pool[Math.floor(random() * pool.length)];
}

// Decisión completa y síncrona (la usa el probador del panel; el bot sigue el
// mismo orden pero resuelve el remitente @lid de forma asíncrona).
function evaluate(compiled, { groupId, user, text, date = new Date(), paused = false }) {
    if (!String(groupId || '').endsWith('@g.us')) return { ok: false, reason: 'not_group' };
    if (compiled.groups && !compiled.groups.has(groupId)) return { ok: false, reason: 'group' };
    const m = findRule(compiled, groupId, normalizeText(text));
    if (!m.rule) return { ok: false, reason: m.excluded.length ? 'excluded' : 'no_keyword', excluded: m.excluded };
    const base = { rule: m.rule.index, ruleName: m.rule.name, keyword: m.keyword };
    if (compiled.users && !compiled.users.has(user)) return { ok: false, reason: 'user', ...base };
    if (compiled.schedule && !inSchedule(compiled.schedule, date)) return { ok: false, reason: 'schedule', ...base };
    if (paused) return { ok: false, reason: 'paused', ...base };
    return { ok: true, ...base, replies: m.rule.replies };
}

// compatibilidad con el nombre anterior
const buildRules = compileConfig;

module.exports = {
    normalizeText, compileKeywords, matchKeyword, compileConfig, buildRules,
    findRule, pickReply, inSchedule, hasSchedule, evaluate, toMinutes,
};
