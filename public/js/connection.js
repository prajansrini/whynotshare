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
            this.peer = new Peer(peerId);
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
            this.peer = new Peer();
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
            this.peers = this.peers.filter(p => p.id !== peerId);
            if (this.onPeerLeft) this.onPeerLeft(peer || { id: peerId, deviceName: 'Unknown' });
            if (this.isCreator) this._broadcast({ type: 'peer-update', payload: this.peers }, peerId);
        });
    }

    _onMessage(data, fromId) {
        switch (data.type) {
            case 'peer-info': {
                const info = data.payload;
                const ex = this.peers.find(p => p.id === info.id);
                if (!ex) this.peers.push(info); else Object.assign(ex, info);
                if (this.onPeerJoined) this.onPeerJoined(info);
                if (this.isCreator) this._broadcast({ type: 'peer-update', payload: this.peers });
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
            case 'text': {
                const sid = data.payload.senderId || fromId;
                if (sid === this.myPeerId) break;
                if (this.onTextReceived) this.onTextReceived({ from: sid, encrypted: data.payload.encrypted, timestamp: data.payload.timestamp, raw: data.payload.raw });
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

    leaveRoom() {
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
