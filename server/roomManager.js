class RoomManager {
    constructor(maxPeers = 10, expiryMinutes = 60) {
        this.rooms = new Map();
        this.maxPeers = maxPeers;
        this.expiryMinutes = expiryMinutes;
        // Cleanup stale rooms every 5 minutes
        setInterval(() => this._cleanup(), 5 * 60 * 1000);
    }

    _generateCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        // Format as XXX-XXX
        return code.slice(0, 3) + '-' + code.slice(3);
    }

    createRoom(socketId, deviceInfo) {
        let code;
        do { code = this._generateCode(); } while (this.rooms.has(code));

        const room = {
            code,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            peers: new Map()
        };
        room.peers.set(socketId, {
            id: socketId,
            ...deviceInfo,
            joinedAt: Date.now(),
            isCreator: true
        });
        this.rooms.set(code, room);
        return code;
    }

    joinRoom(code, socketId, deviceInfo) {
        const room = this.rooms.get(code);
        if (!room) return { error: 'Room not found' };
        if (room.peers.size >= this.maxPeers) return { error: 'Room is full' };
        if (room.peers.has(socketId)) return { error: 'Already in room' };

        room.peers.set(socketId, {
            id: socketId,
            ...deviceInfo,
            joinedAt: Date.now(),
            isCreator: false
        });
        room.lastActivity = Date.now();
        return { success: true, peers: this.getPeers(code) };
    }

    leaveRoom(socketId) {
        for (const [code, room] of this.rooms) {
            if (room.peers.has(socketId)) {
                room.peers.delete(socketId);
                room.lastActivity = Date.now();
                if (room.peers.size === 0) {
                    // Keep empty room for 2 min for reconnect
                    setTimeout(() => {
                        const r = this.rooms.get(code);
                        if (r && r.peers.size === 0) this.rooms.delete(code);
                    }, 2 * 60 * 1000);
                }
                return { code, remainingPeers: this.getPeers(code) };
            }
        }
        return null;
    }

    getRoomBySocket(socketId) {
        for (const [code, room] of this.rooms) {
            if (room.peers.has(socketId)) return code;
        }
        return null;
    }

    getPeers(code) {
        const room = this.rooms.get(code);
        if (!room) return [];
        return Array.from(room.peers.values()).map(p => ({
            id: p.id, deviceName: p.deviceName, deviceType: p.deviceType,
            browser: p.browser, os: p.os, isCreator: p.isCreator
        }));
    }

    roomExists(code) {
        return this.rooms.has(code);
    }

    touch(code) {
        const room = this.rooms.get(code);
        if (room) room.lastActivity = Date.now();
    }

    _cleanup() {
        const now = Date.now();
        const expiry = this.expiryMinutes * 60 * 1000;
        for (const [code, room] of this.rooms) {
            if (now - room.lastActivity > expiry) {
                this.rooms.delete(code);
            }
        }
    }

    getStats() {
        let totalPeers = 0;
        for (const room of this.rooms.values()) totalPeers += room.peers.size;
        return { rooms: this.rooms.size, peers: totalPeers };
    }
}

module.exports = RoomManager;
