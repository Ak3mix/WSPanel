// Límite de respuestas por clave (grupo): como mucho una por ventana de `ms`.
// ms = 0 → desactivado. No retrasa la primera respuesta, solo descarta repeticiones.
class Cooldown {
    constructor(ms = 0, now = Date.now) {
        this.ms = ms;
        this.now = now;
        this.last = new Map();
    }

    setWindow(ms) { this.ms = ms; }

    // true si se puede responder (y reserva el hueco)
    take(key) {
        if (!this.ms) return true;
        const t = this.now();
        const prev = this.last.get(key);
        if (prev !== undefined && t - prev < this.ms) return false;
        this.last.set(key, t);
        if (this.last.size > 5000) this._prune(t);
        return true;
    }

    clear() { this.last.clear(); }

    // devuelve el hueco reservado (p. ej. si el envío falló)
    release(key) { this.last.delete(key); }

    _prune(t) {
        for (const [k, v] of this.last) if (t - v >= this.ms) this.last.delete(k);
    }
}

module.exports = { Cooldown };
