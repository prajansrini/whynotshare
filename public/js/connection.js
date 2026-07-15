class ConnectionManager {
    constructor() {
        this.peer = null;
        this.connections = new Map();
        this.roomCode = null;
        this.isCreator = false;
        this.peers = [];
        this.myInfo = DeviceInfo.detect();
        this.myPeerId = null;
        this.onPeerJoined = null;
        this.onPeerLeft = null;
        this.onTextReceived = null;
        this.onFileEvent = null;
        this.onConnected = null;
        this.onDisconnected = null;
        this.onSyncRequest = null;
        this.onHistoryReceived = null;
        this.onFileHistoryRequest = null;
        this.onFileHistoryReceived = null;
        this.auditLogs = [];
        this.onAuditLogSync = null;
        this.kickedPeerIds = new Set();
        this._startHeartbeat();
    }

    markKicked(peerId) {
        if (peerId) this.kickedPeerIds.add(peerId);
    }

    addAuditLog(text, category = 'info', skipForward = false) {
        if (this.auditLogs.length > 0 && this.auditLogs[0].text === text && (Date.now() - (this.auditLogs[0].time || 0)) < 2000) {
            return this.auditLogs[0];
        }
        const entry = { time: Date.now(), text, category };
        this.auditLogs.unshift(entry);
        if (this.auditLogs.length > 500) this.auditLogs = this.auditLogs.slice(0, 500);
        if (this.onAuditLogSync) this.onAuditLogSync(this.auditLogs);
        if (window.app && window.app.renderAuditLogs) window.app.renderAuditLogs();
        if (this.isCreator) {
            this._broadcast({ type: 'audit-log-sync', payload: this.auditLogs });
        } else if (this.roomCode && !skipForward) {
            this.sendDirect(this._roomCodeToPeerId(this.roomCode), { type: 'client-audit-log', payload: { text, category } });
        }
        return entry;
    }

    _roomCodeToPeerId(code) {
        if (!code) return null;
        return 'wns-' + String(code).replace(/-/g, '').toUpperCase();
    }

    _generateRoomCode() {
        const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) code += c[Math.floor(Math.random() * c.length)];
        return code.slice(0, 3) + '-' + code.slice(3);
    }

    _getPeerOptions() {
        return {
            pingInterval: 5000,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun3.l.google.com:19302' },
                    { urls: 'stun:stun4.l.google.com:19302' }
                ]
            }
        };
    }

    _onConnOpen(conn, callback) {
        if (!conn) return;
        if (conn.open || conn._open) {
            callback();
        } else {
            conn.on('open', callback);
        }
    }

    connect() { if (this.onConnected) this.onConnected(); }

    createRoom(existingCode) {
        const code = existingCode || this._generateRoomCode();
        const peerId = this._roomCodeToPeerId(code);
        return new Promise((resolve, reject) => {
            const tryOpen = (attempt = 1) => {
                if (this.peer) { try { this.peer.destroy(); } catch {} }
                this.peer = new Peer(peerId, this._getPeerOptions());
                this.peer.on('open', (id) => {
                    this.myPeerId = id;
                    this.roomCode = code;
                    this.isCreator = true;
                    this.peers = [{ id, ...this.myInfo, isCreator: true }];
                    this.addAuditLog(`Room created (${code})`, 'success');
                    const hostDevName = (this.myInfo && this.myInfo.deviceName) ? this.myInfo.deviceName : 'Host';
                    this.addAuditLog(`${hostDevName} joined the room`, 'info');
                    resolve(code);
                });
                this.peer.on('connection', (conn) => this._handleIncoming(conn));
                this.peer.on('error', (err) => {
                    if (err && err.type === 'unavailable-id' && attempt <= 3) {
                        setTimeout(() => tryOpen(attempt + 1), 1500);
                    } else if (err && err.type === 'unavailable-id') {
                        reject(new Error('Room code taken. Try again.'));
                    } else {
                        reject(new Error((err && err.message) || 'Connection failed'));
                    }
                });
                this.peer.on('disconnected', () => { if (this.peer && !this.peer.destroyed) this.peer.reconnect(); });
            };
            tryOpen(1);
        });
    }

    joinRoom(code) {
        const hostPeerId = this._roomCodeToPeerId(code);
        return new Promise((resolve, reject) => {
            if (this.peer) { try { this.peer.destroy(); } catch {} }
            this.peer = new Peer(undefined, this._getPeerOptions());
            let settled = false;
            this._joinResolve = (peers) => { if (!settled) { settled = true; resolve(peers); } };
            this._joinReject = (err) => { if (!settled) { settled = true; reject(err); } };
            this.peer.on('open', (id) => {
                this.myPeerId = id;
                this.roomCode = code;
                this.isCreator = false;
                const conn = this.peer.connect(hostPeerId, { metadata: { deviceInfo: this.myInfo }, reliable: true });
                this._onConnOpen(conn, () => {
                    this._register(conn, hostPeerId);
                    const authHash = window.app && window.app.crypto ? window.app.crypto.authHash : null;
                    conn.send({ type: 'peer-info', payload: { id, ...this.myInfo, authHash } });
                    conn.send({ type: 'request-audit-log-sync' });
                    this.peers = [
                        { id: hostPeerId, deviceName: 'Room Host', deviceType: 'laptop', isCreator: true },
                        { id, ...this.myInfo, isCreator: false }
                    ];
                });
                conn.on('error', () => { if (this._joinReject) this._joinReject(new Error('Connection failed')); });
                setTimeout(() => { if (this._joinReject) this._joinReject(new Error('Timed out. Room may not exist.')); }, 12000);
            });
            this.peer.on('error', (err) => {
                if (this._joinReject) {
                    this._joinReject(new Error(err && err.type === 'peer-unavailable' ? 'Room not found.' : ((err && err.message) || 'Failed')));
                }
            });
            this.peer.on('disconnected', () => { if (this.peer && !this.peer.destroyed) this.peer.reconnect(); });
        });
    }

    _handleIncoming(conn) {
        this._onConnOpen(conn, () => {
            this._register(conn, conn.peer);
        });
    }

    _register(conn, peerId) {
        if (!conn) return;
        const oldConn = this.connections.get(peerId);
        if (oldConn && oldConn !== conn) {
            try { oldConn.close(); } catch {}
        }
        if (conn._isRegistered) return;
        conn._isRegistered = true;
        this.connections.set(peerId, conn);
        conn.on('data', (data) => this._onMessage(data, peerId));
        conn.on('error', (err) => {
            try { conn.close(); } catch {}
        });
        conn.on('close', () => {
            if (this.connections.get(peerId) === conn) {
                this.connections.delete(peerId);
            }
            const isKicked = this.kickedPeerIds.has(peerId);
            if (isKicked) this.kickedPeerIds.delete(peerId);
            const hostId = this._roomCodeToPeerId(this.roomCode);
            const wasHost = (peerId === hostId);
            const peer = this.peers.find(p => p.id === peerId);
            this.peers = this.peers.filter(p => p.id !== peerId);
            if (!isKicked && this.onPeerLeft) this.onPeerLeft(peer || { id: peerId, deviceName: 'Member' });
            if (this.isCreator) {
                this._broadcast({ type: 'peer-update', payload: [...this.peers] }, peerId);
            }
            if (window.app && window.app.refreshPeerLists) window.app.refreshPeerLists();
            else if (typeof UI !== 'undefined') UI.updateDevicesList(this.peers, this.myPeerId);
        });
    }

    async _onMessage(data, fromId) {
        switch (data.type) {
            case 'ping': {
                const c = this.connections.get(fromId);
                if (c && c.open) { try { c.send({ type: 'pong', payload: { time: Date.now() } }); } catch {} }
                break;
            }
            case 'pong': {
                break;
            }
            case 'peer-info': {
                const payload = data.payload || {};
                if (this.isCreator && window.app && window.app.e2eEnabled) {
                    const hostAuth = window.app.crypto ? window.app.crypto.authHash : null;
                    if (hostAuth && payload.authHash !== hostAuth) {
                        const reason = !payload.authHash ? 'Room Key required! This room is encrypted.' : 'Incorrect Room Key! Access denied.';
                        const c = this.connections.get(fromId);
                        if (c && c.open) {
                            try { c.send({ type: 'join-rejected', payload: { reason } }); } catch {}
                            setTimeout(() => { try { c.close(); } catch {} }, 300);
                        }
                        this.connections.delete(fromId);
                        break;
                    }
                }
                const info = {
                    id: payload.id || fromId,
                    deviceName: payload.deviceName || 'Member Device',
                    deviceType: payload.deviceType || 'laptop',
                    systemName: payload.systemName || '',
                    ...payload
                };
                info.id = info.id || fromId;
                info.deviceName = info.deviceName || 'Member Device';
                info.isCreator = (info.id === this._roomCodeToPeerId(this.roomCode));
                const ex = this.peers.find(p => p.id === info.id);
                if (!ex) this.peers.push(info); else Object.assign(ex, info);
                if (this.onPeerJoined) this.onPeerJoined(info);
                if (this.isCreator) {
                    const c = this.connections.get(fromId);
                    if (c && (c.open || c._open)) {
                        try { c.send({ type: 'host-info', payload: { id: this.myPeerId, ...this.myInfo, isCreator: true } }); } catch {}
                        try { c.send({ type: 'peer-update', payload: [...this.peers] }); } catch {}
                        try { c.send({ type: 'audit-log-sync', payload: this.auditLogs }); } catch {}
                        setTimeout(() => { if (c && (c.open || c._open)) try { c.send({ type: 'audit-log-sync', payload: this.auditLogs }); } catch {} }, 300);
                        setTimeout(() => { if (c && (c.open || c._open)) try { c.send({ type: 'audit-log-sync', payload: this.auditLogs }); } catch {} }, 800);
                        setTimeout(() => { if (c && (c.open || c._open)) try { c.send({ type: 'audit-log-sync', payload: this.auditLogs }); } catch {} }, 1500);
                    }
                    this._broadcast({ type: 'peer-update', payload: [...this.peers] }, fromId);
                    if (this.onSyncRequest) {
                        const history = this.onSyncRequest();
                        if (history && history.length > 0) {
                            const c = this.connections.get(fromId);
                            if (c && c.open) c.send({ type: 'chat-history', payload: history });
                        }
                    }
                    if (this.onFileHistoryRequest) {
                        const fileHistory = this.onFileHistoryRequest();
                        if (fileHistory && fileHistory.length > 0) {
                            const c = this.connections.get(fromId);
                            if (c && c.open) c.send({ type: 'file-history', payload: fileHistory });
                        }
                    }
                }
                break;
            }
            case 'host-info': {
                const hi = data.payload;
                const idx = this.peers.findIndex(p => p.id === hi.id);
                if (idx >= 0) this.peers[idx] = hi; else this.peers.unshift(hi);
                if (this._joinResolve) { this._joinResolve(this.peers); this._joinResolve = null; }
                if (this.onPeerJoined) this.onPeerJoined(hi);
                if (window.app && window.app.refreshPeerLists) window.app.refreshPeerLists();
                else if (typeof UI !== 'undefined') UI.updateDevicesList(this.peers, this.myPeerId);
                break;
            }
            case 'join-rejected': {
                if (this._joinReject) {
                    this._joinReject(new Error(data.payload.reason || 'Room Key required! This room is encrypted.'));
                    this._joinReject = null;
                    this._joinResolve = null;
                }
                if (this.peer) { try { this.peer.destroy(); } catch {} }
                break;
            }
            case 'peer-update': {
                const oldHost = (this.peers || []).find(p => p.isCreator);
                this.peers = (Array.isArray(data.payload) ? data.payload : []).map(p => ({
                    deviceName: 'Member Device',
                    deviceType: 'laptop',
                    ...p
                }));
                const newHost = (this.peers || []).find(p => p.isCreator);
                if (oldHost && newHost && oldHost.id !== newHost.id && typeof UI !== 'undefined') {
                    UI.toast(`${newHost.deviceName || 'Admin'} is now the Room Host!`, 'info');
                }
                if (!this.peers.find(p => p.id === this.myPeerId))
                    this.peers.push({ id: this.myPeerId, ...this.myInfo, isCreator: false });
                if (window.app && window.app.refreshPeerLists) window.app.refreshPeerLists();
                else UI.updateDevicesList(this.peers, this.myPeerId);
                break;
            }
            case 'host-leaving':
                if (fromId === this._roomCodeToPeerId(this.roomCode)) {
                    this.scheduleHostSuccession(5000);
                }
                break;
            case 'chat-history': {
                if (this.onHistoryReceived) this.onHistoryReceived(data.payload);
                break;
            }
            case 'file-history': {
                if (this.onFileHistoryReceived) this.onFileHistoryReceived(data.payload);
                break;
            }
            case 'request-history-file': {
                if (window.app && window.app.fileTransfer && data.payload && data.payload.fileId && data.payload.targetId) {
                    const hasBlob = window.app.fileTransfer.fileCache.has(data.payload.fileId) || await window.app.fileTransfer.loadFromIndexedDB(data.payload.fileId);
                    if (hasBlob) {
                        const sent = await window.app.fileTransfer.sendCachedFileToPeer(data.payload.fileId, data.payload.targetId);
                        if (sent) break;
                    }
                    if (this.isCreator) {
                        this._broadcast(data, fromId);
                    } else if (data.payload.targetId !== this.myPeerId) {
                        this.sendDirect(data.payload.targetId, { type: 'file-history-missing', payload: { fileId: data.payload.fileId } });
                    }
                } else if (this.isCreator) {
                    this._broadcast(data, fromId);
                }
                break;
            }
            case 'file-history-missing': {
                if (window.app && window.app.onFileHistoryMissing && data.payload) {
                    window.app.onFileHistoryMissing(data.payload.fileId);
                }
                break;
            }
            case 'text': {
                const sid = data.payload.senderId || fromId;
                if (sid === this.myPeerId) break;
                if (this.onTextReceived) this.onTextReceived({ ...data.payload, id: data.payload.id, from: sid, encrypted: data.payload.encrypted, timestamp: data.payload.timestamp, raw: data.payload.raw });
                if (this.isCreator) this._broadcast({ type: 'text', payload: data.payload }, fromId);
                break;
            }
            case 'file-meta': case 'file-chunk': case 'file-complete': case 'file-cancel':
                if (this.onFileEvent) this.onFileEvent(data.type, data.payload);
                if (this.isCreator) this._broadcast(data, fromId);
                break;
            case 'peer-rename': {
                const rinfo = data.payload;
                const p = this.peers.find(x => x.id === rinfo.id);
                if (p) {
                    p.deviceName = rinfo.deviceName;
                    if (window.app && window.app.refreshPeerLists) {
                        window.app.refreshPeerLists();
                    } else if (typeof UI !== 'undefined') {
                        UI.updateDevicesList(this.peers, this.myPeerId);
                    }
                    if (this.isCreator) this._broadcast({ type: 'peer-update', payload: [...this.peers] });
                }
                break;
            }
            case 'room-id-changed': {
                this.roomCode = data.payload.newCode;
                if (window.app && window.app._onRoomIdChanged) window.app._onRoomIdChanged(this.roomCode);
                if (this.isCreator) this._broadcast(data, fromId);
                break;
            }
            case 'room-key-rotated': {
                if (window.app && window.app._onRoomKeyRotated) window.app._onRoomKeyRotated(data.payload.newKey);
                if (this.isCreator) {
                    this._broadcast(data, fromId);
                } else if (data.payload && data.payload.newKey && data.payload.newKey.trim()) {
                    this.addAuditLog('Room security passphrase rotated', 'sec', true);
                } else {
                    this.addAuditLog('Room is made Open', 'sec', true);
                }
                break;
            }
            case 'audit-log-sync': {
                if (Array.isArray(data.payload)) {
                    this.auditLogs = data.payload;
                    if (this.onAuditLogSync) this.onAuditLogSync(this.auditLogs);
                    if (window.app && window.app.renderAuditLogs) window.app.renderAuditLogs();
                }
                break;
            }
            case 'client-audit-log': {
                if (this.isCreator && data.payload && data.payload.text) {
                    this.addAuditLog(data.payload.text, data.payload.category || 'info');
                }
                break;
            }
            case 'request-audit-log-sync': {
                if (this.isCreator) {
                    const c = this.connections.get(fromId);
                    if (c && (c.open || c._open)) {
                        try { c.send({ type: 'audit-log-sync', payload: this.auditLogs }); } catch {}
                        setTimeout(() => { if (c && (c.open || c._open)) try { c.send({ type: 'audit-log-sync', payload: this.auditLogs }); } catch {} }, 300);
                        setTimeout(() => { if (c && (c.open || c._open)) try { c.send({ type: 'audit-log-sync', payload: this.auditLogs }); } catch {} }, 800);
                    }
                }
                break;
            }
            case 'kick-peer': {
                if (data.payload.targetId === this.myPeerId) {
                    if (typeof UI !== 'undefined') UI.toast('You were removed by the host.', 'error');
                    if (window.app && window.app.leaveRoom) window.app.leaveRoom();
                } else if (this.isCreator) {
                    this._broadcast(data, fromId);
                }
                break;
            }
            case 'promote-admin': {
                const target = this.peers.find(p => p.id === data.payload.targetId);
                if (target) target.isAdmin = true;
                if (data.payload.targetId === this.myPeerId) {
                    this.isAdmin = true;
                    if (typeof UI !== 'undefined') UI.toast('You have been promoted to Admin!', 'success');
                    if (window.app && window.app.updatePrivilegeUI) window.app.updatePrivilegeUI();
                } else if (this.isCreator) {
                    this._broadcast(data, fromId);
                }
                if (window.app && window.app.refreshPeerLists) window.app.refreshPeerLists();
                else if (typeof UI !== 'undefined') UI.updateDevicesList(this.peers, this.myPeerId);
                if (window.app && window.app.renderHostMembersList) window.app.renderHostMembersList();
                break;
            }
            case 'demote-admin': {
                const target = this.peers.find(p => p.id === data.payload.targetId);
                if (target) target.isAdmin = false;
                if (data.payload.targetId === this.myPeerId) {
                    this.isAdmin = false;
                    if (typeof UI !== 'undefined') UI.toast('Your Admin privileges were removed by the Host.', 'info');
                    if (window.app && window.app.updatePrivilegeUI) window.app.updatePrivilegeUI();
                } else if (this.isCreator) {
                    if (data.payload.targetId === fromId) {
                        const senderName = (target && target.deviceName) ? target.deviceName : 'An Admin';
                        this.addAuditLog(`${senderName} stepped down from Admin`, 'sec');
                    }
                    this._broadcast(data, fromId);
                }
                if (window.app && window.app.refreshPeerLists) window.app.refreshPeerLists();
                else if (typeof UI !== 'undefined') UI.updateDevicesList(this.peers, this.myPeerId);
                if (window.app && window.app.renderHostMembersList) window.app.renderHostMembersList();
                break;
            }
            case 'room-deleted': {
                if (typeof UI !== 'undefined') UI.toast('The room was deleted by the host.', 'error');
                if (window.app && window.app.leaveRoom) window.app.leaveRoom();
                break;
            }
            case 'share-personal-key': {
                const actualSender = data.payload.senderId || fromId;
                if (!data.payload.targetId || data.payload.targetId === this.myPeerId) {
                    if (window.app && window.app.crypto) {
                        window.app.crypto.importPeerPersonalKey(actualSender, data.payload.keyStr);
                    }
                }
                if (this.isCreator && data.payload.targetId && data.payload.targetId !== this.myPeerId) {
                    this.sendDirect(data.payload.targetId, { ...data, payload: { ...data.payload, senderId: actualSender } });
                }
                break;
            }
        }
    }

    sendDirect(targetPeerId, message) {
        if (targetPeerId === this.myPeerId) return;
        const msgToSend = { ...message, payload: { ...message.payload, senderId: (message.payload && message.payload.senderId) || this.myPeerId, targetId: targetPeerId } };
        const conn = this.connections.get(targetPeerId);
        if (conn && conn.open) {
            conn.send(msgToSend);
        } else if (!this.isCreator && this.roomCode) {
            // Route through host if not directly connected
            const hostConn = this.connections.get(this._roomCodeToPeerId(this.roomCode));
            if (hostConn && hostConn.open) hostConn.send(msgToSend);
        }
    }

    sendText(payload) {
        const msg = { type: 'text', payload: { ...payload, senderId: this.myPeerId } };
        if (this.isCreator) this._broadcast(msg);
        else { const c = this.connections.get(this._roomCodeToPeerId(this.roomCode)); if (c && c.open) c.send(msg); }
    }

    sendFileEvent(type, payload) {
        const msg = { type, payload: { ...payload, senderId: this.myPeerId } };
        if (this.isCreator) this._broadcast(msg);
        else { const c = this.connections.get(this._roomCodeToPeerId(this.roomCode)); if (c && c.open) c.send(msg); }
    }

    renameDevice(newName) {
        this.myInfo.deviceName = newName;
        const p = this.peers.find(x => x.id === this.myPeerId);
        if (window.app && window.app.refreshPeerLists) window.app.refreshPeerLists();
        else if (typeof UI !== 'undefined') UI.updateDevicesList(this.peers, this.myPeerId);
        const msg = { type: 'peer-rename', payload: { id: this.myPeerId, deviceName: newName } };
        if (this.isCreator) {
            this._broadcast({ type: 'peer-update', payload: this.peers });
        } else if (this.roomCode) {
            const c = this.connections.get(this._roomCodeToPeerId(this.roomCode));
            if (c && c.open) c.send(msg);
        }
    }

    _broadcast(message, excludeId) {
        const recipients = message && message.payload && message.payload.recipients ? message.payload.recipients : null;
        for (const [pid, conn] of this.connections) {
            if (pid !== excludeId && conn && (conn.open || conn._open)) {
                if (recipients && Array.isArray(recipients) && recipients.length > 0) {
                    if (!recipients.includes(pid) && pid !== this._roomCodeToPeerId(this.roomCode) && pid !== (message.payload && message.payload.senderId) && pid !== (message.payload && message.payload.from)) {
                        continue;
                    }
                }
                try { conn.send(message); } catch (e) {}
            }
        }
    }

    async waitForBuffer() {
        for (const conn of this.connections.values()) {
            const dc = conn.dataChannel || conn._dc || (conn.peerConnection && conn.peerConnection.sctp);
            if (dc && 'bufferedAmount' in dc) {
                while (dc.bufferedAmount > 65536) {
                    await new Promise(r => setTimeout(r, 10));
                }
            }
        }
    }

    scheduleHostSuccession(delayMs = 5000) {
        if (this._successionTimer) return;
        if (typeof UI !== 'undefined') {
            UI.toast('Host left. Waiting 5s for host to rejoin...', 'warning');
        }
        this._successionTimer = setTimeout(() => {
            this._successionTimer = null;
            this._handleHostSuccession();
        }, delayMs);
    }

    cancelHostSuccession() {
        if (this._successionTimer) {
            clearTimeout(this._successionTimer);
            this._successionTimer = null;
        }
    }

    _handleHostSuccession() {
        if (!this.peers || this.peers.length === 0 || !this.roomCode) return;
        const hostPeerId = this._roomCodeToPeerId(this.roomCode);
        const remainingPeers = this.peers.filter(p => p.id !== hostPeerId);
        if (remainingPeers.length === 0) return;
        const admins = remainingPeers.filter(p => p.isAdmin);
        const heir = admins.length > 0 ? admins[0] : remainingPeers[0];

        const isMeHeir = (heir && (heir.id === this.myPeerId || heir.deviceName === this.myInfo.deviceName));
        if (isMeHeir) {
            const claimHost = (attempt = 1) => {
                const oldPeer = this.peer;
                if (oldPeer && !oldPeer.destroyed) { try { oldPeer.destroy(); } catch {} }
                this.peer = new Peer(hostPeerId, this._getPeerOptions());
                this.peer.on('open', (id) => {
                    this.myPeerId = id;
                    this.isCreator = true;
                    this.isAdmin = true;
                    this.peers = this.peers.filter(p => p.id !== hostPeerId);
                    const me = this.peers.find(p => p.deviceName === this.myInfo.deviceName || p.id === heir.id);
                    if (me) {
                        me.id = id; me.isCreator = true; me.isAdmin = true;
                    } else {
                        this.peers.unshift({ id: id, ...this.myInfo, isCreator: true, isAdmin: true });
                    }
                    this._broadcast({ type: 'peer-update', payload: this.peers });
                    if (typeof UI !== 'undefined') {
                        UI.toast('You are now the Room Host!', 'success');
                    }
                    if (window.app && window.app.refreshPeerLists) window.app.refreshPeerLists();
                    else if (typeof UI !== 'undefined') UI.updateDevicesList(this.peers, this.myPeerId);
                    if (window.app && window.app.updatePrivilegeUI) window.app.updatePrivilegeUI();
                    if (window.app && window.app.updateMyNameDisplay) window.app.updateMyNameDisplay();
                });
                this.peer.on('connection', (conn) => this._handleIncoming(conn));
                this.peer.on('error', (err) => {
                    if (attempt <= 15) {
                        setTimeout(() => claimHost(attempt + 1), 1500);
                    }
                });
            };
            setTimeout(() => claimHost(1), 300);
        } else if (heir) {
            if (typeof UI !== 'undefined') UI.toast(`${heir.deviceName || 'Admin'} is becoming the new Host...`, 'info');
            const connectToNewHost = (attempt = 1) => {
                if (!this.roomCode || attempt > 15) return;
                const conn = this.peer.connect(hostPeerId, { metadata: { deviceInfo: this.myInfo }, reliable: true });
                let opened = false;
                this._onConnOpen(conn, () => {
                    opened = true;
                    this._register(conn, hostPeerId);
                    const authHash = window.app && window.app.crypto ? window.app.crypto.authHash : null;
                    conn.send({ type: 'peer-info', payload: { id: this.myPeerId, ...this.myInfo, authHash } });
                    if (typeof UI !== 'undefined') UI.toast('Connected to new Host!', 'success');
                });
                setTimeout(() => {
                    if (!opened && attempt <= 15) {
                        connectToNewHost(attempt + 1);
                    }
                }, 1500);
            };
            setTimeout(() => connectToNewHost(1), 1200);
        }
    }

    _startHeartbeat() {
        if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
        this._heartbeatInterval = setInterval(() => {
            if (!this.peer || this.peer.destroyed) return;
            if (this.peer.disconnected) { try { this.peer.reconnect(); } catch {} }
            for (const [peerId, conn] of this.connections.entries()) {
                if (conn && conn.open) { try { conn.send({ type: 'ping', payload: { time: Date.now() } }); } catch {} }
            }
            if (!this.isCreator && this.roomCode) {
                const hostPeerId = this._roomCodeToPeerId(this.roomCode);
                const hostConn = this.connections.get(hostPeerId);
                if (!hostConn || (!hostConn.open && !hostConn._open)) {
                    this._reconnectToHost();
                }
            }
        }, 5000);
    }

    _reconnectToHost() {
        if (!this.roomCode || !this.peer || this.peer.destroyed || this._reconnecting) return;
        this._reconnecting = true;
        setTimeout(() => { this._reconnecting = false; }, 4000);
        try {
            const hostPeerId = this._roomCodeToPeerId(this.roomCode);
            const conn = this.peer.connect(hostPeerId, { metadata: { deviceInfo: this.myInfo }, reliable: true });
            this._onConnOpen(conn, () => {
                this.cancelHostSuccession();
                this._register(conn, hostPeerId);
                const authHash = window.app && window.app.crypto ? window.app.crypto.authHash : null;
                conn.send({ type: 'peer-info', payload: { id: this.myPeerId, ...this.myInfo, authHash } });
            });
        } catch {}
    }

    leaveRoom() {
        if (this._heartbeatInterval) { clearInterval(this._heartbeatInterval); this._heartbeatInterval = null; }
        if (this.isCreator) {
            try { this._broadcast({ type: 'host-leaving' }); } catch {}
        }
        const cleanup = () => {
            for (const conn of this.connections.values()) { try { conn.close(); } catch {} }
            this.connections.clear();
            if (this.peer) { try { this.peer.destroy(); } catch {} this.peer = null; }
            this.roomCode = null; this.isCreator = false; this.peers = []; this.myPeerId = null;
        };
        if (this.isCreator) {
            setTimeout(cleanup, 150);
        } else {
            cleanup();
        }
    }

    getSocketId() { return this.myPeerId; }
    isConnected() { return this.peer && !this.peer.destroyed; }
    getRoomCode() { return this.roomCode; }
    getPeers() { return this.peers; }
}
window.ConnectionManager = ConnectionManager;
