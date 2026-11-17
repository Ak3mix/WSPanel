# WSPanel

Panel de escritorio para **responder automáticamente en grupos de WhatsApp** cuando
alguien escribe ciertas palabras, con **dos cuentas** a la vez (Personal y Trabajo),
reglas, horario, estadísticas y control por **Telegram**.

- Varias reglas por cuenta: palabras clave, excepciones, una o varias respuestas y grupos.
- Solo en los grupos y para las personas que elijas; horario opcional.
- Probador de reglas: te dice si el bot respondería a un mensaje y por qué.
- Actividad en forma de conversación, estadísticas e historial.
- Avisos y comandos por Telegram (`/status`, `/pause`, `/resume`).
- Usa el Chrome, Chromium, Edge o Brave que ya tengas; no incluye navegador.

> ⚠️ Proyecto no oficial, sin relación con WhatsApp ni Meta. Automatizar una cuenta
> puede ir contra sus condiciones de uso y acabar en un bloqueo. Úsalo bajo tu
> responsabilidad, con mesura (límite por grupo, horario) y en cuentas propias.

## Descargar y usar

1. Descarga la última versión desde **[Releases](../../releases/latest)**:
   - Windows: `WSPanel-…-windows-x64.zip`
   - Linux: `WSPanel-…-linux-x64.tar.gz`
2. Descomprímela donde quieras.
3. Abre **`WSPanel.vbs`** (Windows) o **`./wspanel`** (Linux).
4. Se abre el panel. Pulsa **Conectar** en una cuenta y escanea el QR con WhatsApp: *Ajustes → Dispositivos vinculados*.

Necesitas **Chrome, Chromium, Edge o Brave** instalado. En Windows 10/11 vale el Edge que ya viene. Si no encuentra ninguno, el panel te deja indicar dónde está.

**Tus datos** se guardan en la carpeta `data/` del paquete: configuración, sesiones de WhatsApp, historial y Telegram. **No la compartas.** Para actualizar, descarga la versión nueva y copia dentro tu carpeta `data/`.

En Windows, la primera vez puede aparecer «Windows protegió su PC», porque la aplicación no está firmada. Pulsa *Más información → Ejecutar de todas formas*.

## Desarrollo

```bash
git clone <este repo> && cd WSPanel
cd bot && PUPPETEER_SKIP_DOWNLOAD=1 npm ci   # instala y aplica el parche de whatsapp-web.js
cd ../panel && node app.js                    # el panel usa las dependencias del bot
```

- **Tests:** `npm test` en `bot/` y en `panel/`. Se ejecutan en GitHub Actions (Linux y Windows) con cada push.
- **Paquete portable local:**
  ```bash
  node scripts/package.js --version 1.2.3
  ```
  Necesita el Node oficial de nodejs.org; el de algunas distribuciones no sirve y el script lo avisa.
- **Publicar una versión:**
  ```bash
  git tag v1.2.3 && git push origin v1.2.3
  ```
  Actions pasa los tests, crea los paquetes de Windows y Linux y los publica en Releases con sus sumas SHA-256.

## Estructura

```
WSPanel/
├── bot/                     proceso hijo, uno por cuenta (whatsapp-web.js 1.34.7)
│   ├── bot.js               punto de entrada (argumentos, cliente real o --fake)
│   ├── lib/
│   │   ├── bot-core.js      eventos, filtrado, auto-respuesta, RPC, códigos de salida
│   │   ├── filter.js        decisión pura: reglas, exclusiones, horario (bot y probador)
│   │   ├── lid.js           resolución @lid ↔ @c.us con caché persistente y negativa
│   │   ├── config.js        validación y hot-reload de la configuración
│   │   ├── browser.js       detección de Chrome, Chromium, Edge y Brave
│   │   ├── cooldown.js      límite de respuestas por grupo
│   │   ├── protocol.js      JSON-lines por stdin/stdout
│   │   └── fake-client.js   WhatsApp simulado para tests
│   ├── patches/             parche de whatsapp-web.js (patch-package)
│   └── test/
├── panel/                   panel (Node puro, sin dependencias propias)
│   ├── panel-core.js        une instancias + config + Telegram + historial
│   ├── instances.js         InstanceManager: spawn, RPC, reinicio automático
│   ├── config-store.js      lectura/escritura atómica de config-<id>.yaml
│   ├── telegram.js          envío + long polling
│   ├── notifier.js          eventos → Telegram, comandos /status /pause /resume
│   ├── app.js               ★ arranque normal: API + interfaz en una ventana del navegador
│   ├── server.js            API local (REST + eventos SSE) y archivos de la UI
│   ├── history-store.js     historial de respuestas en disco y estadísticas
│   ├── desktop.js           acceso directo, arranque con el sistema, instancia única
│   ├── qr-svg.js            QR → SVG (con el codificador de qrcode-terminal)
│   ├── ui/                  interfaz web (HTML/CSS/JS sin dependencias)
│   ├── headless.js          ejecutar sin interfaz
│   ├── browser-prompt.js    pide la ruta del navegador si no hay ninguno
│   └── test/
├── scripts/package.js       crea el paquete portable (lo usa GitHub Actions)
├── .github/workflows/       tests (ci.yml) y versiones (release.yml)
│
│   — en desarrollo, junto al repo (no se suben a git):
├── config-personal.yaml, config-trabajo.yaml, panel-config.yaml
├── sessions/                sesiones de WhatsApp
└── history/                 historial de respuestas
```

## Navegador

No se incluye ningún navegador: se usa el que ya tenga el equipo. El bot y el
panel buscan, en este orden:

1. `chrome_path` en el YAML de la instancia.
2. La ruta elegida en el panel (`browser_path` en `panel-config.yaml`) o la variable `CHROME_PATH`.
3. **Chrome → Chromium → Edge → Brave**, en las rutas habituales:
   - **Windows:** `Program Files`, `Program Files (x86)`, `AppData\Local` y el registro (`App Paths`), así que también encuentra instalaciones en otras carpetas. Edge viene con Windows 10/11.
   - **Linux:** el `PATH` (`google-chrome`, `chromium`, `microsoft-edge`, `brave-browser`…) y `/opt`, `/usr/bin`, `/snap/bin`.
   - **macOS:** `/Applications` y `~/Applications`.
4. El Chrome descargado con `npx @puppeteer/browsers install chrome@stable`.

Si no encuentra ninguno, **lo pide**: `headless.js` pregunta la ruta por la terminal,
comprueba que sea un Chromium y la recuerda. También se puede pasar con
`--browser <ruta>`. Si una instancia arranca sin navegador, su estado pasa a
`browser_missing`.

Cada bot usa su propio perfil (`sessions/<id>`), así que no toca el perfil
personal del navegador.

El Chromium de Ubuntu es una versión snap y no puede escribir en discos externos
(`/run/media/...`). El panel avisa de ello; la solución es
`sudo snap connect chromium:removable-media`.

## Uso

### Panel (lo normal)

```bash
cd panel
node app.js                   # abre el panel y reconecta las cuentas que estaban conectadas
node app.js --start           # además conecta todas las cuentas
node app.js --no-autostart    # no reconectar las cuentas recordadas
node app.js --fake            # WhatsApp simulado, para probar la interfaz
node app.js --no-open         # no abrir ventana (así arranca con el sistema)
```

- **Ventana:** se abre con el navegador detectado, en modo aplicación y con un perfil propio (`sessions/_panel-ui`). Cerrarla **no** detiene los bots: se cierra desde Ajustes → «Cerrar WSPanel» o con Ctrl+C.
- **Instancia única:** si el panel ya está en marcha, lanzarlo otra vez solo abre su ventana.
- **Recuerda cada cuenta:** si estaba conectada (vuelve a conectarse al abrir) y si estaba en pausa. Desconectarla o cerrar sesión a mano hace que no se reconecte.
- **Desde Ajustes → Escritorio:**
  - acceso directo en el menú de aplicaciones;
  - arranque con el sistema, en segundo plano y sin ventana.
  
  En Linux usa archivos `.desktop`; en Windows, scripts `.vbs` sin consola.

La interfaz:
- **Las dos cuentas lado a lado** (en el móvil, una cada vez con un selector arriba). Cada una tiene un interruptor grande de auto-respuesta, el QR cuando hace falta y sus contadores. Indica «Fuera de horario» cuando corresponde.
- **Reglas resumidas** en la tarjeta. El editor (panel lateral) permite varias reglas con palabras clave, excepciones opcionales, una o varias respuestas y grupos opcionales; además, «Dónde y a quién», horario opcional, tiempos y opciones.
- **🧪 Probar:** escribes un mensaje de ejemplo (grupo, persona y, si quieres, fecha y hora) y te dice si el bot respondería y por qué no. Usa la misma lógica que el bot y no envía nada.
- **Actividad:**
  - *Respuestas:* conversación con el mensaje que la provocó, la palabra resaltada y la regla usada.
  - *Registro:* el registro técnico.
  - *Estadísticas:* por día, por grupo y por regla.
- **Historial en disco** (`history/<cuenta>.jsonl`, últimos 90 días): las respuestas, el contador de «hoy» y las estadísticas sobreviven a los reinicios. Incluye el texto de los mensajes que dispararon respuesta (solo esos).
- **Avisos del sistema** opcionales cuando el bot responde y la ventana no está a la vista.
- **Paneles laterales** para enviar mensajes y para los ajustes: navegador, Telegram, avisos y escritorio.

### Sin interfaz

```bash
cd panel
node headless.js              # ambas cuentas; el QR sale en la terminal
node headless.js personal     # solo una
node headless.js --fake       # WhatsApp simulado (sin navegador)
node headless.js --browser /ruta/al/navegador   # elegir navegador (se recuerda)
node headless.js --api        # además, API local + interfaz web (puerto 47800, --port N)
node headless.js --verbose    # incluye logs de mensajes y filtros
```

También se puede lanzar el bot solo:

```bash
cd bot
node bot.js --client-id personal --config ../config-personal.yaml --user-data-dir ../sessions/personal
```

## Configuración (`config-<id>.yaml`)

Lo normal es editarla desde el panel. El formato:

```yaml
rules:                         # se comprueban en orden: responde la primera que encaja
  - name: Terminal 1           # opcional
    keywords: [terminal 1, t1] # palabras o frases completas, sin mayúsculas ni acentos
    exclude: [no voy]          # opcional: si aparece alguna, esta regla no responde
    replies:                   # una o varias; con varias se elige una al azar (sin repetir la última)
      - Voy para la T1
      - Salgo ya hacia la T1
    groups: []                 # opcional: solo en estos grupos (vacío = los permitidos de la cuenta)
allowed_groups: [120363…@g.us] # vacío = cualquier grupo
allowed_users: [34600…@c.us]   # vacío = cualquier persona (los @lid se resuelven solos)
schedule:                      # opcional; vacío = siempre
  days: [1, 2, 3, 4, 5]        # 0 = domingo … 6 = sábado; vacío = todos
  from: '08:00'                # admite tramos que cruzan medianoche (22:00 → 06:00)
  to: '18:00'
reply_delay_ms: 1500           # espera antes de responder (0 = al instante)
cooldown_ms: 0                 # máx. 1 respuesta por grupo en esa ventana (0 = sin límite)
debug: false                   # registrar cada mensaje recibido, texto incluido
headless: true                 # navegador sin ventana
chrome_path: ''                # navegador solo para esta cuenta (vacío = el del panel)
suppress_mobile_notifications: false   # true = el móvil deja de recibir avisos
```

**Formato antiguo:** `keywords` + `auto_reply` se convierte solo en una regla, así que los YAML anteriores siguen funcionando. Al guardar desde el panel se escribe ya en el formato nuevo.

**Hot-reload:** los cambios se aplican en caliente. Si el YAML queda inválido, el bot conserva la configuración anterior.

## Telegram (`panel-config.yaml`)

```yaml
telegram:
  token: "123456:ABC…"
  chatId: "-100…"
  allowed_user_ids: [123456789]   # opcional; vacío = cualquier miembro del grupo
```

Comandos: `/status`, `/pause personal|trabajo|todos`, `/resume …` y `/help`.
También funcionan con el sufijo `@NombreDelBot`. Si alguien no autorizado escribe
un comando, el bot le contesta con su id de Telegram para que puedas añadirlo.

Avisos:
- **Respuestas:** la primera respuesta en un grupo se avisa al momento, junto al mensaje que la provocó. Las siguientes del mismo minuto se agrupan en un resumen.
- **Cambios de estado** (conectada, desconectada, sesión cerrada…), sin repetirse.
- **Caídas:** se avisan las 3 primeras seguidas; luego calla hasta que la cuenta vuelve («recuperada tras caerse»).
- **Pausas:** cambiar la pausa desde el panel se avisa. Con `/pause` no llega un aviso aparte: la respuesta al comando ya lo dice.

Fiabilidad:
- **Cola de envío:** respeta los límites de Telegram (unos 20 mensajes por minuto en grupos). Ante un error 429 espera lo que pide Telegram y reintenta. Si se acumulan más de 60 avisos, descarta los más antiguos y lo indica en el siguiente («N avisos omitidos»).
- **Comandos antiguos:** al arrancar se descartan los que llegaron con el panel apagado. Al cambiar de bot se empieza de cero.
- **Webhook:** si el bot tenía uno activo, se quita automáticamente, porque impide leer los comandos.
- **Errores visibles en Ajustes:** token incorrecto, bot fuera del grupo, otro programa leyendo el mismo bot (por ejemplo, el panel abierto dos veces)…

## Grupos y contactos

- **«Personas»** (en las reglas y al enviar) muestra solo los **contactos guardados en la agenda** de la cuenta, no los participantes de los grupos.
- **Listas ligeras:** se leen solo el id y el nombre directamente en WhatsApp Web, en vez de serializar cada chat o contacto completo.
- **Pensado para cuentas grandes:**
  - como mucho 5000 grupos y 20 000 contactos (se avisa si la lista se recorta; el buscador sigue funcionando);
  - tiempo máximo de 60 s por consulta;
  - una sola consulta a la vez;
  - caché de 60 s («↻ Actualizar» la fuerza).
- **Si WhatsApp Web cambia** y la lectura ligera falla, se usa la API estándar de whatsapp-web.js, también filtrada y limitada.

## API local (`--api`)

Al arrancar con `--api` se imprime un enlace `http://127.0.0.1:47800/login?token=…`.
Al abrirlo se guarda el token en una cookie y entras al panel. Si el puerto está
ocupado, se usa otro libre.

Seguridad:
- Solo escucha en `127.0.0.1`.
- El token es aleatorio y cambia en cada arranque. Se usa con la cookie o con la cabecera `Authorization: Bearer …`.
- Comprueba las cabeceras `Host` y `Origin`.
- Las peticiones que cambian algo deben llevar la cabecera `X-WSPanel: 1`.

| método | ruta | qué hace |
|---|---|---|
| GET | `/api/state` | estado de todo: instancias (estado, pausa, QR actual, navegador), Telegram y navegador |
| GET | `/api/events` | eventos en vivo (SSE): `snapshot` al conectar y luego `bot` con `{ id, ev }` |
| GET | `/api/instances/:id/history?limit=N` | últimos logs y notificaciones (hasta 1000) |
| POST | `/api/instances/:id/start` · `stop` · `restart` · `logout` | controlar la instancia |
| POST | `/api/instances/:id/pause` | `{ "paused": true }` |
| GET / PUT | `/api/instances/:id/config` | leer / guardar `config-<id>.yaml` |
| POST | `/api/instances/:id/allow` | `{ "list": "allowed_groups", "value": "…@g.us", "on": true }` |
| GET | `/api/instances/:id/groups` · `contacts` | grupos y contactos de WhatsApp |
| POST | `/api/instances/:id/send` | `{ "to": "…@g.us", "text": "…" }` |
| GET / PUT | `/api/telegram` | configuración de Telegram (el token sale enmascarado) |
| POST | `/api/telegram/test` | mensaje de prueba |
| GET / PUT | `/api/browser` | navegador detectado / fijar ruta `{ "path": "…" }` (vacío = autodetectar) |
| GET | `/api/instances/:id/qr.svg` | QR actual como imagen (404 si no hay) |
| POST | `/api/instances/:id/test` | ¿respondería? `{ "groupId", "user", "text", "at"? }` → `{ ok, reply, ruleName, keyword }` o `{ ok: false, reason }` |
| GET | `/api/instances/:id/stats?days=14` | respuestas por día, por grupo y por regla |
| GET / PUT | `/api/desktop` | acceso directo y arranque con el sistema `{ "launcher", "autostart" }` |
| POST | `/api/quit` | cerrar el panel (detiene las cuentas) |
| POST | `/api/instances/:id/simulate` | **solo con `--fake`**: simula un mensaje entrante `{ "from", "author", "body" }` |

## Protocolo bot ↔ panel

- **stdout:** solo JSON por líneas. Eventos `status`, `paused`, `qr`, `log`, `notification` y `rpc_result`.
- **stdin:** `{"type":"rpc","id","cmd",…}` o `{"type":"shutdown"}`.
- **RPC:** `PING`, `GET_STATE`, `SET_PAUSED`, `FETCH_GROUPS`, `FETCH_CONTACTS`, `SEARCH_CONTACTS`, `SEND_MESSAGE` y `LOGOUT`.

Códigos de salida:

| código | significado | ¿el panel reintenta? |
|---|---|---|
| `0` | parada normal | — |
| `1` | error | sí, con espera creciente |
| `3` | desconectado | sí, con espera creciente |
| `4` | sesión cerrada | no |
| `5` | fallo de autenticación | no |
| `78` | configuración inválida o el navegador no arranca | no |
| `79` | no hay navegador instalado (`browser_missing`) | no |

## Tests

```bash
cd bot && npm test      # lógica del bot con cliente falso
cd panel && npm test    # lanza procesos reales de bot.js en modo --fake
```
