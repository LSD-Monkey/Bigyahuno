const crypto = require('crypto');
const Game = require('./Game');
const Player = require('./Player');
const { MAX_PLAYERS, RECONNECT_GRACE } = require('./constants');

class RoomManager {
    constructor() {
        this.rooms = new Map;
        // Track reconnect secrets for security
        this.reconnectSecrets = new Map();
    }

    code() {
        let c;
        do {
            c = crypto.randomBytes(3).toString('hex').toUpperCase();
        } while (this.rooms.has(c));
        return c;
    }
    
    create(n) {
        let id = crypto.randomUUID(), 
            code = this.code(),
            game = new Game(code, id);
        game.addPlayer(new Player(id, n));
        this.rooms.set(code, game);
        
        // Generate and store reconnect secret for the host
        const secret = crypto.randomBytes(16).toString('hex');
        this.reconnectSecrets.set(code, { 
            hostId: id,
            secret: secret,
            createdAt: Date.now()
        });
        
        return {game, playerId: id};
    }
    
    join(code, n) {
        let g = this.rooms.get(String(code || '').toUpperCase());
        if (!g || g.started || g.players.size >= MAX_PLAYERS) return null;
        let id = crypto.randomUUID();
        g.addPlayer(new Player(id, n));
        
        // Generate reconnect secret for new player
        const secret = crypto.randomBytes(16).toString('hex');
        this.reconnectSecrets.set(`${code}-${id}`, { 
            playerId: id,
            secret: secret,
            createdAt: Date.now()
        });
        
        return {game: g, playerId: id};
    }
    
    rejoin(code, id) {
        let g = this.rooms.get(String(code || '').toUpperCase());
        if (!g) return null;
        
        // Check for valid reconnect secrets
        const secretEntry = this.reconnectSecrets.get(`${code}-${id}`);
        if (secretEntry && Date.now() - secretEntry.createdAt > 10 * 60 * 1000) {
            // Secret expired, remove it
            this.reconnectSecrets.delete(`${code}-${id}`);
            return null;
        }
        
        let p = g.players.get(id);
        if (!p) return null;
        p.connected = true;
        return {game: g, playerId: id};
    }
    
    scheduleCleanup(g) {
        setTimeout(() => {
            if (!g.list.some(p => p.connected)) this.rooms.delete(g.code);
            
            // Clean up reconnect secrets for this room
            for (const [key, value] of this.reconnectSecrets.entries()) {
                if (key.startsWith(`${g.code}-`)) {
                    this.reconnectSecrets.delete(key);
                }
            }
        }, RECONNECT_GRACE);
    }
}

module.exports = RoomManager;