// TurfClaim sample agent bot.
// Plays a full game through the public HTTP/JSON API using a greedy heuristic:
// for each empty cell, score = own immediate point gain + 0.5 * (best opponent
// gain denied on that cell). Beatable, but not trivial.
//
// Usage:
//   node bot/bot.js <baseUrl> --new <name> [--bots N]
//       Create a lobby as <name>, add N server bots (default 1), start, and play.
//   node bot/bot.js <baseUrl> --join <code> <name>
//       Join a lobby by code, wait for the host to start, and play.
//   node bot/bot.js <baseUrl> --play <gameId> <token>
//       Play an already-running game as the holder of <token>.
//
// Example:
//   node bot/bot.js http://localhost:3000 --new SampleBot --bots 2

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');

async function api(path, opts) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
  });
  const j = await r.json();
  if (!r.ok) throw new Error('API ' + r.status + ': ' + (j.error || JSON.stringify(j)));
  return j;
}

function computeScores(state, board) {
  const n = state.size;
  const seen = Array.from({ length: n }, () => Array(n).fill(false));
  const scores = state.players.map(() => 0);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const p = board[r][c];
      if (p === null || p === undefined || seen[r][c]) continue;
      let sum = 0, sz = 0;
      const q = [[r, c]];
      seen[r][c] = true;
      while (q.length) {
        const [cr, cc] = q.pop();
        sum += state.values[cr][cc];
        sz++;
        for (const [dr, dc] of DIRS) {
          const nr = cr + dr, nc = cc + dc;
          if (nr >= 0 && nr < n && nc >= 0 && nc < n && !seen[nr][nc] && board[nr][nc] === p) {
            seen[nr][nc] = true;
            q.push([nr, nc]);
          }
        }
      }
      scores[p] += sum * sz;
    }
  }
  return scores;
}

function chooseMove(state, me) {
  const n = state.size;
  const board = state.board.map((row) => row.slice());
  const base = computeScores(state, board);
  let best = null, bestVal = -Infinity;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (board[r][c] !== null) continue;
      board[r][c] = me;
      const ownGain = computeScores(state, board)[me] - base[me];
      board[r][c] = null;
      let denial = 0;
      for (let q = 0; q < state.players.length; q++) {
        if (q === me) continue;
        board[r][c] = q;
        const g = computeScores(state, board)[q] - base[q];
        board[r][c] = null;
        if (g > denial) denial = g;
      }
      const val = ownGain + 0.5 * denial + Math.random() * 0.5;
      if (val > bestVal) { bestVal = val; best = { row: r, col: c }; }
    }
  }
  return best;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playGame(gameId, token, name) {
  console.log('Playing game ' + gameId + ' as ' + name);
  for (;;) {
    const st = await api('/api/games/' + gameId);
    if (st.status === 'finished') {
      console.log('Game over. Winner: ' + st.winner.names.join(', '));
      st.players.forEach((p) => console.log('  ' + p.name + ': ' + p.score + ' pts'));
      return st;
    }
    const me = st.players.findIndex((p) => p.name === name);
    if (me < 0) throw new Error('player name not in game');
    if (st.status !== 'playing') { await sleep(1500); continue; }
    if (st.turnIndex !== me) { await sleep(800); continue; }
    const mv = chooseMove(st, me);
    if (!mv) {
      await api('/api/games/' + gameId + '/move', { method: 'POST', body: JSON.stringify({ token, pass: true }) });
      console.log(name + ' passes');
    } else {
      await api('/api/games/' + gameId + '/move', { method: 'POST', body: JSON.stringify({ token, row: mv.row, col: mv.col }) });
      console.log(name + ' claims ' + String.fromCharCode(65 + mv.col) + (mv.row + 1));
    }
    await sleep(300);
  }
}

async function main() {
  const mode = process.argv[3];
  if (mode === '--new') {
    const name = process.argv[4] || 'SampleBot';
    let bots = 1;
    const bi = process.argv.indexOf('--bots');
    if (bi >= 0 && process.argv[bi + 1]) bots = Math.max(0, Math.min(3, parseInt(process.argv[bi + 1], 10) || 0));
    const g = await api('/api/games', { method: 'POST', body: JSON.stringify({ players: [name], lobby: true }) });
    console.log('Lobby code: ' + g.code);
    for (let i = 0; i < bots; i++) {
      await api('/api/games/' + g.gameId + '/bots', { method: 'POST', body: JSON.stringify({}) });
    }
    await api('/api/games/' + g.gameId + '/start', { method: 'POST' });
    await playGame(g.gameId, g.players[0].token, name);
  } else if (mode === '--join') {
    const code = (process.argv[4] || '').toUpperCase();
    const name = process.argv[5] || 'SampleBot';
    if (!code) throw new Error('usage: --join <code> <name>');
    const j = await api('/api/join', { method: 'POST', body: JSON.stringify({ code, name }) });
    console.log('Joined lobby ' + code + '. Waiting for host to start...');
    for (;;) {
      const st = await api('/api/games/' + j.gameId);
      if (st.status !== 'lobby') break;
      await sleep(1500);
    }
    await playGame(j.gameId, j.token, name);
  } else if (mode === '--play') {
    const gameId = process.argv[4];
    const token = process.argv[5];
    if (!gameId || !token) throw new Error('usage: --play <gameId> <token>');
    const st = await api('/api/games/' + gameId);
    // We do not know our name from the token alone; find it via a lobby-free probe is not
    // possible, so require the name as an extra arg.
    const name = process.argv[6];
    if (!name) throw new Error('usage: --play <gameId> <token> <name>');
    void st;
    await playGame(gameId, token, name);
  } else {
    console.log('Usage:');
    console.log('  node bot/bot.js <baseUrl> --new <name> [--bots N]');
    console.log('  node bot/bot.js <baseUrl> --join <code> <name>');
    console.log('  node bot/bot.js <baseUrl> --play <gameId> <token> <name>');
    process.exit(1);
  }
}

main().catch((e) => { console.error('bot error:', e.message); process.exit(1); });
