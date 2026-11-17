// Protocolo JSON-lines entre el panel (padre) y el bot (hijo).
// stdout: SOLO líneas JSON. Los logs legibles van a stderr únicamente si es una
// terminal (ejecución manual); cuando el panel lanza el bot, stderr es un pipe y
// no se duplica cada log.
const readline = require('readline');

function createProtocol({ input = process.stdin, output = process.stdout, errStream = process.stderr } = {}) {
    const humanLogs = Boolean(errStream && errStream.isTTY);

    function say(obj) {
        try { output.write(JSON.stringify(obj) + '\n'); } catch { /* pipe cerrado */ }
    }

    function log(tag, msg, data) {
        if (humanLogs) {
            let line = `[${new Date().toISOString()}] [${tag}] ${msg}`;
            if (data !== undefined) line += ' ' + JSON.stringify(data);
            errStream.write(line + '\n');
        }
        say({ type: 'log', tag, msg, data });
    }

    // Lee línea a línea (readline acumula fragmentos: una línea partida en dos
    // chunks ya no se pierde). Cada petición se atiende en paralelo.
    function onRequest(handler) {
        const rl = readline.createInterface({ input, crlfDelay: Infinity });
        rl.on('line', (line) => {
            const s = line.trim();
            if (!s) return;
            let req;
            try { req = JSON.parse(s); } catch {
                log('RPC', 'Invalid JSON line', { line: s.slice(0, 200) });
                return;
            }
            Promise.resolve()
                .then(() => handler(req))
                .catch((e) => log('RPC', 'Request handler error', { error: e.message }));
        });
        return rl;
    }

    return { say, log, onRequest, humanLogs };
}

module.exports = { createProtocol };
