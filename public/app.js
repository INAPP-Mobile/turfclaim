// TurfClaim browser client. No build step, no dependencies.
(function () {
  'use strict';
  var COLORS = ['#4cc38a', '#5aa9e6', '#ffb454', '#c77dff'];
  var session = null; // {gameId, token, name, playerIndex}
  var state = null;
  var pollTimer = null;

  function $(id) { return document.getElementById(id); }

  function show(viewId) {
    ['view-home', 'view-lobby', 'view-game'].forEach(function (v) {
      $(v).classList.toggle('hidden', v !== viewId);
    });
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = { 'Content-Type': 'application/json' };
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('request failed: ' + r.status));
        return j;
      });
    });
  }

  function saveSession() {
    try { localStorage.setItem('turfclaim', JSON.stringify(session)); } catch (e) {}
  }
  function loadSession() {
    try {
      var s = JSON.parse(localStorage.getItem('turfclaim') || 'null');
      if (s && s.gameId && s.token) return s;
    } catch (e) {}
    return null;
  }

  // ---------- home ----------

  $('btn-create').addEventListener('click', function () {
    var name = $('home-name').value.trim();
    if (!name) { $('home-error').textContent = 'Enter your name first.'; return; }
    $('home-error').textContent = '';
    api('/api/games', { method: 'POST', body: JSON.stringify({ players: [name], lobby: true }) })
      .then(function (g) {
        session = { gameId: g.gameId, token: g.players[0].token, name: name, playerIndex: 0 };
        saveSession();
        enterLobby(g.state);
      })
      .catch(function (e) { $('home-error').textContent = e.message; });
  });

  $('btn-join').addEventListener('click', function () {
    var name = $('home-name').value.trim();
    var code = $('home-code').value.trim().toUpperCase();
    if (!name) { $('home-error').textContent = 'Enter your name first.'; return; }
    if (!code) { $('home-error').textContent = 'Enter a lobby code.'; return; }
    $('home-error').textContent = '';
    api('/api/join', { method: 'POST', body: JSON.stringify({ code: code, name: name }) })
      .then(function (j) {
        session = { gameId: j.gameId, token: j.token, name: j.name, playerIndex: j.playerIndex };
        saveSession();
        enterLobby(j.state);
      })
      .catch(function (e) { $('home-error').textContent = e.message; });
  });

  // ---------- lobby ----------

  function enterLobby(st) {
    state = st;
    show('view-lobby');
    $('lobby-code').textContent = st.code;
    renderLobbyPlayers(st);
    $('lobby-error').textContent = '';
    startPolling(renderLobbyPlayers);
  }

  function renderLobbyPlayers(st) {
    state = st;
    var ul = $('lobby-players');
    ul.innerHTML = '';
    st.players.forEach(function (p, i) {
      var li = document.createElement('li');
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = COLORS[i % COLORS.length];
      li.appendChild(dot);
      var nm = document.createElement('span');
      nm.textContent = p.name + (session && p.name === session.name ? ' (you)' : '');
      li.appendChild(nm);
      if (p.bot) {
        var b = document.createElement('span');
        b.className = 'badge';
        b.textContent = 'bot';
        li.appendChild(b);
      }
      ul.appendChild(li);
    });
    $('btn-start').disabled = st.players.length < 2;
  }

  $('btn-copy').addEventListener('click', function () {
    var code = $('lobby-code').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(function () {});
  });

  $('btn-addbot').addEventListener('click', function () {
    api('/api/games/' + session.gameId + '/bots', { method: 'POST', body: JSON.stringify({}) })
      .then(function (r) { renderLobbyPlayers(r.state); })
      .catch(function (e) { $('lobby-error').textContent = e.message; });
  });

  $('btn-start').addEventListener('click', function () {
    api('/api/games/' + session.gameId + '/start', { method: 'POST' })
      .then(function (st) { enterGame(st); })
      .catch(function (e) { $('lobby-error').textContent = e.message; });
  });

  // ---------- game ----------

  function enterGame(st) {
    state = st;
    show('view-game');
    $('win-overlay').classList.add('hidden');
    buildBoard();
    renderGame(st);
    startPolling(function (s) {
      // If the lobby started elsewhere, jump into the game view.
      if (s.status === 'playing' || s.status === 'finished') {
        if ($('view-game').classList.contains('hidden')) enterGame(s);
        else renderGame(s);
      } else {
        renderLobbyPlayers(s);
      }
    });
  }

  function buildBoard() {
    var b = $('board');
    b.innerHTML = '';
    for (var r = 0; r < 6; r++) {
      for (var c = 0; c < 6; c++) {
        (function (r, c) {
          var d = document.createElement('div');
          d.className = 'cell';
          d.id = 'cell-' + r + '-' + c;
          d.addEventListener('click', function () { onCellClick(r, c); });
          b.appendChild(d);
        })(r, c);
      }
    }
  }

  function myTurn() {
    return state && state.status === 'playing' && state.players[state.turnIndex] &&
      session && state.players[state.turnIndex].name === session.name;
  }

  function onCellClick(r, c) {
    if (!myTurn()) return;
    if (state.board[r][c] !== null) return;
    api('/api/games/' + session.gameId + '/move', {
      method: 'POST',
      body: JSON.stringify({ token: session.token, row: r, col: c }),
    }).then(renderGame).catch(function (e) { refresh(); });
  }

  $('btn-pass').addEventListener('click', function () {
    if (!myTurn()) return;
    api('/api/games/' + session.gameId + '/move', {
      method: 'POST',
      body: JSON.stringify({ token: session.token, pass: true }),
    }).then(renderGame).catch(function () { refresh(); });
  });

  $('btn-new').addEventListener('click', function () {
    stopPolling();
    try { localStorage.removeItem('turfclaim'); } catch (e) {}
    session = null;
    show('view-home');
  });

  $('btn-again').addEventListener('click', function () {
    $('win-overlay').classList.add('hidden');
    $('btn-new').click();
  });

  function renderGame(st) {
    state = st;
    // board
    for (var r = 0; r < st.size; r++) {
      for (var c = 0; c < st.size; c++) {
        var d = $('cell-' + r + '-' + c);
        if (!d) continue;
        var owner = st.board[r][c];
        d.innerHTML = '';
        var v = document.createElement('div');
        v.className = 'val';
        v.textContent = st.values[r][c];
        d.appendChild(v);
        if (owner !== null && owner !== undefined) {
          var pip = document.createElement('div');
          pip.className = 'pip';
          pip.style.background = COLORS[owner % COLORS.length];
          d.appendChild(pip);
          d.classList.remove('playable');
        } else {
          d.classList.toggle('playable', myTurn());
        }
      }
    }
    // turn banner
    var banner = $('turn-banner');
    if (st.status === 'finished') {
      banner.textContent = 'Game over';
      banner.classList.remove('you');
    } else if (myTurn()) {
      banner.textContent = 'Your turn - claim a cell';
      banner.classList.add('you');
    } else {
      banner.textContent = st.turnPlayer + ' to move' + (st.players[st.turnIndex].bot ? ' (bot thinking...)' : '');
      banner.classList.remove('you');
    }
    // scores
    var sl = $('score-list');
    sl.innerHTML = '';
    var order = st.players.map(function (p, i) { return i; })
      .sort(function (a, b) { return st.players[b].score - st.players[a].score; });
    order.forEach(function (i) {
      var p = st.players[i];
      var li = document.createElement('li');
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = COLORS[i % COLORS.length];
      li.appendChild(dot);
      var nm = document.createElement('span');
      nm.textContent = p.name + (session && p.name === session.name ? ' (you)' : '');
      li.appendChild(nm);
      if (p.bot) {
        var bdg = document.createElement('span');
        bdg.className = 'badge';
        bdg.textContent = 'bot';
        li.appendChild(bdg);
      }
      if (st.status === 'playing' && st.turnIndex === i) {
        var tb = document.createElement('span');
        tb.className = 'badge';
        tb.textContent = 'to move';
        li.appendChild(tb);
      }
      var sc = document.createElement('span');
      sc.className = 'score-num';
      sc.textContent = p.score + ' pts (' + p.cells + ')';
      li.appendChild(sc);
      ul_append(sl, li);
    });
    // log
    var log = $('move-log');
    log.innerHTML = '';
    st.log.slice().reverse().forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.n + '. ' + (e.player ? e.player + ' -> ' + e.move : e.move + (e.detail ? ': ' + e.detail : ''));
      log.appendChild(li);
    });
    $('btn-pass').disabled = !myTurn();
    if (st.status === 'finished') showWin(st);
  }

  function ul_append(ul, li) { ul.appendChild(li); }

  function showWin(st) {
    var w = st.winner;
    $('win-title').textContent = w.tied
      ? 'Tie: ' + w.names.join(' and ')
      : w.names[0] + ' wins';
    var ul = $('win-scores');
    ul.innerHTML = '';
    var order = st.players.map(function (p, i) { return i; })
      .sort(function (a, b) { return st.players[b].score - st.players[a].score; });
    order.forEach(function (i) {
      var p = st.players[i];
      var li = document.createElement('li');
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = COLORS[i % COLORS.length];
      li.appendChild(dot);
      var nm = document.createElement('span');
      nm.textContent = p.name;
      li.appendChild(nm);
      var sc = document.createElement('span');
      sc.className = 'score-num';
      sc.textContent = p.score + ' pts';
      li.appendChild(sc);
      ul.appendChild(li);
    });
    $('win-overlay').classList.remove('hidden');
  }

  // ---------- polling ----------

  function startPolling(onState) {
    stopPolling();
    pollTimer = setInterval(refresh, 1500);
    function refresh() {
      if (!session) return;
      api('/api/games/' + session.gameId)
        .then(function (st) {
          if (st.status === 'finished' && !st.winner) return;
          onState(st);
        })
        .catch(function () {});
    }
    // expose for manual refresh
    startPolling.refresh = refresh;
    refresh();
  }
  function refresh() { if (startPolling.refresh) startPolling.refresh(); }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // Resume a previous session if the game is still alive.
  var prev = loadSession();
  if (prev) {
    session = prev;
    api('/api/games/' + prev.gameId).then(function (st) {
      if (st.status === 'lobby') enterLobby(st);
      else enterGame(st);
    }).catch(function () {
      session = null;
      show('view-home');
    });
  }
})();
