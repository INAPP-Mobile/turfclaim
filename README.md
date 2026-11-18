# TurfClaim

A tiny multiplayer territory strategy game for humans and agents. Turn-based, 2-4 players, matches run under 10 minutes. Humans play in the browser at the public URL with no install and no login; agents play through a simple HTTP/JSON API. A sample bot is included in `bot/`.

## Rules

2-4 players take turns claiming cells on a 6x6 grid where every cell is worth 1-3 points (values are visible). On your turn you claim one empty cell or pass. Your score is the sum over your connected groups (4-connected) of (group cell values x group size), so connected clusters multiply their points and a single bridge cell that merges two of your groups is extremely valuable. The game ends when the board is full or every player passes in a row; the highest score wins, ties broken by cells claimed. Because big clusters multiply, every turn is a real decision: grab high-value cells, grow your own cluster toward a merge, or block an opponent's bridge.

## Run locally

Requires Node 18+ (uses only the standard library, no `npm install` needed).

```bash
node server.js
# listening on 3000 (or $PORT)
```

Open http://localhost:3000 in a browser. Create a lobby, share the 6-letter code, add bots to fill empty seats, and press Start.

## Sample bot

```bash
# Create a lobby as SampleBot, add 2 server bots, start, and play the whole game:
node bot/bot.js http://localhost:3000 --new SampleBot --bots 2

# Join someone else's lobby by code and play when the host starts:
node bot/bot.js http://localhost:3000 --join KQ7X2P MyBot

# Play an existing game you hold a token for:
node bot/bot.js http://localhost:3000 --play {gameId} {token} {name}
```

The sample bot uses a greedy heuristic (own immediate score gain plus half the best opponent gain denied on the cell) with a small random tiebreak. The server's built-in lobby bots use the same heuristic, so the sample bot is competitive but beatable.

## API docs

Base URL is the game URL. All request/response bodies are JSON.

### Health

```
GET /api/health
-> { "ok": true, "games": 3 }
```

### Create a game

`players` is an array of 2-4 names (strings) or `{ "name", "bot": true }` objects for server-driven bot seats. Pass `"lobby": true` to create a joinable lobby instead of starting immediately. The response includes a secret `token` per player - keep it private, it authorizes that player's moves.

```bash
curl -s -X POST $BASE/api/games \
  -H 'Content-Type: application/json' \
  -d '{"players": ["Alice", {"name": "TurfBot-1", "bot": true}]}'
# -> { "gameId": "...", "code": "KQ7X2P", "status": "playing",
#      "players": [{"name":"Alice","bot":false,"token":"..."}, ...],
#      "state": { ... } }

curl -s -X POST $BASE/api/games \
  -H 'Content-Type: application/json' \
  -d '{"players": ["Alice"], "lobby": true}'
# -> lobby with code; others join via /api/join, then POST /api/games/{id}/start
```

### List games

```bash
curl -s "$BASE/api/games?status=lobby"
# -> { "games": [{"gameId":"...","code":"KQ7X2P","status":"lobby","players":["Alice"],"seats":1}] }
```

### Join a lobby by code

```bash
curl -s -X POST $BASE/api/join \
  -H 'Content-Type: application/json' \
  -d '{"code": "KQ7X2P", "name": "Bob"}'
# -> { "gameId": "...", "code": "KQ7X2P", "token": "...", "name": "Bob",
#      "playerIndex": 1, "state": { ... } }
```

### Lobby management

```bash
# Add a server bot to an open lobby (fills empty seats; bots move automatically)
curl -s -X POST $BASE/api/games/{gameId}/bots \
  -H 'Content-Type: application/json' -d '{"name": "TurfBot-2"}'

# Start the game (needs 2-4 players)
curl -s -X POST $BASE/api/games/{gameId}/start
```

### Read game state

```bash
curl -s $BASE/api/games/{gameId}
```

Returns:

```json
{
  "gameId": "...", "code": "KQ7X2P", "size": 6,
  "values": [[3,1,2,1,3,2], "..."],
  "board": [[0,null,1,null,null,null], "..."],
  "players": [{"name":"Alice","bot":false,"score":42,"cells":5}, "..."],
  "turnIndex": 1, "turnPlayer": "Bob",
  "status": "playing", "passes": 0, "winner": null,
  "log": [{"n":1,"player":"Alice","move":"C2","row":1,"col":2}, "..."]
}
```

`board[r][c]` is the owning player index or `null`. `values[r][c]` is the cell's point value (1-3). `winner` is `null` until the game finishes, then `{ "names": [...], "scores": [...], "cells": [...], "tied": false }`. Player `token`s are never exposed here.

### Submit a move

Rows and columns are 0-indexed. It must be your turn and the game must be playing.

```bash
# Claim cell row 1, column 2
curl -s -X POST $BASE/api/games/{gameId}/move \
  -H 'Content-Type: application/json' \
  -d '{"token": "{your-token}", "row": 1, "col": 2}'
# -> { "ok": true, "state": { ...updated state... } }

# Pass
curl -s -X POST $BASE/api/games/{gameId}/move \
  -H 'Content-Type: application/json' \
  -d '{"token": "{your-token}", "pass": true}'
```

Error responses use HTTP 4xx with `{ "error": "{reason}" }` (not your turn, cell taken, out of bounds, bad token, game not playing, bot seats move automatically).

### Full move log

```bash
curl -s $BASE/api/games/{gameId}/log
# -> { "gameId": "...", "log": [ ...every move, oldest first... ] }
```

## Agent play loop (pseudocode)

```
game = POST /api/games {players: ["MyBot", {name: "Opp", bot: true}]}
token = game.players[0].token
loop:
  st = GET /api/games/{gameId}
  if st.status == "finished": break  # st.winner has the result
  if st.players[st.turnIndex].name == "MyBot":
    (r, c) = pick_cell(st)           # e.g. greedy score gain, see bot/bot.js
    POST /api/games/{gameId}/move {token, row: r, col: c}
  sleep(1s)
```

## Deploy notes

The app is a single Node process with zero dependencies and in-memory state, so it fits comfortably on a free-tier host. It listens on `$PORT` (defaults to 3000) and exposes `/api/health` for health checks.

Railway: create a project from this repo (or `railway up` from this directory); the included `railway.json` sets the Nixpacks builder, `node server.js` as the start command, and `/api/health` as the healthcheck path. Generate a public domain for the service - no environment variables are required.

## Repo layout

```
server.js        # game engine + HTTP/JSON API + static file server (zero deps)
public/          # browser UI: index.html, style.css, app.js
bot/bot.js       # sample agent bot (plays via the HTTP API)
railway.json     # Railway deploy config
package.json     # start script
```
