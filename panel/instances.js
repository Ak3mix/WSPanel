// InstanceManager: arranca/detiene las instancias del bot (un proceso hijo cada
// una), habla con ellas por JSON-lines y las reinicia solas si se caen.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const EventEmitter = require('events');

const INSTANCES = Object.freeze([
    Object.freeze({ id: 'personal', name: 'Personal' }),
    Object.freeze({ id: 'trabajo', name: 'Trabajo' }),
]);

// Debe coincidir con EXIT de bot/lib/bot-core.js
const EXIT_STATUS = { 4: 'logged_out', 5: 'auth_failure', 78: 'config_error', 79: 'browser_missing' }; // no se reintentan

const RPC_TIMEOUTS = { FETCH_CONTACTS: 120000, FETCH_GROUPS: 90000, LOGOUT: 30000, SEND_MESSAGE: 60000 }; // el bot espera la confirmación hasta 45 s

class InstanceManager extends EventEmitter {
    constructor({
        instances = INSTANCES,
        botDir,
        dataDir,
        sessionsDir = path.join(dataDir, 'sessions'),
        runtime = process.execPath,
        extraArgs = [],
        env = {},
        autoRestart = true,
        backoffMs = [2000, 5000, 15000, 30000, 60000],
        stableMs = 120000,
        killTimeoutMs = 8000,
        rpcTimeoutMs = 30000,
    }) {
        super();
        Object.assign(this, { botDir, dataDir, sessionsDir, runtime, extraArgs, env, autoRestart, backoffMs, stableMs, killTimeoutMs, rpcTimeoutMs });
        this.defs = instances;
        this.state = new Map(instances.map((d) => [d.id, {
            def: d, proc: null, status: 'stopped', paused: false,
            attempts: 0, restartTimer: null, startedAt: 0,
        }]));
        this.pending = new Map();
    }

    _get(id) {
        const s = this.state.get(id);
        if (!s) throw new Error('instancia desconocida: ' + id);
        return s;
    }

    _setStatus(id, value, extra = {}) {
        const s = this._get(id);
        s.status = value;
        this.emit('event', id, { type: 'status', value, ...extra });
    }

    // Estado puesto desde fuera (p. ej. el panel detecta que falta el navegador)
    markStatus(id, value, extra) {
        if (this._get(id).proc) return;
        this._setStatus(id, value, extra);
    }

    getStatus(id) { return this._get(id).status; }
    isPaused(id) { return this._get(id).paused; }
    isRunning(id) { return Boolean(this._get(id).proc); }

    statusAll() {
        const out = {};
        for (const [id, s] of this.state) out[id] = { name: s.def.name, status: s.status, paused: s.paused, running: Boolean(s.proc) };
        return out;
    }

    start(id) {
        const s = this._get(id);
        clearTimeout(s.restartTimer);
        s.restartTimer = null;
        if (s.proc) return;
        this._spawn(id);
    }

    _spawn(id) {
        const s = this._get(id);
        fs.mkdirSync(this.sessionsDir, { recursive: true });
        const args = [
            path.join(this.botDir, 'bot.js'),
            '--client-id', id,
            '--config', path.join(this.dataDir, `config-${id}.yaml`),
            '--user-data-dir', path.join(this.sessionsDir, id),
            ...(s.paused ? ['--paused'] : []),
            ...this.extraArgs,
        ];
        // Bajo Electron, el propio binario hace de Node (sin depender de `node` en el PATH)
        const env = { ...process.env, ...this.env };
        if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

        const cp = spawn(this.runtime, args, { cwd: this.botDir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const proc = { cp, stopRequested: false, exited: false };
        s.proc = proc;
        s.startedAt = Date.now();
        this._setStatus(id, 'starting');

        cp.stdin.on('error', () => { /* EPIPE: el hijo ya murió; lo gestiona 'exit' */ });
        readline.createInterface({ input: cp.stdout, crlfDelay: Infinity }).on('line', (line) => this._onLine(id, line));
        readline.createInterface({ input: cp.stderr, crlfDelay: Infinity }).on('line', (line) => {
            if (line.trim()) this.emit('event', id, { type: 'log', tag: 'STDERR', msg: line.slice(0, 1000) });
        });

        let finished = false;
        const finish = (code, signal, error) => {
            if (finished) return;
            finished = true;
            proc.exited = true;
            this._onExit(id, proc, code, signal, error);
        };
        cp.on('error', (e) => finish(null, null, e)); // p. ej. ejecutable no encontrado
        cp.on('exit', (code, signal) => finish(code, signal));
    }

    _onLine(id, line) {
        if (!line.trim()) return;
        let ev;
        try { ev = JSON.parse(line); } catch {
            this.emit('event', id, { type: 'log', tag: 'RAW', msg: line.slice(0, 500) });
            return;
        }
        const s = this._get(id);
        if (ev.type === 'rpc_result') {
            const p = this.pending.get(ev.id);
            if (!p) return;
            this.pending.delete(ev.id);
            clearTimeout(p.timer);
            if (ev.ok) p.resolve(ev.data);
            else p.reject(new Error(ev.error || 'rpc failed'));
            return;
        }
        if (ev.type === 'status') {
            s.status = ev.value;
            if (ev.value === 'ready') s.readyAt = Date.now();
        } else if (ev.type === 'paused') {
            s.paused = Boolean(ev.value);
        }
        this.emit('event', id, ev);
    }

    _onExit(id, proc, code, signal, error) {
        const s = this._get(id);
        if (s.proc === proc) s.proc = null;
        for (const [rid, p] of this.pending) {
            if (p.proc !== proc) continue;
            this.pending.delete(rid);
            clearTimeout(p.timer);
            p.reject(new Error('la instancia terminó'));
        }
        if (error) this.emit('event', id, { type: 'log', tag: 'ERROR', msg: 'No se pudo lanzar el bot', data: { error: error.message } });

        if (proc.stopRequested) {
            s.attempts = 0;
            this._setStatus(id, s.status === 'logged_out' ? 'logged_out' : 'stopped');
            return;
        }
        const terminal = EXIT_STATUS[code];
        if (terminal) {
            s.attempts = 0;
            this._setStatus(id, terminal, { code });
            return;
        }
        // caída inesperada → reintento con espera creciente
        if (Date.now() - s.startedAt > this.stableMs) s.attempts = 0;
        const delay = this.autoRestart && !error
            ? this.backoffMs[Math.min(s.attempts, this.backoffMs.length - 1)]
            : null;
        this._setStatus(id, 'crashed', { code, signal, retryInMs: delay });
        if (delay != null) {
            s.attempts++;
            s.restartTimer = setTimeout(() => { s.restartTimer = null; if (!s.proc) this._spawn(id); }, delay);
        }
    }

    // Promesa que se resuelve cuando ESTE proceso ha terminado. El kill forzado
    // va atado a este proceso concreto: nunca mata a uno arrancado después.
    stop(id) {
        const s = this._get(id);
        clearTimeout(s.restartTimer);
        s.restartTimer = null;
        const proc = s.proc;
        if (!proc) {
            if (s.status === 'crashed') this._setStatus(id, 'stopped');
            return Promise.resolve();
        }
        proc.stopRequested = true;
        return new Promise((resolve) => {
            const { cp } = proc;
            if (proc.exited) return resolve();
            cp.once('exit', () => { clearTimeout(killer); resolve(); });
            cp.once('error', () => { clearTimeout(killer); resolve(); });
            const killer = setTimeout(() => { if (!proc.exited) cp.kill('SIGKILL'); }, this.killTimeoutMs);
            try { cp.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n'); } catch { cp.kill(); }
        });
    }

    async restart(id) {
        await this.stop(id);
        this.start(id);
    }

    stopAll() {
        return Promise.all(this.defs.map((d) => this.stop(d.id)));
    }

    // La pausa se recuerda aunque la instancia esté parada y se aplica al arrancar.
    async setPaused(id, value) {
        const s = this._get(id);
        s.paused = Boolean(value);
        if (s.proc) await this.sendRpc(id, 'SET_PAUSED', { value: s.paused });
        else this.emit('event', id, { type: 'paused', value: s.paused });
        return s.paused;
    }

    sendRpc(id, cmd, extra = {}, timeoutMs) {
        return new Promise((resolve, reject) => {
            const s = this._get(id);
            const proc = s.proc;
            if (!proc || !proc.cp.stdin.writable) return reject(new Error('la instancia no está en marcha'));
            const rid = crypto.randomUUID();
            const ms = timeoutMs || RPC_TIMEOUTS[cmd] || this.rpcTimeoutMs;
            const timer = setTimeout(() => {
                this.pending.delete(rid);
                reject(new Error(`rpc timeout (${cmd})`));
            }, ms);
            this.pending.set(rid, { resolve, reject, timer, proc });
            proc.cp.stdin.write(JSON.stringify({ type: 'rpc', id: rid, cmd, ...extra }) + '\n', (err) => {
                if (!err) return;
                const p = this.pending.get(rid);
                if (!p) return;
                this.pending.delete(rid);
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    // Solo para --fake: simula un mensaje entrante
    injectFakeMessage(id, msg) {
        const proc = this._get(id).proc;
        if (proc) proc.cp.stdin.write(JSON.stringify({ type: 'fake_message', ...msg }) + '\n');
    }
}

module.exports = { InstanceManager, INSTANCES };
