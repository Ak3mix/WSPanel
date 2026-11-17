// WSPanel — estadísticas de una cuenta (pestaña de «Actividad»).
// Una serie por gráfico, en el color de la cuenta, sin leyenda (el título dice
// qué es); tooltip al pasar el ratón y números visibles en las listas.
'use strict';

const shortDay = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return `${'DLMXJVS'[dt.getDay()]} ${dt.getDate()}`;
};
const longDay = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
};

function barChart(days) {
    const max = Math.max(1, ...days.map((d) => d.count));
    const tip = h('div', { class: 'chart-tip', hidden: true });
    const bars = days.map((d, i) => {
        const pct = (d.count / max) * 100;
        const bar = h('div', { class: 'bar-col', tabindex: 0, role: 'img', 'aria-label': `${longDay(d.day)}: ${d.count} respuestas` },
            h('div', { class: 'bar-track' }, h('div', { class: `bar ${d.count ? '' : 'zero'}`, style: `height:${d.count ? Math.max(pct, 3) : 0}%` })),
            h('div', { class: 'bar-x', text: i % 2 === days.length % 2 ? shortDay(d.day) : '' }));
        const show = () => {
            tip.replaceChildren(h('b', { text: String(d.count) }), ` respuesta${d.count === 1 ? '' : 's'} · ${longDay(d.day)}`);
            tip.hidden = false;
            const r = bar.getBoundingClientRect();
            const host = bar.parentElement.getBoundingClientRect();
            const x = r.left - host.left + r.width / 2;
            tip.style.left = `${x}px`;
            // que no se salga por los lados: anclar al borde cerca de los extremos
            tip.style.transform = x > host.width - 110 ? 'translate(-100%, -100%)' : x < 110 ? 'translate(0, -100%)' : '';
        };
        bar.addEventListener('mouseenter', show);
        bar.addEventListener('focus', show);
        bar.addEventListener('mouseleave', () => { tip.hidden = true; });
        bar.addEventListener('blur', () => { tip.hidden = true; });
        return bar;
    });
    return h('div', { class: 'chart' }, h('div', { class: 'chart-max', text: String(max) }), h('div', { class: 'bars' }, ...bars, tip));
}

function rankList(items, total, labelOf) {
    if (!items.length) return h('div', { class: 'muted small', text: 'Sin datos todavía.' });
    const max = Math.max(...items.map((x) => x.count));
    return h('div', { class: 'rank' }, ...items.map((x) => h('div', { class: 'rank-row', title: `${labelOf(x)}: ${x.count}` },
        h('span', { class: 'rank-name', text: labelOf(x) }),
        h('span', { class: 'rank-bar' }, h('span', { style: `width:${(x.count / max) * 100}%` })),
        h('span', { class: 'rank-n', text: `${x.count}${total ? ` · ${Math.round((x.count / total) * 100)}%` : ''}` }))));
}

function statsView(id) {
    const el = h('div', { class: 'stats-view' });
    let loading = false;
    async function load() {
        if (loading) return;
        loading = true;
        try {
            const s = await api.get(`${api.inst(id, 'stats')}?days=14`);
            const week = s.days.slice(-7).reduce((a, d) => a + d.count, 0);
            el.replaceChildren(
                h('div', { class: 'kpis' },
                    h('div', { class: 'stat' }, h('div', { class: 'n', text: String(s.days[s.days.length - 1].count) }), h('div', { class: 'l', text: 'hoy' })),
                    h('div', { class: 'stat' }, h('div', { class: 'n', text: String(week) }), h('div', { class: 'l', text: 'últimos 7 días' })),
                    h('div', { class: 'stat' }, h('div', { class: 'n', text: String(s.total) }), h('div', { class: 'l', text: 'últimos 14 días' }))),
                h('h4', { text: 'Respuestas por día' }),
                barChart(s.days),
                h('h4', { text: 'Grupos con más respuestas' }),
                rankList(s.groups, s.total, (g) => g.name || g.id || '?'),
                ...(s.rules.length > 1 ? [h('h4', { text: 'Por regla' }), rankList(s.rules, s.total, (r) => r.name)] : []),
                h('p', { class: 'muted small', text: 'Se guardan los últimos 90 días en la carpeta history/ del panel.' }));
        } catch (e) {
            el.replaceChildren(h('div', { class: 'msg bad' }, e.message));
        } finally { loading = false; }
    }
    return { el, load };
}
