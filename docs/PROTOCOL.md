# UNO Online Protocol

## Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `createRoom` | `{ name: string }` | Create a new game room |
| `joinRoom` | `{ name: string, code: string }` | Join an existing room |
| `rejoinRoom` | `{ code: string, playerId: string }` | Reconnect to a room |
| `getMyHand` | `null` | Request current player's hand |
| `passTurn` | `null` | Pass turn to next player |
| `startNewRound` | `null` | Start new round (host only) |
| `updateSettings` | `{ stacking: boolean }` | Update game settings (host only) |
| `kickPlayer` | `{ playerId: string }` | Kick a player from the room (host only) |
| `chatMessage` | `{ message: string }` | Send chat message |
| `startGame` | `null` | Start the game (host only) |
| `playCard` | `{ index: number, color?: string }` | Play a card |
| `drawCard` | `null` | Draw a card |
| `callUno` | `null` | Call UNO |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `roomCreated` | `{ code: string, playerId: string }` | Room creation confirmation |
| `joinedRoom` | `{ code: string, playerId: string }` | Join room confirmation |
| `rejoined` | `{ code: string, playerId: string }` | Reconnect confirmation |
| `state` | `GameState` | Full game state update |
| `hand` | `{ cards: Card[] }` | Player's hand data |
| `error` | `{ message: string }` | Error notification |
| `chatMessage` | `{ name: string, text: string }` | Chat message from another player |

## Reconnect Security

To prevent session hijacking:
1. Each reconnect request must include both room code and player ID
2. A secret token is generated upon connection for secure reconnection verification
3. The server validates that the secret matches before allowing reconnection

## Rate Limits

- Maximum 30 requests per minute per client
- Requests are rate-limited to prevent abuse of the API