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
        const isPersonal = Boolean(window.app && window.app.personalE2E);
        const recipients = (isPersonal && window.app && window.app.selectedPersonalRecipients) ? Array.from(window.app.selectedPersonalRecipients) : null;
        if (isPersonal && (!recipients || recipients.length === 0)) {
            if (typeof UI !== 'undefined') UI.toast('Please select at least one Authorized Recipient in Personal E2E settings first!', 'error');
            const msgId = Date.now() + '-no-rec';
            const msg = {
                id: msgId,
                type: 'text',
                text: text,
                sender: { name: 'You', id: this.conn.getSocketId() },
                timestamp: Date.now(),
                isSent: true
            };
            this.messages.push(msg);
            this._renderMessage(msg);
            this.saveHistory();
            return;
        }
        try {
            const msgId = Date.now() + '-' + Math.random().toString(36).substr(2, 5);
            let payload;
            if (isPersonal) {
                const encrypted = await this.crypto.encryptWithPersonalKey(text);
                payload = { id: msgId, personalEncrypted: true, encrypted, timestamp: Date.now(), recipients };
            } else if (this.encryptionEnabled && this.crypto.hasKey()) {
                const encrypted = await this.crypto.encrypt(text);
                payload = { id: msgId, encrypted, timestamp: Date.now(), recipients };
            } else {
                payload = { id: msgId, raw: text, timestamp: Date.now(), recipients };
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
        if (data.recipients && Array.isArray(data.recipients) && data.recipients.length > 0) {
            if (!data.recipients.includes(this.conn.getSocketId()) && data.from !== this.conn.getSocketId()) {
                return;
            }
        }
        try {
            const msgId = data.id || (Date.now() + '-' + Math.random().toString(36).substr(2, 5));
            if (this.messages.some(m => m.id === msgId || (data.id && m.id === data.id) || (m.timestamp && Math.abs((m.timestamp || 0) - (data.timestamp || 0)) < 1000 && m.sender && m.sender.id === data.from && (m.text === data.raw || (data.encrypted && m._encrypted === data.encrypted))))) {
                return;
            }
            let text;
            if (data.personalEncrypted) {
                try {
                    text = await this.crypto.decryptWithPersonalKey(data.encrypted, data.from);
                } catch (e) {
                    text = '🔒 [Encrypted Message — Key Required]';
                }
            } else if (data.raw !== undefined) {
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

    _getGroupingInfo(index) {
        const curr = this.messages[index];
        if (!curr) return { isGroupFollowup: false, hasGroupFollowup: false };
        const prev = index > 0 ? this.messages[index - 1] : null;
        const next = index < this.messages.length - 1 ? this.messages[index + 1] : null;

        const isSameSender = (m1, m2) => {
            if (!m1 || !m2) return false;
            if (m1.isSent !== m2.isSent) return false;
            const s1 = typeof m1.sender === 'object' && m1.sender ? (m1.sender.id || m1.sender.name) : (m1.sender || 'Peer');
            const s2 = typeof m2.sender === 'object' && m2.sender ? (m2.sender.id || m2.sender.name) : (m2.sender || 'Peer');
            return s1 === s2 && Math.abs((m1.timestamp || 0) - (m2.timestamp || 0)) < 300000;
        };

        return {
            isGroupFollowup: isSameSender(prev, curr),
            hasGroupFollowup: isSameSender(curr, next)
        };
    }

    _renderMessage(msg) {
        const container = document.getElementById('messages');
        if (!container) return;
        const empty = container.querySelector('.messages-empty');
        if (empty) empty.remove();

        const idx = this.messages.indexOf(msg);
        const groupInfo = idx >= 0 ? this._getGroupingInfo(idx) : { isGroupFollowup: false, hasGroupFollowup: false };

        if (groupInfo.isGroupFollowup && container.lastElementChild) {
            const prevEl = container.lastElementChild;
            prevEl.classList.add('message-group-lead');
            const prevTime = prevEl.querySelector('.message-time-wrapper');
            if (prevTime) prevTime.classList.add('message-time-grouped');
        }

        if (msg.type === 'file') {
            container.appendChild(UI.renderFileChatMessage(msg.meta, msg.url, msg.isSent, msg.sender, msg.timestamp, groupInfo));
        } else {
            container.appendChild(UI.renderMessage(msg.text || msg.raw || '', msg.sender, msg.timestamp, msg.isSent, groupInfo));
        }
        container.scrollTop = container.scrollHeight;
    }

    _renderAllMessages() {
        const container = document.getElementById('messages');
        if (!container) return;
        container.innerHTML = '<div class="messages-empty" style="display:none"></div>';
        for (let i = 0; i < this.messages.length; i++) {
            const msg = this.messages[i];
            const groupInfo = this._getGroupingInfo(i);
            if (msg.type === 'file') {
                container.appendChild(UI.renderFileChatMessage(msg.meta, msg.url, msg.isSent, msg.sender, msg.timestamp, groupInfo));
            } else {
                container.appendChild(UI.renderMessage(msg.text || msg.raw || '', msg.sender, msg.timestamp, msg.isSent, groupInfo));
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

    async loadHistory() {
        if (!this.conn || !this.conn.getRoomCode()) return;
        try {
            const key = 'whynotshare_chat_' + this.conn.getRoomCode();
            const saved = localStorage.getItem(key);
            if (saved) {
                const arr = JSON.parse(saved);
                if (Array.isArray(arr) && arr.length > 0) {
                    this.messages = arr.map(m => {
                        if (m && m.type === 'file' && m.url && m.url.startsWith('blob:')) {
                            return { ...m, url: null };
                        }
                        return m;
                    });
                    this._renderAllMessages();
                    if (window.app && window.app.fileTransfer) {
                        let reRender = false;
                        for (const m of this.messages) {
                            if (m.type === 'file' && m.meta && m.meta.fileId && !m.url) {
                                const blob = await window.app.fileTransfer.loadFromIndexedDB(m.meta.fileId);
                                if (blob) {
                                    m.url = URL.createObjectURL(blob);
                                    reRender = true;
                                } else if (m.meta.fileSize < 2 * 1024 * 1024 && this.conn.connections && this.conn.connections.size > 0) {
                                    this.conn.sendFileEvent('request-history-file', { fileId: m.meta.fileId, targetId: this.conn.myPeerId });
                                }
                            }
                        }
                        if (reRender) this._renderAllMessages();
                    }
                }
            }
        } catch {}
    }

    async syncHistory(history) {
        if (!Array.isArray(history) || history.length === 0) return;
        let added = false;
        const myId = this.conn.getSocketId();
        for (const item of history) {
            if (!item || !item.id) continue;
            if (!this.messages.some(m => m.id === item.id)) {
                const isMyMessage = item.sender && item.sender.id === myId;
                const msgCopy = { ...item, isSent: isMyMessage };
                if (msgCopy.type === 'file' && msgCopy.url && msgCopy.url.startsWith('blob:')) {
                    msgCopy.url = null;
                }
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
            if (window.app && window.app.fileTransfer) {
                let reRender = false;
                for (const m of this.messages) {
                    if (m.type === 'file' && m.meta && m.meta.fileId && !m.url) {
                        const blob = await window.app.fileTransfer.loadFromIndexedDB(m.meta.fileId);
                        if (blob) {
                            m.url = URL.createObjectURL(blob);
                            reRender = true;
                        } else if (this.conn.connections && this.conn.connections.size > 0) {
                            this.conn.sendFileEvent('request-history-file', { fileId: m.meta.fileId, targetId: this.conn.myPeerId });
                        }
                    }
                }
                if (reRender) this._renderAllMessages();
            }
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
