// Lectura/escritura de config-<id>.yaml. Valida con el mismo código que el bot
// (bot/lib/config.js) y escribe de forma atómica (tmp + rename) para que el
// hot-reload del bot nunca lea un archivo a medias.
const fs = require('fs');
const path = require('path');

function createConfigStore({ dataDir, botDir }) {
    const { normalizeConfig, parseConfig } = require(path.join(botDir, 'lib', 'config.js'));
    const yaml = require(require.resolve('js-yaml', { paths: [botDir] }));
    const file = (id) => path.join(dataDir, `config-${id}.yaml`);

    function writeAtomic(target, text) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, target);
    }

    return {
        file,
        // Crea la plantilla si no existe y devuelve la config normalizada.
        // Si el YAML existe pero está roto, lanza (no se sobrescribe a ciegas).
        load(id) {
            const f = file(id);
            if (!fs.existsSync(f)) {
                const cfg = normalizeConfig({});
                writeAtomic(f, yaml.dump(cfg));
                return cfg;
            }
            return parseConfig(fs.readFileSync(f, 'utf8'));
        },
        save(id, cfg) {
            const clean = normalizeConfig(cfg);
            writeAtomic(file(id), yaml.dump(clean));
            return clean;
        },
        // Modifica solo lo indicado partiendo de lo que hay en disco (evita pisar
        // cambios hechos fuera del panel con una copia vieja).
        update(id, fn) {
            const current = this.load(id);
            return this.save(id, fn({ ...current }) || current);
        },
    };
}

module.exports = { createConfigStore };
