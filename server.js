require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const RoomManager = require('./server/roomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: 1e8 // 100MB for file chunks
});

const PORT = process.env.PORT || 3000;
const MAX_PEERS = parseInt(process.env.MAX_PEERS_PER_ROOM) || 10;
const EXPIRY = parseInt(process.env.ROOM_EXPIRY_MINUTES) || 60;

const roomManager = new RoomManager(MAX_PEERS, EXPIRY);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API: get server network info (so clients know the local IP)
app.get('/api/info', (req, res) => {
    const nets = os.networkInterfaces();
    const addresses = [];
    for (const iface of Object.values(nets)) {
        for (const net of iface) {
            if (net.family === 'IPv4' && !net.internal) {
                addresses.push(net.address);
            }
        }
    }
    res.json({ port: PORT, addresses, stats: roomManager.getStats() });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`[+] Connected: ${socket.id}`);

    // Create a new room
    socket.on('create-room', (deviceInfo, callback) => {
        // Leave any existing room first
        const existing = roomManager.getRoomBySocket(socket.id);
        if (existing) {
            socket.leave(existing);
            roomManager.leaveRoom(socket.id);
        }

        const code = roomManager.createRoom(socket.id, deviceInfo);
        socket.join(code);
        console.log(`[Room] Created: ${code} by ${deviceInfo.deviceName}`);
        callback({ code });
    });

    // Join an existing room
    socket.on('join-room', (data, callback) => {
        const { code, deviceInfo } = data;

        // Leave any existing room first
        const existing = roomManager.getRoomBySocket(socket.id);
        if (existing) {
            socket.leave(existing);
            const left = roomManager.leaveRoom(socket.id);
            if (left) io.to(existing).emit('peer-left', { peerId: socket.id });
        }

        const result = roomManager.joinRoom(code, socket.id, deviceInfo);
        if (result.error) {
            callback({ error: result.error });
            return;
        }

        socket.join(code);
        console.log(`[Room] ${deviceInfo.deviceName} joined ${code}`);

        // Notify existing peers about new joiner
        socket.to(code).emit('peer-joined', {
            peerId: socket.id,
            deviceName: deviceInfo.deviceName,
            deviceType: deviceInfo.deviceType,
            browser: deviceInfo.browser,
            os: deviceInfo.os
        });

        // Send back the list of all peers (including self)
        callback({ success: true, peers: result.peers });
    });

    // Text message (E2E encrypted — server just relays the blob)
    socket.on('send-text', (data) => {
        const roomCode = roomManager.getRoomBySocket(socket.id);
        if (!roomCode) return;
        roomManager.touch(roomCode);

        // Relay encrypted message to all other peers in the room
        socket.to(roomCode).emit('receive-text', {
            from: socket.id,
            encrypted: data.encrypted, // { ciphertext, iv } — server can't read this
            timestamp: Date.now()
        });
    });

    // WebRTC signaling relay (for Phase 4+)
    socket.on('signal', (data) => {
        const { targetId, signal } = data;
        io.to(targetId).emit('signal', {
            from: socket.id,
            signal
        });
    });

    // File transfer events (server relay fallback)
    socket.on('file-meta', (data) => {
        const roomCode = roomManager.getRoomBySocket(socket.id);
        if (!roomCode) return;
        roomManager.touch(roomCode);
        socket.to(roomCode).emit('file-meta', {
            from: socket.id,
            ...data
        });
    });

    socket.on('file-chunk', (data) => {
        const roomCode = roomManager.getRoomBySocket(socket.id);
        if (!roomCode) return;
        socket.to(roomCode).emit('file-chunk', {
            from: socket.id,
            ...data
        });
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        const result = roomManager.leaveRoom(socket.id);
        if (result) {
            io.to(result.code).emit('peer-left', {
                peerId: socket.id,
                remainingPeers: result.remainingPeers
            });
            console.log(`[-] ${socket.id} left room ${result.code}`);
        }
        console.log(`[-] Disconnected: ${socket.id}`);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║         WhyNotShare — Server Running     ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Local:    http://localhost:${PORT}          ║`);
    for (const iface of Object.values(nets)) {
        for (const net of iface) {
            if (net.family === 'IPv4' && !net.internal) {
                const url = `http://${net.address}:${PORT}`;
                console.log(`║  Network:  ${url.padEnd(28)}║`);
            }
        }
    }
    console.log('╠══════════════════════════════════════════╣');
    console.log('║  Open the URL above on any device to     ║');
    console.log('║  start sharing!                          ║');
    console.log('╚══════════════════════════════════════════╝\n');
});
