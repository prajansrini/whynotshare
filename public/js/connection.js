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
        this._startHeartbeat();
    }

    _roomCodeToPeerId(code) { return 'wns-' + code.replace(/-/g, '').toUpperCase(); }

    _generateRoomCode() {
        const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) code += c[Math.floor(Math.random() * c.length)];
        return code.slice(0, 3) + '-' + code.slice(3);
    }

    connect() { if (this.onConnected) this.onConnected(); }

    createRoom(existingCode) {
        const code = existingCode || this._generateRoomCode();
        const peerId = this._roomCodeToPeerId(code);
        return new Promise((resolve, reject) => {
            if (this.peer) { try { this.peer.destroy(); } catch {} }
            this.peer = new Peer(peerId, { pingInterval: 5000 });
            this.peer.on('open', (id) => {
                this.myPeerId = id;
                this.roomCode = code;
                this.isCreator = true;
                this.peers = [{ id, ...this.myInfo, isCreator: true }];
                resolve(code);
            });
            this.peer.on('connection', (conn) => this._handleIncoming(conn));
            this.peer.on('error', (err) => {
                if (err.type === 'unavailable-id') reject(new Error('Room code taken. Try again.'));
                else reject(new Error(err.message || 'Connection failed'));
            });
            this.peer.on('disconnected', () => { if (this.peer && !this.peer.destroyed) this.peer.reconnect(); });
        });
    }

    joinRoom(code) {
        const hostPeerId = this._roomCodeToPeerId(code);
        return new Promise((resolve, reject) => {
            this.peer = new Peer(undefined, { pingInterval: 5000 });
            let settled = false;
            this.peer.on('open', (id) => {
                this.myPeerId = id;
                this.roomCode = code;
                this.isCreator = false;
                const conn = this.peer.connect(hostPeerId, { metadata: { deviceInfo: this.myInfo }, reliable: true });
                conn.on('open', () => {
                    if (settled) return; settled = true;
                    this._register(conn, hostPeerId);
                    conn.send({ type: 'peer-info', payload: { id, ...this.myInfo } });
                    this.peers = [
                        { id: hostPeerId, deviceName: 'Room Host', deviceType: 'laptop', isCreator: true },
                        { id, ...this.myInfo, isCreator: false }
                    ];
                    resolve(this.peers);
                });
                conn.on('error', () => { if (!settled) { settled = true; reject(new Error('Connection failed')); } });
                setTimeout(() => { if (!settled) { settled = true; reject(new Error('Timed out. Room may not exist.')); } }, 12000);
            });
            this.peer.on('error', (err) => {
                if (!settled) { settled = true;
                    reject(new Error(err.type === 'peer-unavailable' ? 'Room not found.' : (err.message || 'Failed')));
                }
            });
        });
    }

    _handleIncoming(conn) {
        conn.on('open', () => {
            this._register(conn, conn.peer);
            if (this.isCreator) conn.send({ type: 'host-info', payload: { id: this.myPeerId, ...this.myInfo, isCreator: true } });
        });
    }

    _register(conn, peerId) {
        this.connections.set(peerId, conn);
        conn.on('data', (data) => this._onMessage(data, peerId));
        conn.on('close', () => {
            this.connections.delete(peerId);
            const peer = this.peers.find(p => p.id === peerId);
            const wasCreator = peer ? peer.isCreator : (peerId === this._roomCodeToPeerId(this.roomCode));
            this.peers = this.peers.filter(p => p.id !== peerId);
            if (this.onPeerLeft) this.onPeerLeft(peer || { id: peerId, deviceName: 'Unknown' });
            if (this.isCreator) {
                this._broadcast({ type: 'peer-update', payload: this.peers }, peerId);
            } else if (wasCreator && this.peers.length > 0) {
                this._handleHostSuccession();
            }
        });
    }

    _onMessage(data, fromId) {
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
                const info = data.payload;
                const ex = this.peers.find(p => p.id === info.id);
                if (!ex) this.peers.push(info); else Object.assign(ex, info);
                if (this.onPeerJoined) this.onPeerJoined(info);
                if (this.isCreator) {
                    this._broadcast({ type: 'peer-update', payload: this.peers });
                    if (this.onSyncRequest) {
                        const history = this.onSyncRequest();
                        if (history && history.length > 0) {
                            const c = this.connections.get(fromId);
                            if (c && c.open) c.send({ type: 'chat-history', payload: history });
                        }
                    }
                }
                break;
            }
            case 'host-info': {
                const hi = data.payload;
                const idx = this.peers.findIndex(p => p.id === hi.id);
                if (idx >= 0) this.peers[idx] = hi; else this.peers.unshift(hi);
                if (this.onPeerJoined) this.onPeerJoined(hi);
                break;
            }
            case 'peer-update':
                this.peers = data.payload;
                if (!this.peers.find(p => p.id === this.myPeerId))
                    this.peers.push({ id: this.myPeerId, ...this.myInfo, isCreator: false });
                UI.updateDevicesList(this.peers, this.myPeerId);
                break;
            case 'chat-history': {
                if (this.onHistoryReceived) this.onHistoryReceived(data.payload);
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
                    if (typeof UI !== 'undefined') {
                        UI.updateDevicesList(this.peers, this.myPeerId);
                    }
                    if (this.isCreator) this._broadcast({ type: 'peer-update', payload: this.peers });
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
                if (this.isCreator) this._broadcast(data, fromId);
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
                if (typeof UI !== 'undefined') UI.updateDevicesList(this.peers, this.myPeerId);
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
        if (p) p.deviceName = newName;
        if (typeof UI !== 'undefined') UI.updateDevicesList(this.peers, this.myPeerId);
        const msg = { type: 'peer-rename', payload: { id: this.myPeerId, deviceName: newName } };
        if (this.isCreator) {
            this._broadcast({ type: 'peer-update', payload: this.peers });
        } else if (this.roomCode) {
            const c = this.connections.get(this._roomCodeToPeerId(this.roomCode));
            if (c && c.open) c.send(msg);
        }
    }

    _broadcast(message, excludeId) {
        for (const [pid, conn] of this.connections) {
            if (pid !== excludeId && conn.open) conn.send(message);
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

    _handleHostSuccession() {
        if (!this.peers || this.peers.length === 0) return;
        const admins = this.peers.filter(p => p.isAdmin);
        const heir = admins.length > 0 ? admins[0] : this.peers[0];

        if (heir && heir.id === this.myPeerId) {
            setTimeout(() => {
                const hostPeerId = this._roomCodeToPeerId(this.roomCode);
                const oldPeer = this.peer;
                this.peer = new Peer(hostPeerId, { pingInterval: 5000 });
                this.peer.on('open', (id) => {
                    this.myPeerId = id;
                    this.isCreator = true;
                    this.isAdmin = true;
                    if (oldPeer && !oldPeer.destroyed) { try { oldPeer.destroy(); } catch {} }
                    const me = this.peers.find(p => p.id === heir.id || p.deviceName === this.myInfo.deviceName);
                    if (me) { me.id = id; me.isCreator = true; me.isAdmin = true; }
                    if (typeof UI !== 'undefined') {
                        UI.toast('You are now the Room Host!', 'info');
                        UI.updateDevicesList(this.peers, this.myPeerId);
                    }
                    if (window.app && window.app.updatePrivilegeUI) window.app.updatePrivilegeUI();
                    if (window.app && window.app.updateMyNameDisplay) window.app.updateMyNameDisplay();
                });
                this.peer.on('connection', (conn) => this._handleIncoming(conn));
            }, 600);
        } else if (heir) {
            if (typeof UI !== 'undefined') UI.toast(`${heir.deviceName || 'Admin'} is becoming the new Host...`, 'info');
            setTimeout(() => {
                const hostPeerId = this._roomCodeToPeerId(this.roomCode);
                const conn = this.peer.connect(hostPeerId, { metadata: { deviceInfo: this.myInfo }, reliable: true });
                conn.on('open', () => {
                    this._register(conn, hostPeerId);
                    conn.send({ type: 'peer-info', payload: { id: this.myPeerId, ...this.myInfo } });
                    if (typeof UI !== 'undefined') UI.toast('Connected to new Host!', 'success');
                });
            }, 2500);
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
                if (!this.connections.has(hostPeerId) || !this.connections.get(hostPeerId).open) {
                    this._reconnectToHost();
                }
            }
        }, 10000);
    }

    _reconnectToHost() {
        if (!this.roomCode || !this.peer || this.peer.destroyed || this._reconnecting) return;
        this._reconnecting = true;
        setTimeout(() => { this._reconnecting = false; }, 5000);
        try {
            const hostPeerId = this._roomCodeToPeerId(this.roomCode);
            const conn = this.peer.connect(hostPeerId, { metadata: { deviceInfo: this.myInfo }, reliable: true });
            conn.on('open', () => {
                this._register(conn, hostPeerId);
                conn.send({ type: 'peer-info', payload: { id: this.myPeerId, ...this.myInfo } });
            });
        } catch {}
    }

    leaveRoom() {
        if (this._heartbeatInterval) { clearInterval(this._heartbeatInterval); this._heartbeatInterval = null; }
        for (const conn of this.connections.values()) conn.close();
        this.connections.clear();
        if (this.peer) { this.peer.destroy(); this.peer = null; }
        this.roomCode = null; this.isCreator = false; this.peers = []; this.myPeerId = null;
    }

    getSocketId() { return this.myPeerId; }
    isConnected() { return this.peer && !this.peer.destroyed; }
    getRoomCode() { return this.roomCode; }
    getPeers() { return this.peers; }
}
window.ConnectionManager = ConnectionManager;
