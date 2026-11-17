// Cliente WhatsApp falso para tests y pruebas sin navegador (bot.js --fake).
// Imita la parte de la API de whatsapp-web.js que usa el bot.
const EventEmitter = require('events');

class FakeClient extends EventEmitter {
    constructor({ delayMs = 20, groups, contacts, lids = {} } = {}) {
        super();
        this.delayMs = delayMs;
        this.groups = groups || [
            { id: '111@g.us', name: 'Grupo Uno' },
            { id: '222@g.us', name: 'Grupo Dos' },
        ];
        this.contacts = contacts || [
            { id: '34600000001@c.us', name: 'Ana', isMyContact: true },
            { id: '34600000002@c.us', name: 'Beto', isMyContact: true },
            { id: '34699999999@c.us', name: '', pushname: 'Participante de un grupo', isMyContact: false },
            { id: '111@g.us', name: 'Grupo Uno', isMyContact: false, isGroup: true },
        ];
        this.lids = lids; // '<n>@lid' -> '<n>@c.us'
        this.sent = [];
        this.replies = [];
        this.lookups = 0;
        this.authStrategy = { logout: async () => {} };
    }

    async initialize() {
        const step = (fn) => new Promise((r) => setTimeout(() => { fn(); r(); }, this.delayMs));
        await step(() => this.emit('qr', 'FAKE-QR-' + Date.now()));
        await step(() => this.emit('authenticated'));
        await step(() => this.emit('ready'));
    }

    async getChats() {
        return this.groups.map((g) => ({ isGroup: true, id: { _serialized: g.id }, name: g.name }));
    }

    async getContacts() {
        return this.contacts.map((c) => ({
            id: { _serialized: c.id }, name: c.name, pushname: c.pushname,
            isMyContact: c.isMyContact !== false, isGroup: Boolean(c.isGroup), isMe: false,
        }));
    }

    async getContactLidAndPhone(ids) {
        this.lookups++;
        const byPn = Object.fromEntries(Object.entries(this.lids).map(([l, p]) => [p, l]));
        return ids.map((id) =>
            id.endsWith('@lid')
                ? { lid: id, pn: this.lids[id] }
                : { lid: byPn[id], pn: id }
        );
    }

    async sendMessage(to, text) { this.sent.push({ to, text }); }
    async sendPresenceUnavailable() {}
    async logout() {}
    async destroy() {}

    // Simula un mensaje entrante de grupo
    injectMessage({ from, author, body, fromMe = false }) {
        const group = this.groups.find((g) => g.id === from);
        const msg = {
            from, author, body, fromMe,
            reply: async (text) => { this.replies.push({ to: from, text }); },
            getChat: async () => ({ id: { _serialized: from }, name: group ? group.name : from, isGroup: true }),
        };
        this.emit('message_create', msg);
        return msg;
    }
}

module.exports = { FakeClient };
