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
        const peers = (this.conn && typeof this.conn.getPeers === 'function') ? this.conn.getPeers() : [];
        const myId = this.conn ? (this.conn.getSocketId() || this.conn.myPeerId) : null;
        const otherPeers = peers.filter(p => p && p.id !== myId);
        let recipients = (isPersonal && window.app && window.app.selectedPersonalRecipients && window.app.selectedPersonalRecipients.size > 0) ? Array.from(window.app.selectedPersonalRecipients) : null;
        try {
            const msgId = Date.now() + '-' + Math.random().toString(36).substr(2, 5);
            let payload = { id: msgId, raw: text, timestamp: Date.now(), recipients };
            if (isPersonal && this.crypto) {
                try {
                    const encrypted = await this.crypto.encryptWithPersonalKey(text);
                    payload.personalEncrypted = true;
                    payload.encrypted = encrypted;
                } catch { }
            } else if (this.encryptionEnabled && this.crypto && this.crypto.hasKey()) {
                try {
                    const encrypted = await this.crypto.encrypt(text);
                    payload.encrypted = encrypted;
                } catch { }
            }
            this.conn.sendText(payload);
            const msg = { id: msgId, type: 'text', text, sender: { name: 'You', id: this.conn.getSocketId() }, timestamp: Date.now(), isSent: true, _encrypted: payload.encrypted, _personalEncrypted: payload.personalEncrypted, _from: this.conn.getSocketId() || this.conn.myPeerId };
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
            if (data.raw !== undefined) {
                text = data.raw;
            } else if (data.personalEncrypted && data.encrypted) {
                try {
                    text = await this.crypto.decryptWithPersonalKey(data.encrypted, data.from);
                } catch (e) {
                    text = data.raw || data.text || '[Message]';
                }
            } else if (data.encrypted) {
                if (!this.crypto.hasKey()) { text = data.raw || data.text || '[Message]'; }
                else {
                    try {
                        text = await this.crypto.decrypt(data.encrypted);
                    } catch {
                        text = data.raw || data.text || '[Message]';
                    }
                }
            } else { text = data.text || data.raw || '[Message]'; }

            const peer = this.conn.getPeers().find(p => p.id === data.from);
            const name = peer ? peer.deviceName : 'Unknown Device';
            const color = this._getPeerColor(data.from);
            const msg = { id: msgId, type: 'text', text, sender: { name, id: data.from, color }, timestamp: data.timestamp, isSent: false, _encrypted: data.encrypted, _personalEncrypted: data.personalEncrypted, _from: data.from };
            this.messages.push(msg);
            this._renderMessage(msg);
            this.saveHistory();
        } catch {
            const msgId = data && data.id ? data.id : (Date.now() + '-err');
            const fallbackText = (data && (data.raw || data.text)) ? (data.raw || data.text) : '[Message]';
            const msg = { id: msgId, type: 'text', text: fallbackText, sender: { name: 'Member', color: 'var(--accent-primary)' }, timestamp: (data && data.timestamp) || Date.now(), isSent: false, _encrypted: data && data.encrypted, _personalEncrypted: data && data.personalEncrypted, _from: data && data.from };
            this.messages.push(msg);
            this._renderMessage(msg);
            this.saveHistory();
        }
    }

    addSystemMessage(text, type = 'info') {
        const color = type === 'error' ? 'var(--status-error)' : (type === 'success' ? 'var(--status-success)' : 'var(--accent-primary)');
        const msg = {
            id: 'sys_' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            type: 'text',
            text: text,
            sender: { name: 'System', color: color },
            timestamp: Date.now(),
            isSent: false
        };
        this.messages.push(msg);
        this._renderMessage(msg);
        this.saveHistory();
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
        const existing = this.messages.find(m => (m.id === msg.id || (m.meta && msg.meta && m.meta.fileId === msg.meta.fileId)) && m.type === 'file');
        if (existing) {
            if (url && !existing.url) {
                existing.url = url;
                this.updateSingleMessageUI(existing);
            }
            return;
        }
        this.messages.push(msg);
        this._renderMessage(msg);
        this.saveHistory();
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

    updateSingleMessageUI(msg) {
        const container = document.getElementById('messages');
        if (!container || !msg) return false;
        const fid = (msg.meta && msg.meta.fileId) ? msg.meta.fileId : null;
        let existingEl = null;
        if (fid) existingEl = container.querySelector(`.message[data-file-id="${fid}"]`);
        if (!existingEl && msg.id) existingEl = container.querySelector(`.message[data-msg-id="${msg.id}"]`);
        if (existingEl) {
            const idx = this.messages.indexOf(msg);
            const groupInfo = idx >= 0 ? this._getGroupingInfo(idx) : { isGroupFollowup: false, hasGroupFollowup: false };
            let newEl;
            if (msg.type === 'file') {
                newEl = UI.renderFileChatMessage(msg.meta, msg.url, msg.isSent, msg.sender, msg.timestamp, groupInfo);
            } else {
                newEl = UI.renderMessage(msg.text || msg.raw || '', msg.sender, msg.timestamp, msg.isSent, groupInfo);
            }
            if (newEl) {
                if (fid) newEl.dataset.fileId = fid;
                if (msg.id) newEl.dataset.msgId = msg.id;
                if (groupInfo.isGroupFollowup && existingEl.classList.contains('message-group-followup')) {
                    newEl.classList.add('message-group-followup');
                }
                existingEl.replaceWith(newEl);
                return true;
            }
        }
        return false;
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

        let el;
        if (msg.type === 'file') {
            el = UI.renderFileChatMessage(msg.meta, msg.url, msg.isSent, msg.sender, msg.timestamp, groupInfo);
        } else {
            el = UI.renderMessage(msg.text || msg.raw || '', msg.sender, msg.timestamp, msg.isSent, groupInfo);
        }
        if (el) {
            if (msg.meta && msg.meta.fileId) el.dataset.fileId = msg.meta.fileId;
            if (msg.id) el.dataset.msgId = msg.id;
            container.appendChild(el);
            container.scrollTop = container.scrollHeight;
        }
    }

    _renderAllMessages(immediate = false) {
        if (!immediate) {
            if (this._renderDebounceTimer) return;
            this._renderDebounceTimer = setTimeout(() => {
                this._renderDebounceTimer = null;
                this._renderAllMessagesNow();
            }, 50);
            return;
        }
        if (this._renderDebounceTimer) {
            clearTimeout(this._renderDebounceTimer);
            this._renderDebounceTimer = null;
        }
        this._renderAllMessagesNow();
    }

    _renderAllMessagesNow() {
        const container = document.getElementById('messages');
        if (!container) return;
        container.innerHTML = '<div class="messages-empty" style="display:none"></div>';
        for (let i = 0; i < this.messages.length; i++) {
            const msg = this.messages[i];
            const groupInfo = this._getGroupingInfo(i);
            let el;
            if (msg.type === 'file') {
                el = UI.renderFileChatMessage(msg.meta, msg.url, msg.isSent, msg.sender, msg.timestamp, groupInfo);
            } else {
                el = UI.renderMessage(msg.text || msg.raw || '', msg.sender, msg.timestamp, msg.isSent, groupInfo);
            }
            if (el) {
                if (msg.meta && msg.meta.fileId) el.dataset.fileId = msg.meta.fileId;
                if (msg.id) el.dataset.msgId = msg.id;
                container.appendChild(el);
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
        let addedOrUpdated = false;
        const myId = this.conn.getSocketId();
        for (const item of history) {
            if (!item || !item.id) continue;
            if (item.type === 'file' && item.meta && item.meta.recipients && Array.isArray(item.meta.recipients) && item.meta.recipients.length > 0 && !item.meta.recipients.includes(myId)) continue;
            if (item.type === 'text' && item.recipients && Array.isArray(item.recipients) && item.recipients.length > 0 && !item.recipients.includes(myId)) continue;
            const existingMsg = this.messages.find(m => m.id === item.id);
            if (existingMsg) {
                const isMyMessage = item.sender && item.sender.id === myId;
                if (!isMyMessage && existingMsg.sender && (existingMsg.sender.name === 'You' || existingMsg.isSent)) {
                    const peer = this.conn.getPeers().find(p => p && p.id === existingMsg.sender.id);
                    const peerName = peer ? peer.deviceName : (existingMsg.sender.name === 'You' ? 'Host' : (existingMsg.sender.name || 'Unknown Device'));
                    existingMsg.sender.name = peerName;
                    existingMsg.isSent = false;
                    addedOrUpdated = true;
                }
                if (existingMsg.text && (existingMsg.text.startsWith('🔒 [Encrypted Message') || existingMsg.text.startsWith('[Could Not Decrypt') || existingMsg.text.startsWith('[Encrypted - No Key Set]')) && item.text && !item.text.startsWith('🔒 [Encrypted Message') && !item.text.startsWith('[Could Not Decrypt') && !item.text.startsWith('[Encrypted - No Key Set]')) {
                    existingMsg.text = item.text;
                    addedOrUpdated = true;
                }
            } else {
                const isMyMessage = item.sender && item.sender.id === myId;
                const msgCopy = { ...item, isSent: isMyMessage };
                if (msgCopy.type === 'file' && msgCopy.url && msgCopy.url.startsWith('blob:')) {
                    msgCopy.url = null;
                }
                if (isMyMessage) {
                    msgCopy.sender = { ...item.sender, name: 'You' };
                } else if (item.sender && item.sender.id) {
                    const peer = this.conn.getPeers().find(p => p && p.id === item.sender.id);
                    const peerName = peer ? peer.deviceName : (item.sender.name === 'You' ? 'Host' : (item.sender.name || 'Unknown Device'));
                    const color = this._getPeerColor(item.sender.id);
                    msgCopy.sender = { ...item.sender, name: peerName, color: item.sender.color || color };
                }
                this.messages.push(msgCopy);
                addedOrUpdated = true;
            }
        }
        if (addedOrUpdated) {
            this.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            this._renderAllMessages();
            this.saveHistory();
            if (window.app && window.app.fileTransfer) {
                let anyNeedFullRender = false;
                for (const m of this.messages) {
                    if (m.type === 'file' && m.meta && m.meta.fileId && !m.url) {
                        const blob = await window.app.fileTransfer.loadFromIndexedDB(m.meta.fileId);
                        if (blob) {
                            m.url = URL.createObjectURL(blob);
                            if (!this.updateSingleMessageUI(m)) anyNeedFullRender = true;
                        } else if (m.meta && m.meta.fileSize < 2 * 1024 * 1024 && this.conn.connections && this.conn.connections.size > 0) {
                            this.conn.sendFileEvent('request-history-file', { fileId: m.meta.fileId, targetId: this.conn.myPeerId });
                        }
                    }
                }
                if (anyNeedFullRender) this._renderAllMessages();
            }
        }
        this.reTryDecryptMessages();
    }

    async reTryDecryptMessages() {
        if (!this.messages || this.messages.length === 0) return;
        let changed = false;
        for (const m of this.messages) {
            if (m.text && (m.text.startsWith('🔒 [Encrypted Message') || m.text.startsWith('[Could Not Decrypt') || m.text.startsWith('[Encrypted - No Key Set]'))) {
                if (m.raw) {
                    m.text = m.raw;
                    changed = true;
                } else if (m._personalEncrypted && m._encrypted && m._from && this.crypto && this.crypto.peerPersonalKeys && this.crypto.peerPersonalKeys.has(m._from)) {
                    try {
                        m.text = await this.crypto.decryptWithPersonalKey(m._encrypted, m._from);
                        changed = true;
                    } catch {
                        if (m.raw) { m.text = m.raw; changed = true; }
                    }
                } else if (!m._personalEncrypted && m._encrypted && this.crypto && this.crypto.hasKey()) {
                    try {
                        m.text = await this.crypto.decrypt(m._encrypted);
                        changed = true;
                    } catch {
                        if (m.raw) { m.text = m.raw; changed = true; }
                    }
                }
            }
        }
        if (changed) {
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
