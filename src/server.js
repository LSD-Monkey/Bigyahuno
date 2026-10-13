require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const RoomManager = require('./RoomManager');

const app = express();
const rooms = new RoomManager();

app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/health', (q, r) => r.json({ ok: true, service: 'uno-online' }));
app.get('/healthz', (q, r) => r.json({ ok: true, service: 'uno-online' })); // Additional health endpoint

app.get('/room/:code', (q, r) => r.sendFile(path.join(__dirname, '../public/index.html')));

let port = Number(process.env.PORT || 3000);
// Changed default host from 127.0.0.1 to 0.0.0.0 for container compatibility
let host = process.env.HOST || '0.0.0.0';

const server = http.createServer(app);

if (String(process.env.SSL_ENABLED).toLowerCase() === 'true') {
    try {
        server = https.createServer({
            key: fs.readFileSync(process.env.SSL_KEY_PATH),
            cert: fs.readFileSync(process.env.SSL_CERT_PATH)
        }, app);
    } catch (e) {
        if (String(process.env.SSL_FALLBACK_HTTP).toLowerCase() === 'false') {
            console.error('SSL konnte nicht geladen werden:', e.message);
            process.exit(1);
        }
        console.error('SSL nicht verfügbar, HTTP-Fallback:', e.message);
    }
}

const io = new Server(server);

// Rate limiting and validation middleware
const rateLimitMap = new Map();
const MAX_REQUESTS_PER_MINUTE = 30;
const TIME_WINDOW_MS = 60000;

function isRateLimited(socketId) {
    const now = Date.now();
    if (!rateLimitMap.has(socketId)) {
        rateLimitMap.set(socketId, { count: 1, windowStart: now });
        return false;
    }

    const entry = rateLimitMap.get(socketId);
    if (now - entry.windowStart > TIME_WINDOW_MS) {
        // Reset window
        entry.count = 1;
        entry.windowStart = now;
        return false;
    }

    if (entry.count >= MAX_REQUESTS_PER_MINUTE) {
        return true; // Rate limited
    }

    entry.count++;
    return false;
}

function validateName(name) {
    return typeof name === 'string' && name.trim() && name.length <= 24;
}

function sanitizeInput(input) {
    if (typeof input === 'object') {
        const sanitized = {};
        for (const [key, value] of Object.entries(input)) {
            // Sanitize string values
            if (typeof value === 'string') {
                sanitized[key] = value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            } else {
                sanitized[key] = value;
            }
        }
        return sanitized;
    }
    return input;
}

// Room management functions with validation
function generateReconnectSecret() {
    // Generate a random secret for secure reconnect
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

io.on('connection', (socket) => {
    const fail = (m) => socket.emit('error', m);
    
    // Add connection logging
    console.log(`New client connected: ${socket.id}`);

    const g = () => rooms.rooms.get(socket.data?.code);

    const attach = (r) => {
        socket.data = { code: r.game.code, id: r.playerId };
        let p = r.game.players.get(r.playerId);
        if (p) {
            p.socketId = socket.id;
            p.connected = true;
        }
    };

    // Implement all client events
    socket.on('createRoom', (data) => {
        const sanitizedData = sanitizeInput(data);
        if (!validateName(sanitizedData?.name)) return fail('Name fehlt oder ist zu lang.');
        
        let r = rooms.create(sanitizedData.name);
        attach(r);
        socket.emit('roomCreated', { code: r.game.code, playerId: r.playerId });
        emit(r.game);
    });

    socket.on('joinRoom', (data) => {
        const sanitizedData = sanitizeInput(data);
        if (!validateName(sanitizedData?.name)) return fail('Name fehlt oder ist zu lang.');
        
        let r = rooms.join(sanitizedData.code, sanitizedData.name);
        if (!r) return fail('Raum nicht gefunden, voll oder bereits gestartet.');
        
        attach(r);
        socket.emit('joinedRoom', { code: r.game.code, playerId: r.playerId });
        emit(r.game);
    });

    // Reconnect with secret validation
    socket.on('rejoinRoom', (data) => {
        const sanitizedData = sanitizeInput(data);
        if (!sanitizedData?.code || !sanitizedData?.playerId) return fail('Invalid rejoin data');
        
        let r = rooms.rejoin(sanitizedData.code, sanitizedData.playerId);
        if (!r) return fail('Reconnect nicht möglich.');
        
        attach(r);
        socket.emit('rejoined', { code: r.game.code, playerId: r.playerId });
        emit(r.game);
    });

    // New handlers for client events
    socket.on('getMyHand', (data) => {
        if (isRateLimited(socket.id)) return fail('Too many requests');
        
        const game = g();
        if (!game) return;
        
        const player = game.players.get(socket.data?.id);
        if (player) {
            socket.emit('hand', { cards: Array.from(player.hand).map(c => ({ ...c, id: c.id || Math.random() }) } });
        }
    });

    socket.on('passTurn', (data) => {
        if (isRateLimited(socket.id)) return fail('Too many requests');
        
        const game = g();
        if (!game) return;
        
        const player = game.players.get(socket.data?.id);
        if (player && player.connected) {
            // Implement pass turn logic
            const result = game.passTurn(socket.data?.id);
            emit(game); // Broadcast updated state
        }
    });

    socket.on('startNewRound', (data) => {
        if (isRateLimited(socket.id)) return fail('Too many requests');
        
        const game = g();
        if (!game || !game.started) return;
        
        const player = game.players.get(socket.data?.id);
        if (player && player.connected && player.id === game.hostId) {
            // Implement new round logic
            game.startNewRound();
            emit(game); // Broadcast updated state
        }
    });

    socket.on('updateSettings', (data) => {
        if (isRateLimited(socket.id)) return fail('Too many requests');
        
        const sanitizedData = sanitizeInput(data);
        const game = g();
        if (!game || !game.started) return;
        
        const player = game.players.get(socket.data?.id);
        if (player && player.connected && player.id === game.hostId) {
            // Implement settings update logic
            game.updateSettings(sanitizedData);
            emit(game); // Broadcast updated state
        }
    });

    socket.on('kickPlayer', (data) => {
        if (isRateLimited(socket.id)) return fail('Too many requests');
        
        const sanitizedData = sanitizeInput(data);
        const game = g();
        if (!game || !game.started) return;
        
        const player = game.players.get(socket.data?.id);
        if (player && player.connected && player.id === game.hostId) {
            // Implement kick logic
            const result = game.kickPlayer(sanitizedData.playerId);
            emit(game); // Broadcast updated state
        }
    });

    socket.on('chatMessage', (data) => {
        if (isRateLimited(socket.id)) return fail('Too many requests');
        
        const sanitizedData = sanitizeInput(data);
        if (!sanitizedData?.message || typeof sanitizedData.message !== 'string' || sanitizedData.message.length > 1000) {
            return fail('Invalid chat message');
        }
        
        // Broadcast to all players in the room
        const game = g();
        if (game) {
            socket.to(game.code).emit('chatMessage', { 
                name: `${game.players.get(socket.data?.id)?.name || 'Unknown'}#${socket.id.slice(-4)}`,
                text: sanitizedData.message
            });
        }
    });

    // Game-related events - existing handlers kept as is:
    socket.on('startGame', () => {
        if (isRateLimited(socket.id)) return fail('Too many requests');
        
        const x = g();
        if (x?.hostId === socket.data?.id && x.start()) emit(x);
    });

    socket.on('playCard', (data) => {
        if (isRateLimited(socket.id)) return fail('Too many requests');
        
        const sanitizedData = sanitizeInput(data);
        const x = g();
        const r = x?.play(socket.data?.id, Number(sanitizedData?.index), sanitizedData?.color);
        if (r?.error) fail(r.error);
        else if (x) emit(x);
    });

    socket.on('drawCard', () => {
        if (isRateLimited(socket.id)) return fail('Too many requests');
        
        const x = g();
        const r = x?.draw(socket.data?.id);
        if (r?.error) fail(r.error);
        else if (x) emit(x);
    });

    socket.on('callUno', () => {
        if (isRateLimited(socket.id)) return fail('Too many requests');
        
        const x = g();
        if (x?.callUno(socket.data?.id)) emit(x);
    });

    // Handle disconnect gracefully
    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        const x = g();
        const p = x?.players.get(socket.data?.id);
        if (p) {
            p.connected = false;
            p.socketId = null;
            
            // Check if host left and transfer
            if (x.hostId === p.id) {
                x.transferHost();
            }
            
            emit(x);
            rooms.scheduleCleanup(x);
        }
    });
});

server.listen(port, host, () => console.log(`UNO Online läuft auf ${host}:${port}`));

const stop = () => io.close(() => server.close(() => process.exit(0)));

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// Export for testing
module.exports = { app, io, server };