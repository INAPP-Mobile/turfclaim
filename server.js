const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOARD_SIZE = 6;
const BOT_MOVE_DELAY_MS = 700;

const games = new Map();   // id -> game
const codeIndex = new Map(); // code -> id

function newId() { return crypto.randomBytes(8).toString('hex'); }
function newToken() { return crypto.randomBytes(16).toString('hex'); }
function newCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = Array.from({ length: 6 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
  } while (codeIndex.has(c));
  return c;
}

// Cell values 1-3, evenly distributed across the board.
function genValues(n) {
  const vals = [];
  const per = Math.floor((n * n) / 3);
  for (let i = 0; i < per; i++) vals.push(1, 2, 3);
  while (vals.length < n * n) vals.push(1 + Math.floor(Math.random() * 3));
  for (let i = vals.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [vals[i], vals[j]] = [vals[j], vals[i]];
  }
  const grid = [];
  for (let r = 0; r < n; r++) grid.push(vals.slice(r * n, (r + 1) * n));
  return grid;
}

// Score: for each player, sum over 4-connected groups of (group cell values * group size).
function computeScores(game) {
  const n = game.size;
  const seen = Array.from({ length: n }, () => Array(n).fill(false));
  const scores = game.players.map(() => 0);
  const cells = game.players.map(() => 0);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const p = game.board[r][c];
      if (p === null || p === undefined || seen[r][c]) continue;
      let sum = 0, sz = 0;
      const q = [[r, c]];
      seen[r][c] = true;
      while (q.length) {
        const [cr, cc] = q.pop();
        sum += game.values[cr][cc];
        sz++;
        for (const [dr, dc] of DIRS) {
          const nr = cr + dr, nc = cc + dc;
          if (nr >= 0 && nr < n && nc >= 0 && nc < n && !seen[nr][nc] && game.board[nr][nc] === p) {
            seen[nr][nc] = true;
            q.push([nr, nc]);
          }
        }
      }
      scores[p] += sum * sz;
      cells[p] += sz;
    }
  }
  return { scores, cells };
}

function emptyCells(game) {
  const out = [];
  for (let r = 0; r < game.size; r++)
    for (let c = 0; c < game.size; c++)
      if (game.board[r][c] === null) out.push([r, c]);
  return out;
}

// Greedy heuristic shared by the built-in server bots: maximize own immediate
// score gain plus a fraction of the best opponent gain denied on that cell.
function chooseBotMove(game, pi) {
  const empt = emptyCells(game);
  if (!empt.length) return null;
  const base = computeScores(game).scores;
  let best = null, bestVal = -Infinity;
  for (const [r, c] of empt) {
    game.board[r][c] = pi;
    const ownGain = computeScores(game).scores[pi] - base[pi];
    game.board[r][c] = null;
    let denial = 0;
    for (let q = 0; q < game.players.length; q++) {
      if (q === pi) continue;
      game.board[r][c] = q;
      const g = computeScores(game).scores[q] - base[q];
      game.board[r][c] = null;
      if (g > denial) denial = g;
    }
    const val = ownGain + 0.5 * denial + Math.random() * 0.5;
    if (val > bestVal) { bestVal = val; best = [r, c]; }
  }
  return best;
}

function createGame(playerDefs, opts = {}) {
  const minPlayers = opts.lobby ? 1 : 2;
  if (!Array.isArray(playerDefs) || playerDefs.length < minPlayers || playerDefs.length > 4) {
    throw new Error('players must be an array of ' + minPlayers + '-4 entries');
  }
  const seen = new Set();
  const players = playerDefs.map((d) => {
    const p = typeof d === 'string' ? { name: d, bot: false } : { name: String(d.name || ''), bot: !!d.bot };
    p.name = p.name.trim().slice(0, 24);
    if (!p.name) throw new Error('player name required');
    if (seen.has(p.name.toLowerCase())) throw new Error('duplicate player name: ' + p.name);
    seen.add(p.name.toLowerCase());
    return { name: p.name, bot: p.bot, token: newToken() };
  });
  const game = {
    id: newId(),
    code: newCode(),
    size: BOARD_SIZE,
    values: genValues(BOARD_SIZE),
    board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null)),
    players,
    turnIndex: 0,
    status: opts.lobby ? 'lobby' : 'playing',
    passes: 0,
    log: [],
    winner: null,
    createdAt: Date.now(),
    botTimer: null,
  };
  games.set(game.id, game);
  codeIndex.set(game.code, game.id);
  if (game.status === 'playing') maybeBotMove(game);
  return game;
}

function publicState(game) {
  const { scores, cells } = computeScores(game);
  return {
    gameId: game.id,
    code: game.code,
    size: game.size,
    values: game.values,
    board: game.board,
    players: game.players.map((p, i) => ({ name: p.name, bot: p.bot, score: scores[i], cells: cells[i] })),
    turnIndex: game.turnIndex,
    turnPlayer: game.status === 'playing' ? game.players[game.turnIndex].name : null,
    status: game.status,
    passes: game.passes,
    winner: game.winner,
    log: game.log.slice(-60),
  };
}

function cellLabel(r, c) {
  return String.fromCharCode(65 + c) + (r + 1);
}

function finishGame(game) {
  game.status = 'finished';
  game.turnPlayer = undefined;
  if (game.botTimer) { clearTimeout(game.botTimer); game.botTimer = null; }
  const { scores, cells } = computeScores(game);
  const top = Math.max(...scores);
  const winners = game.players.map((p, i) => ({ name: p.name, score: scores[i], cells: cells[i], i }))
    .filter((w) => w.score === top)
    .sort((a, b) => b.cells - a.cells);
  game.winner = { names: winners.map((w) => w.name), scores, cells, tied: winners.length > 1 };
  game.log.push({ n: game.log.length + 1, player: null, move: 'game-over', detail: 'Winner: ' + game.winner.names.join(', ') });
}

function applyMove(game, playerIndex, row, col, isPass) {
  if (game.status !== 'playing') throw new Error('game is not in playing state');
  if (playerIndex !== game.turnIndex) throw new Error('not your turn');
  const player = game.players[playerIndex];
  if (isPass) {
    game.passes++;
    game.log.push({ n: game.log.length + 1, player: player.name, move: 'pass' });
  } else {
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= game.size || col < 0 || col >= game.size) {
      throw new Error('move out of bounds');
    }
    if (game.board[row][col] !== null) throw new Error('cell already claimed');
    game.board[row][col] = playerIndex;
    game.passes = 0;
    game.log.push({ n: game.log.length + 1, player: player.name, move: cellLabel(row, col), row, col });
  }
  if (emptyCells(game).length === 0 || game.passes >= game.players.length) {
    finishGame(game);
  } else {
    game.turnIndex = (game.turnIndex + 1) % game.players.length;
    maybeBotMove(game);
  }
  return publicState(game);
}

function maybeBotMove(game) {
  if (game.botTimer) { clearTimeout(game.botTimer); game.botTimer = null; }
  if (game.status !== 'playing') return;
  const p = game.players[game.turnIndex];
  if (!p || !p.bot) return;
  game.botTimer = setTimeout(() => {
    game.botTimer = null;
    if (game.status !== 'playing') return;
    const cur = game.players[game.turnIndex];
    if (!cur || !cur.bot) return;
    const mv = chooseBotMove(game, game.turnIndex);
    try {
      if (mv) applyMove(game, game.turnIndex, mv[0], mv[1], false);
      else applyMove(game, game.turnIndex, 0, 0, true);
    } catch (e) {
      // Never let a bot error stall a game; pass instead.
      try { applyMove(game, game.turnIndex, 0, 0, true); } catch (_) {}
    }
  }, BOT_MOVE_DELAY_MS);
  if (game.botTimer.unref) game.botTimer.unref();
}

// ---------- HTTP layer ----------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (ch) => { data += ch; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback: unknown paths serve index.html so shared links work.
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const m = req.method;

    if (p === '/api/health' && m === 'GET') return sendJson(res, 200, { ok: true, games: games.size });

    if (p === '/api/games' && m === 'POST') {
      const body = await readBody(req);
      const game = createGame(body.players || [], { lobby: !!body.lobby });
      return sendJson(res, 201, {
        gameId: game.id, code: game.code, status: game.status,
        players: game.players.map((pl) => ({ name: pl.name, bot: pl.bot, token: pl.token })),
        state: publicState(game),
      });
    }

    if (p === '/api/games' && m === 'GET') {
      const status = url.searchParams.get('status');
      const list = [...games.values()]
        .filter((g) => !status || g.status === status)
        .map((g) => ({ gameId: g.id, code: g.code, status: g.status, players: g.players.map((pl) => pl.name), seats: g.players.length }));
      return sendJson(res, 200, { games: list });
    }

    if (p === '/api/join' && m === 'POST') {
      const body = await readBody(req);
      const code = String(body.code || '').toUpperCase().trim();
      const name = String(body.name || '').trim().slice(0, 24);
      if (!code || !name) return sendJson(res, 400, { error: 'code and name required' });
      const id = codeIndex.get(code);
      const game = id && games.get(id);
      if (!game) return sendJson(res, 404, { error: 'lobby not found' });
      if (game.status !== 'lobby') return sendJson(res, 400, { error: 'game already started' });
      if (game.players.length >= 4) return sendJson(res, 400, { error: 'lobby is full' });
      if (game.players.some((pl) => pl.name.toLowerCase() === name.toLowerCase())) {
        return sendJson(res, 400, { error: 'name taken in this lobby' });
      }
      const pl = { name, bot: false, token: newToken() };
      game.players.push(pl);
      return sendJson(res, 200, { gameId: game.id, code: game.code, token: pl.token, name: pl.name, playerIndex: game.players.length - 1, state: publicState(game) });
    }

    const gm = p.match(/^\/api\/games\/([0-9a-f]+)(\/.*)?$/);
    if (gm) {
      const game = games.get(gm[1]);
      if (!game) return sendJson(res, 404, { error: 'game not found' });
      const sub = gm[2] || '';

      if (sub === '' && m === 'GET') return sendJson(res, 200, publicState(game));

      if (sub === '/log' && m === 'GET') return sendJson(res, 200, { gameId: game.id, log: game.log });

      if (sub === '/start' && m === 'POST') {
        if (game.status !== 'lobby') return sendJson(res, 400, { error: 'game already started' });
        if (game.players.length < 2) return sendJson(res, 400, { error: 'need at least 2 players to start' });
        game.status = 'playing';
        game.turnIndex = 0;
        maybeBotMove(game);
        return sendJson(res, 200, publicState(game));
      }

      if (sub === '/bots' && m === 'POST') {
        if (game.status !== 'lobby') return sendJson(res, 400, { error: 'can only add bots to a lobby' });
        if (game.players.length >= 4) return sendJson(res, 400, { error: 'lobby is full' });
        const body = await readBody(req);
        let name = String(body.name || '').trim().slice(0, 24);
        if (!name) {
          const n = game.players.filter((pl) => pl.bot).length + 1;
          name = 'TurfBot-' + n;
        }
        if (game.players.some((pl) => pl.name.toLowerCase() === name.toLowerCase())) {
          return sendJson(res, 400, { error: 'name taken in this lobby' });
        }
        const pl = { name, bot: true, token: newToken() };
        game.players.push(pl);
        return sendJson(res, 201, { name: pl.name, bot: true, state: publicState(game) });
      }

      if (sub === '/move' && m === 'POST') {
        const body = await readBody(req);
        const token = String(body.token || '');
        const pi = game.players.findIndex((pl) => pl.token === token);
        if (pi < 0) return sendJson(res, 401, { error: 'invalid token' });
        if (game.players[pi].bot) return sendJson(res, 400, { error: 'bot seats play automatically' });
        try {
          const state = applyMove(game, pi, body.row, body.col, !!body.pass);
          return sendJson(res, 200, { ok: true, state });
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
      }

      return sendJson(res, 404, { error: 'unknown game endpoint' });
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown api endpoint' });
    return serveStatic(req, res);
  } catch (e) {
    return sendJson(res, 500, { error: e.message || 'internal error' });
  }
});

server.listen(PORT, () => console.log('turfclaim listening on ' + PORT));
