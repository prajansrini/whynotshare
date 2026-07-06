class TextShare {
    constructor(conn, crypto) {
        this.conn = conn;
        this.crypto = crypto;
        this.messages = [];
        this.encryptionEnabled = true;
        this.peerColorMap = new Map();
        this.colorIndex = 0;
    }

    async send(text) {
        if (!text.trim()) return;
        try {
            let payload;
            if (this.encryptionEnabled && this.crypto.hasKey()) {
                const encrypted = await this.crypto.encrypt(text);
                payload = { encrypted, timestamp: Date.now() };
            } else {
                payload = { raw: text, timestamp: Date.now() };
            }
            this.conn.sendText(payload);
            const msg = { text, sender: { name: 'You', id: this.conn.getSocketId() }, timestamp: Date.now(), isSent: true };
            this.messages.push(msg);
            this._renderMessage(msg);
        } catch (err) {
            UI.toast('Failed to send: ' + err.message, 'error');
        }
    }

    async receive(data) {
        try {
            let text;
            if (data.raw !== undefined) {
                text = data.raw;
            } else if (data.encrypted) {
                if (!this.crypto.hasKey()) { text = '[Encrypted - No Key Set]'; }
                else { text = await this.crypto.decrypt(data.encrypted); }
            } else { text = '[Unknown message format]'; }

            const peer = this.conn.getPeers().find(p => p.id === data.from);
            const name = peer ? peer.deviceName : 'Unknown Device';
            const color = this._getPeerColor(data.from);
            const msg = { text, sender: { name, id: data.from, color }, timestamp: data.timestamp, isSent: false };
            this.messages.push(msg);
            this._renderMessage(msg);
        } catch {
            const msg = { text: '[Could Not Decrypt - Wrong Key?]', sender: { name: 'System', color: 'var(--status-error)' }, timestamp: Date.now(), isSent: false };
            this.messages.push(msg);
            this._renderMessage(msg);
        }
    }

    _renderMessage(msg) {
        const container = document.getElementById('messages');
        if (!container) return;
        const empty = container.querySelector('.messages-empty');
        if (empty) empty.remove();
        container.appendChild(UI.renderMessage(msg.text, msg.sender, msg.timestamp, msg.isSent));
        container.scrollTop = container.scrollHeight;
    }

    _getPeerColor(id) {
        if (!this.peerColorMap.has(id)) this.peerColorMap.set(id, DeviceInfo.getColor(this.colorIndex++));
        return this.peerColorMap.get(id);
    }

    setEncryption(on) { this.encryptionEnabled = on; }
    clear() { this.messages = []; UI.showEmptyMessages(); }
}
window.TextShare = TextShare;
