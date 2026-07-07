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
            const msgId = Date.now() + '-' + Math.random().toString(36).substr(2, 5);
            let payload;
            if (this.encryptionEnabled && this.crypto.hasKey()) {
                const encrypted = await this.crypto.encrypt(text);
                payload = { id: msgId, encrypted, timestamp: Date.now() };
            } else {
                payload = { id: msgId, raw: text, timestamp: Date.now() };
            }
            this.conn.sendText(payload);
            const msg = { id: msgId, type: 'text', text, sender: { name: 'You', id: this.conn.getSocketId() }, timestamp: Date.now(), isSent: true };
            this.messages.push(msg);
            this._renderMessage(msg);
            this.saveHistory();
        } catch (err) {
            UI.toast('Failed to send: ' + err.message, 'error');
        }
    }

    async receive(data) {
        try {
            const msgId = data.id || (Date.now() + '-' + Math.random().toString(36).substr(2, 5));
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
            const msg = { id: msgId, type: 'text', text, sender: { name, id: data.from, color }, timestamp: data.timestamp, isSent: false };
            this.messages.push(msg);
            this._renderMessage(msg);
            this.saveHistory();
        } catch {
            const msg = { id: Date.now() + '-err', type: 'text', text: '[Could Not Decrypt - Wrong Key?]', sender: { name: 'System', color: 'var(--status-error)' }, timestamp: Date.now(), isSent: false };
            this.messages.push(msg);
            this._renderMessage(msg);
            this.saveHistory();
        }
    }

    addFileMessage(id, meta, url, isSent, sender, timestamp) {
        const msg = {
            id: id || (Date.now() + '-' + Math.random().toString(36).substr(2, 5)),
            type: 'file',
            meta: meta,
            url: url || null,
            sender: sender || { name: 'Peer' },
            timestamp: timestamp || Date.now(),
            isSent: isSent
        };
        if (!this.messages.some(m => m.id === msg.id && m.type === 'file')) {
            this.messages.push(msg);
            this._renderMessage(msg);
            this.saveHistory();
        }
    }

    _renderMessage(msg) {
        const container = document.getElementById('messages');
        if (!container) return;
        const empty = container.querySelector('.messages-empty');
        if (empty) empty.remove();
        if (msg.type === 'file') {
            container.appendChild(UI.renderFileChatMessage(msg.meta, msg.url, msg.isSent, msg.sender, msg.timestamp));
        } else {
            container.appendChild(UI.renderMessage(msg.text || msg.raw || '', msg.sender, msg.timestamp, msg.isSent));
        }
        container.scrollTop = container.scrollHeight;
    }

    _renderAllMessages() {
        const container = document.getElementById('messages');
        if (!container) return;
        container.innerHTML = '<div class="messages-empty" style="display:none"></div>';
        for (const msg of this.messages) {
            if (msg.type === 'file') {
                container.appendChild(UI.renderFileChatMessage(msg.meta, msg.url, msg.isSent, msg.sender, msg.timestamp));
            } else {
                container.appendChild(UI.renderMessage(msg.text || msg.raw || '', msg.sender, msg.timestamp, msg.isSent));
            }
        }
        container.scrollTop = container.scrollHeight;
    }

    saveHistory() {
        if (!this.conn || !this.conn.getRoomCode()) return;
        try {
            const key = 'whynotshare_chat_' + this.conn.getRoomCode();
            const toSave = this.messages.map(m => {
                if (m.type === 'file') return { ...m, url: null };
                return m;
            });
            localStorage.setItem(key, JSON.stringify(toSave));
        } catch {}
    }

    loadHistory() {
        if (!this.conn || !this.conn.getRoomCode()) return;
        try {
            const key = 'whynotshare_chat_' + this.conn.getRoomCode();
            const saved = localStorage.getItem(key);
            if (saved) {
                const arr = JSON.parse(saved);
                if (Array.isArray(arr) && arr.length > 0) {
                    this.messages = arr;
                    this._renderAllMessages();
                }
            }
        } catch {}
    }

    syncHistory(history) {
        if (!Array.isArray(history) || history.length === 0) return;
        let added = false;
        const myId = this.conn.getSocketId();
        for (const item of history) {
            if (!item || !item.id) continue;
            if (!this.messages.some(m => m.id === item.id)) {
                const isMyMessage = item.sender && item.sender.id === myId;
                const msgCopy = { ...item, isSent: isMyMessage };
                if (isMyMessage) {
                    msgCopy.sender = { ...item.sender, name: 'You' };
                } else if (item.sender && item.sender.id) {
                    const color = this._getPeerColor(item.sender.id);
                    msgCopy.sender = { ...item.sender, color: item.sender.color || color };
                }
                this.messages.push(msgCopy);
                added = true;
            }
        }
        if (added) {
            this.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            this._renderAllMessages();
            this.saveHistory();
        }
    }

    _getPeerColor(id) {
        if (!this.peerColorMap.has(id)) this.peerColorMap.set(id, DeviceInfo.getColor(this.colorIndex++));
        return this.peerColorMap.get(id);
    }

    setEncryption(on) { this.encryptionEnabled = on; }
    clear() {
        this.messages = [];
        if (this.conn && this.conn.getRoomCode()) {
            try { localStorage.removeItem('whynotshare_chat_' + this.conn.getRoomCode()); } catch {}
        }
        UI.showEmptyMessages();
    }
}
window.TextShare = TextShare;
