// Pide por terminal la ruta del navegador hasta que sea válida o el usuario cancele.
const readline = require('readline');

function askBrowserPath({ input = process.stdin, output = process.stdout, setBrowserPath, hint, detected = [] }) {
    const rl = readline.createInterface({ input, output, terminal: Boolean(output.isTTY) });
    const say = (s) => output.write(s + '\n');

    say('');
    say('⚠️  No se encontró ningún navegador compatible (Chrome, Chromium, Edge o Brave).');
    say('   ' + hint);
    if (detected.length) {
        say('   Encontrados pero no utilizables por la configuración actual:');
        for (const b of detected) say(`     - ${b.name}: ${b.path}`);
    }
    say('');

    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            rl.close();
            resolve(v);
        };
        rl.on('close', () => finish(null)); // Ctrl+C / Ctrl+D / fin de la entrada
        const ask = () => rl.question('Ruta del ejecutable del navegador (Enter para salir): ', (answer) => {
            const p = answer.trim();
            if (!p) return finish(null);
            const r = setBrowserPath(p);
            if (r.ok) {
                say(`✅ Usaré ${r.name}${r.version ? ` (${r.version})` : ''}: ${r.path}`);
                return finish(r.path);
            }
            say(`❌ ${r.error}. Prueba otra vez.`);
            ask();
        });
        ask();
    });
}

module.exports = { askBrowserPath };
