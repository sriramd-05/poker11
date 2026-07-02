// ── DOM refs ──────────────────────────────────────────────────────────────────
const joinPanel      = document.querySelector("#joinPanel");
const tableScreen    = document.querySelector("#tableScreen");
const nameInput      = document.querySelector("#nameInput");
const roomInput      = document.querySelector("#roomInput");
const createBtn      = document.querySelector("#createBtn");
const joinBtn        = document.querySelector("#joinBtn");
const buyInInput     = document.querySelector("#buyInInput");
const seatInput      = document.querySelector("#seatInput");
const notice         = document.querySelector("#notice");
const copyCodeBtn    = document.querySelector("#copyCodeBtn");
const phaseLabel     = document.querySelector("#phaseLabel");
const voiceBtn       = document.querySelector("#voiceBtn");
const muteBtn        = document.querySelector("#muteBtn");
const soundBtn       = document.querySelector("#soundBtn");
const awayBtn        = document.querySelector("#awayBtn");
const pauseBtn       = document.querySelector("#pauseBtn");
const showCardsBtn   = document.querySelector("#showCardsBtn");
const startHandBtn   = document.querySelector("#startHandBtn");
const menuBtn        = document.querySelector("#menuBtn");
const optionsMenu    = document.querySelector("#optionsMenu");
const potLabel       = document.querySelector("#potLabel");
const roundPotLabel  = document.querySelector("#roundPotLabel");
const boardCards     = document.querySelector("#boardCards");
const seatsEl        = document.querySelector("#seats");
const turnLabel      = document.querySelector("#turnLabel");
const timerLabel     = document.querySelector("#timerLabel");
const raiseInput     = document.querySelector("#raiseInput");
const messages       = document.querySelector("#messages");
const chatForm       = document.querySelector("#chatForm");
const chatInput      = document.querySelector("#chatInput");
const handLog        = document.querySelector("#handLog");
const voicePeers     = document.querySelector("#voicePeers");
const audioMount     = document.querySelector("#audioMount");
const chipsForm      = document.querySelector("#chipsForm");
const chipsInput     = document.querySelector("#chipsInput");
const chipRequests   = document.querySelector("#chipRequests");
const statsPanel     = document.querySelector("#statsPanel");
const ledgerPanel    = document.querySelector("#ledgerPanel");
const leaveSeatBtn   = document.querySelector("#leaveSeatBtn");
const rejoinBar      = document.querySelector("#rejoinBar");
const rejoinSeatInput= document.querySelector("#rejoinSeatInput");
const rejoinSeatBtn  = document.querySelector("#rejoinSeatBtn");
const pauseOverlay   = document.querySelector("#pauseOverlay");
const nextHandBar    = document.querySelector("#nextHandBar");
const winOverlay     = document.querySelector("#winOverlay");

// ── State ─────────────────────────────────────────────────────────────────────
let socket;
let state;
let playerId;
let roomCode;
let timerInterval;
let nextHandInterval;
let winOverlayTimer;
let localStream;
let soundEnabled = localStorage.getItem("pokerSound") !== "off";
let audioContext;
const peers = new Map();          // playerId -> RTCPeerConnection
const pendingCandidates = new Map(); // playerId -> ICE candidates received before remoteDescription was set
const voiceStatus = new Map();    // playerId -> "connecting" | "ready" | "off"
const speaking = new Map();       // playerId -> boolean (live level detection, includes "local")
let levelLoopRunning = false;

const AVATAR_COLORS = ["#e0b64b", "#4aa3df", "#d94d4d", "#4dd08a", "#c084fc", "#f59e0b", "#38bdf8", "#fb7185", "#a3e635", "#fb923c"];

// Reconnect state
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT = 8;
const RECONNECT_DELAYS = [1000, 2000, 3000, 5000, 8000, 15000, 30000, 30000];

// Positions tuned for tall rounded-rectangle table — seat 1 at bottom-centre, clockwise
const seatPositions = [
  ["50%", "88%"],  // 1 bottom centre
  ["26%", "80%"],  // 2 bottom left
  ["9%",  "62%"],  // 3 left lower
  ["9%",  "38%"],  // 4 left upper
  ["26%", "20%"],  // 5 top left
  ["50%", "12%"],  // 6 top centre
  ["74%", "20%"],  // 7 top right
  ["91%", "38%"],  // 8 right upper
  ["91%", "62%"],  // 9 right lower
  ["74%", "80%"],  // 10 bottom right
];

// ── Hand rank evaluation ──────────────────────────────────────────────────────
// Returns { label, tier } where tier is a CSS class suffix (pair, two, trips, str8, flush, boat, quads, sf, high)
const RANK_ORDER = "23456789TJQKA";
function rankVal(r) { return RANK_ORDER.indexOf(r); }

function evalHandRank(holeCards, boardCards) {
  // Only show rank when we have ≥1 visible hole card and ≥3 board cards
  const visible = (holeCards || []).filter(Boolean);
  const board   = (boardCards || []).filter(Boolean);
  if (visible.length === 0 || board.length < 3) return null;

  const all = [...visible, ...board];
  if (all.length < 2) return null;

  const suits = {};
  const rankCounts = {};
  for (const c of all) {
    suits[c.suit]  = (suits[c.suit]  || 0) + 1;
    rankCounts[c.rank] = (rankCounts[c.rank] || 0) + 1;
  }

  const counts = Object.values(rankCounts).sort((a, b) => b - a);
  const hasFlush = Object.values(suits).some(v => v >= 5);

  // straight check
  const rankSet = new Set(all.map(c => rankVal(c.rank)));
  let hasStraight = false;
  const rankArr = [...rankSet].sort((a,b)=>a-b);
  // Ace-low
  if (rankSet.has(12)) rankArr.unshift(-1);
  for (let i = 0; i <= rankArr.length - 5; i++) {
    if (rankArr[i+4] - rankArr[i] === 4 && new Set(rankArr.slice(i, i+5)).size === 5) {
      hasStraight = true; break;
    }
  }

  if (hasStraight && hasFlush) return { label: "Str. Flush", tier: "sf" };
  if (counts[0] === 4) {
    const quad = Object.entries(rankCounts).find(([,v])=>v===4)?.[0] || "";
    return { label: `Quads (${rnk(quad)})`, tier: "quads" };
  }
  if (counts[0] === 3 && counts[1] >= 2) return { label: "Full House", tier: "boat" };
  if (hasFlush) return { label: "Flush", tier: "flush" };
  if (hasStraight) return { label: "Straight", tier: "str8" };
  if (counts[0] === 3) {
    const trips = Object.entries(rankCounts).find(([,v])=>v===3)?.[0] || "";
    return { label: `Trips (${rnk(trips)})`, tier: "trips" };
  }
  const pairs = Object.entries(rankCounts).filter(([,v])=>v>=2).sort((a,b)=>rankVal(b[0])-rankVal(a[0]));
  if (pairs.length >= 2) return { label: `Two Pair`, tier: "two" };
  if (pairs.length === 1) {
    return { label: `Pair (${rnk(pairs[0][0])})`, tier: "pair" };
  }
  return { label: "High Card", tier: "high" };
}

// Pre-fill name and room code from URL/?room=
nameInput.value = localStorage.getItem("pokerName") || "";
const urlRoom = new URLSearchParams(location.search).get("room");
if (urlRoom) roomInput.value = urlRoom.toUpperCase();

// ── Event listeners ───────────────────────────────────────────────────────────
createBtn.addEventListener("click", () => connect("createRoom"));
joinBtn.addEventListener("click", () => connect("joinRoom"));
copyCodeBtn.addEventListener("click", copyRoomCode);
startHandBtn.addEventListener("click", () => send("startHand"));
voiceBtn.addEventListener("click", startVoice);
muteBtn.addEventListener("click", toggleMute);
soundBtn.addEventListener("click", toggleSound);
awayBtn.addEventListener("click", toggleAway);
pauseBtn.addEventListener("click", () => send("pauseGame", { paused: !state.paused }));
showCardsBtn.addEventListener("click", () => send("showCards"));

leaveSeatBtn.addEventListener("click", () => {
  if (!confirm("Leave your seat? You can rejoin an open seat anytime.")) return;
  send("leaveSeat");
  optionsMenu.classList.add("hidden");
});
rejoinSeatBtn.addEventListener("click", () => {
  send("rejoinSeat", { seatNumber: Number(rejoinSeatInput.value) || undefined });
});

menuBtn.addEventListener("click", () => optionsMenu.classList.toggle("hidden"));
document.addEventListener("click", (e) => {
  if (optionsMenu.classList.contains("hidden")) return;
  if (!optionsMenu.contains(e.target) && !menuBtn.contains(e.target))
    optionsMenu.classList.add("hidden");
});

// Action buttons
document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.addEventListener("click", () => {
    send("action", { action: btn.dataset.action, amount: Number(raiseInput.value) });
  });
});

// Quick-bet buttons
document.querySelectorAll("[data-bet]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!state) return;
    const pot = state.pot + state.players.reduce((s, p) => s + p.bet, 0);
    const callAmount = (() => {
      const me = state.players.find((p) => p.id === playerId);
      return me ? Math.max(0, state.currentBet - me.bet) : 0;
    })();
    const factor = parseFloat(btn.dataset.bet);
    const base = factor === 0 ? 0 : Math.round(pot * factor);
    const min = Number(raiseInput.min) || state.bigBlind * 2;
    raiseInput.value = Math.max(min, base + callAmount);
  });
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (chatInput.value.trim()) {
    send("chat", { text: chatInput.value });
    chatInput.value = "";
  }
});

chipsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  send("requestChips", { amount: Number(chipsInput.value) });
  playSound("chips");
});

chipRequests.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-request-id]");
  if (!btn) return;
  send("approveChips", { requestId: btn.dataset.requestId, amount: Number(btn.dataset.amount) });
  playSound("chips");
});

// ── Connection & auto-reconnect ───────────────────────────────────────────────
function connect(type) {
  clearTimeout(reconnectTimer);
  const name = nameInput.value.trim() || "Player";
  localStorage.setItem("pokerName", name);
  notice.textContent = reconnectAttempts > 0 ? `Reconnecting… (attempt ${reconnectAttempts})` : "Connecting…";
  createBtn.disabled = true;
  joinBtn.disabled = true;

  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}`);

  socket.addEventListener("open", () => {
    const code = roomInput.value.trim().toUpperCase();
    const savedSeat = readSavedSeat(code);
    // Only send saved token if this is truly the same person (name matches)
    const token = (type === "joinRoom" && savedSeat?.name === name) ? savedSeat.token : "";
    send(type, { name, code, token, buyIn: Number(buyInInput.value), seatNumber: Number(seatInput.value) });
  });

  socket.addEventListener("message", async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "joined") {
      playerId = msg.payload.playerId;
      roomCode = msg.payload.roomCode;
      reconnectAttempts = 0;
      saveSeat(roomCode, name, msg.payload.token);
      localStorage.setItem("pokerLastRoom", roomCode);
      // Mark session active — distinguishes refresh from fresh link open
      sessionStorage.setItem("pokerActive", roomCode);
      // Embed room code in URL for easy refresh
      const url = new URL(location.href);
      url.searchParams.set("room", roomCode);
      history.replaceState(null, "", url);
      joinPanel.classList.add("hidden");
      tableScreen.classList.remove("hidden");
      soundBtn.textContent = soundEnabled ? "Sound On" : "Sound Off";
    }
    if (msg.type === "state")  render(msg.payload);
    if (msg.type === "chat")   addMessage(msg.payload.name, msg.payload.text);
    if (msg.type === "system") addMessage("Table", msg.payload.message);
    if (msg.type === "error") {
      notice.textContent = msg.payload.message;
      createBtn.disabled = false;
      joinBtn.disabled = false;
    }
    if (msg.type === "voiceSignal") handleVoiceSignal(msg.payload);
  });

  socket.addEventListener("close", () => {
    createBtn.disabled = false;
    joinBtn.disabled = false;
    // Auto-reconnect only if this was an active session (not a fresh invite link)
    const activeRoom = sessionStorage.getItem("pokerActive");
    if (activeRoom && reconnectAttempts < MAX_RECONNECT) {
      const delay = RECONNECT_DELAYS[reconnectAttempts] || 30000;
      reconnectAttempts++;
      notice.textContent = `Connection lost. Reconnecting in ${Math.round(delay / 1000)}s…`;
      // Show join panel briefly so the reconnect notice is visible
      if (tableScreen.classList.contains("hidden")) {
        notice.textContent = `Reconnecting… (${reconnectAttempts}/${MAX_RECONNECT})`;
      }
      addMessage("Table", `Connection lost. Reconnecting in ${Math.round(delay / 1000)}s…`);
      reconnectTimer = setTimeout(() => {
        roomInput.value = activeRoom;
        nameInput.value = localStorage.getItem("pokerName") || "";
        connect("joinRoom");
      }, delay);
    } else if (reconnectAttempts >= MAX_RECONNECT) {
      addMessage("Table", "Could not reconnect. Please refresh the page.");
      reconnectAttempts = 0;
    }
  });

  socket.addEventListener("error", () => {
    notice.textContent = "Could not reach the table server.";
    createBtn.disabled = false;
    joinBtn.disabled = false;
  });
}

function send(type, payload = {}) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, payload }));
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(next) {
  const prev = state;
  state = next;

  pauseOverlay.classList.toggle("hidden", !state.paused);

  const phases = { waiting: "Waiting", preflop: "Pre-Flop", flop: "Flop", turn: "Turn", river: "River", showdown: "Showdown" };
  phaseLabel.textContent = phases[state.phase] || state.phase;

  potLabel.textContent   = `Pot  ${state.pot}`;
  roundPotLabel.textContent = state.roundPot ? `Bet  ${state.roundPot}` : "";
  roundPotLabel.classList.toggle("hidden", !state.roundPot);

  renderBoard();
  renderSeats();
  renderControls();
  renderLog();
  renderChipRequests();
  renderStats();
  renderLedger();
  renderRejoinBar();
  renderNextHand();
  renderWinOverlay(prev);
  renderVoicePeers();
  reactToStateChange(prev, state);
}

// ── Seats ─────────────────────────────────────────────────────────────────────
function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("") || "?";
}

function renderSeats() {
  seatsEl.innerHTML = "";
  const seatedIds = new Set();
  for (let sn = 1; sn <= state.maxPlayers; sn++) {
    const player = state.players.find((p) => p.seatNumber === sn);
    const [left, top] = seatPositions[sn - 1];
    const seat = document.createElement("article");
    seat.style.cssText = `left:${left};top:${top}`;

    if (!player) {
      seat.className = "seat";
      seat.innerHTML = `<div class="seat-empty"><span class="sn">${sn}</span>Open</div>`;
      seatsEl.appendChild(seat);
      continue;
    }

    seatedIds.add(player.id);
    const isMe = player.id === playerId;
    const cls = ["seat"];
    if (player.isTurn) cls.push("turn");
    if (isMe) cls.push("me");
    if (player.sittingOut) cls.push("away");
    if (player.folded) cls.push("folded");
    seat.className = cls.join(" ");
    seat.dataset.playerId = player.id;

    let badge = "";
    if (player.allIn) badge = `<span class="badge allin">All-in</span>`;
    else if (player.folded) badge = `<span class="badge fold">Fold</span>`;
    else if (player.sittingOut) badge = `<span class="badge away-b">Away</span>`;
    else if (!player.connected) badge = `<span class="badge off">Off</span>`;

    const betMarker = player.bet ? `<div class="bet-marker">${player.bet}</div>` : "";
    const dealerBtn = player.dealer ? `<div class="dealer-btn">D</div>` : "";
    const color = AVATAR_COLORS[(sn - 1) % AVATAR_COLORS.length];
    const micClass = player.muted ? "muted" : (voiceStatus.get(player.id) === "ready" ? "on" : "");

    const hr = evalHandRank(player.cards, state.board);
    const hrBadge = hr ? `<span class="hand-rank-badge rank-${hr.tier}">${escHtml(hr.label)}</span>` : "";

    seat.innerHTML = `
      <div class="seat-pod">
        <div class="avatar-wrap">
          <div class="avatar-ring" style="--pct:0"></div>
          <div class="avatar" style="background:${color}">${escHtml(initials(player.name))}</div>
          ${dealerBtn}
          <div class="mic-badge ${micClass}" data-mic="${player.id}">${player.muted ? "&#128263;" : "&#127908;"}</div>
        </div>
        <div class="seat-cards"></div>
        <div class="seat-name-text">${escHtml(player.name)}</div>
        ${hrBadge}
        <div class="seat-badges">${player.isOwner ? '<span class="badge owner">Owner</span>' : ""}${badge}</div>
        <div class="stack-chip">${player.stack}</div>
        ${betMarker}
      </div>`;
    renderCards(seat.querySelector(".seat-cards"), player.cards);
    seatsEl.appendChild(seat);
  }
  cleanupStaleVoicePeers(seatedIds);
}

function renderBoard() {
  boardCards.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    boardCards.appendChild(buildCardEl(state.board[i]));
  }
}

function renderCards(container, cards) {
  container.innerHTML = "";
  (cards || []).forEach((card) => container.appendChild(buildCardEl(card, true)));
}

// Builds a realistic playing-card element: corner indices + center suit pip,
// a face-down back design, or a dashed empty placeholder.
function buildCardEl(card, allowFaceDown = false) {
  const el = document.createElement("div");
  if (card === null || card === undefined) {
    el.className = allowFaceDown ? "card back" : "card empty";
    return el;
  }
  const red = isRed(card);
  el.className = `card${red ? " red" : ""}`;
  const r = rnk(card.rank);
  const s = suit(card.suit);
  el.innerHTML = `
    <div class="corner tl"><span class="rank">${r}</span><span class="pip">${s}</span></div>
    <div class="pip-center">${s}</div>
    <div class="corner br"><span class="rank">${r}</span><span class="pip">${s}</span></div>`;
  return el;
}

// ── Controls ──────────────────────────────────────────────────────────────────
function renderControls() {
  const me      = state.players.find((p) => p.id === playerId);
  const current = state.players[state.turnIndex];
  const myTurn  = current?.id === playerId;

  if (state.paused) {
    turnLabel.textContent = "Game paused";
    turnLabel.style.color = "var(--muted)";
  } else if (current) {
    turnLabel.textContent = myTurn ? "Your turn ▸" : `${current.name}'s turn`;
    turnLabel.style.color = myTurn ? "var(--gold)" : "";
  } else {
    turnLabel.textContent = state.phase === "waiting" ? "Waiting for players…" : "Hand complete";
    turnLabel.style.color = "";
  }

  startHandBtn.disabled = state.paused || (state.phase !== "waiting" && state.phase !== "showdown");
  pauseBtn.classList.toggle("hidden", state.ownerId !== playerId);
  pauseBtn.textContent = state.paused ? "Resume" : "Pause";
  awayBtn.textContent  = me?.sittingOut ? "Back" : "Away";
  awayBtn.disabled     = !me || !me.seatNumber;
  leaveSeatBtn.disabled = !me || !me.seatNumber;

  showCardsBtn.classList.toggle("hidden",
    !(state.phase === "showdown" && me?.cards?.some(Boolean) && !me?.showingCards));

  const callAmount = me ? Math.max(0, state.currentBet - me.bet) : 0;
  const minRaise   = Math.max(state.currentBet + state.bigBlind, state.bigBlind);
  raiseInput.min   = String(minRaise);
  if (Number(raiseInput.value) < minRaise) raiseInput.value = minRaise;

  const off = state.paused || me?.sittingOut || !myTurn ||
              state.phase === "waiting" || state.phase === "showdown";
  document.querySelectorAll("[data-action]").forEach((b) => (b.disabled = off));
  document.querySelectorAll("[data-bet]").forEach((b) => (b.disabled = off));
  raiseInput.disabled = off;
  document.querySelector('[data-action="check"]').disabled = off || callAmount > 0;
  document.querySelector('[data-action="call"]').disabled  = off || callAmount === 0;
  document.querySelector('[data-action="call"]').textContent = callAmount ? `Call ${callAmount}` : "Call";

  // Update quick-bet labels with real pot amounts
  const pot = state.pot + state.players.reduce((s, p) => s + p.bet, 0);
  document.querySelector('[data-bet="0.5"]').textContent = `½ Pot (${Math.round(pot * 0.5)})`;
  document.querySelector('[data-bet="1"]').textContent   = `Pot (${pot})`;
  document.querySelector('[data-bet="2"]').textContent   = `2× (${pot * 2})`;

  clearInterval(timerInterval);
  timerLabel.textContent = "--";
  const TURN_MS = 30000; // matches server TURN_MS
  timerInterval = setInterval(() => {
    const ring = document.querySelector(".seat.turn .avatar-ring");
    if (!state?.turnDeadline) {
      timerLabel.textContent = "--";
      if (ring) ring.style.setProperty("--pct", "0");
      return;
    }
    const remainingMs = Math.max(0, state.turnDeadline - Date.now());
    const left = Math.ceil(remainingMs / 1000);
    timerLabel.textContent = `${left}s`;
    timerLabel.style.color = left <= 5 ? "var(--red)" : "";
    if (ring) ring.style.setProperty("--pct", String(Math.max(0, Math.min(100, (remainingMs / TURN_MS) * 100))));
  }, 250);
}

// ── Win overlay ───────────────────────────────────────────────────────────────
function renderWinOverlay(prev) {
  if (!state.lastWin) return;
  // Only show if lastWin is new (compare names+amount)
  const prevKey = prev?.lastWin ? `${prev.lastWin.names.join("")}${prev.lastWin.amount}` : "";
  const curKey  = `${state.lastWin.names.join("")}${state.lastWin.amount}`;
  if (prevKey === curKey) return;

  const { names, handName, amount } = state.lastWin;
  winOverlay.querySelector(".win-names").textContent  = names.join(" & ");
  winOverlay.querySelector(".win-hand").textContent   = handName ? `with ${handName}` : "";
  winOverlay.querySelector(".win-amount").textContent = `wins ${amount} chips`;
  winOverlay.classList.remove("hidden", "win-fade");
  // Force reflow then add fade class after display duration
  clearTimeout(winOverlayTimer);
  winOverlayTimer = setTimeout(() => winOverlay.classList.add("win-fade"), 2800);
  playSound("win");
}

// ── Next hand bar ─────────────────────────────────────────────────────────────
function renderNextHand() {
  clearInterval(nextHandInterval);
  if (!state.nextHandDeadline || state.paused) {
    nextHandBar.classList.add("hidden");
    return;
  }
  nextHandBar.classList.remove("hidden");
  const tick = () => {
    const left = Math.max(0, Math.ceil((state.nextHandDeadline - Date.now()) / 1000));
    nextHandBar.textContent = `Next hand starting in ${left}s…`;
    if (left === 0) { nextHandBar.classList.add("hidden"); clearInterval(nextHandInterval); }
  };
  tick();
  nextHandInterval = setInterval(tick, 500);
}

// ── Side panels ───────────────────────────────────────────────────────────────
function renderLog() {
  handLog.innerHTML = "";
  state.log.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    handLog.appendChild(li);
  });
}

function renderChipRequests() {
  const me = state.players.find((p) => p.id === playerId);
  const isOwner = state.ownerId === playerId;
  chipsForm.classList.toggle("hidden", !me || (me.stack > 0 && state.phase !== "showdown"));
  chipRequests.innerHTML = "";
  if (!state.chipRequests?.length) {
    chipRequests.innerHTML = '<p class="muted-line">No requests.</p>';
    return;
  }
  state.chipRequests.forEach((req) => {
    const row = document.createElement("div");
    row.className = "chip-request";
    row.innerHTML = `<span>${escHtml(req.name)} wants ${req.amount}</span>
      ${isOwner ? `<button data-request-id="${req.id}" data-amount="${req.amount}">Add</button>` : '<span class="muted-line">Pending</span>'}`;
    chipRequests.appendChild(row);
  });
}

function renderStats() {
  statsPanel.innerHTML = "";
  state.players.forEach((p) => {
    const s = p.stats || {};
    const row = document.createElement("div");
    row.className = "stat-row";
    row.innerHTML = `<strong>${escHtml(p.name)}</strong>
      <span>Hands ${s.hands || 0}</span><span>Wins ${s.wins || 0}</span>
      <span>Buy-in ${s.buyIns || 0}</span><span>Won ${s.chipsWon || 0}</span>`;
    statsPanel.appendChild(row);
  });
}

function renderLedger() {
  ledgerPanel.innerHTML = "";
  if (!state.ledger?.length) { ledgerPanel.innerHTML = '<p class="muted-line">No activity yet.</p>'; return; }
  state.ledger.forEach((e) => {
    const li = document.createElement("li"); li.textContent = e.message;
    ledgerPanel.appendChild(li);
  });
}

function renderRejoinBar() {
  const me = state.players.find((p) => p.id === playerId);
  const seatless = Boolean(me) && !me.seatNumber;
  rejoinBar.classList.toggle("hidden", !seatless);
  if (!seatless) return;
  const taken = new Set(state.players.filter((p) => p.seatNumber).map((p) => p.seatNumber));
  const cur = rejoinSeatInput.value;
  rejoinSeatInput.innerHTML = '<option value="">Auto seat</option>';
  for (let n = 1; n <= state.maxPlayers; n++) {
    if (taken.has(n)) continue;
    const opt = document.createElement("option");
    opt.value = String(n); opt.textContent = `Seat ${n}`;
    rejoinSeatInput.appendChild(opt);
  }
  rejoinSeatInput.value = cur;
}

function renderVoicePeers() {
  voicePeers.innerHTML = "";
  state.players.filter((p) => p.id !== playerId).forEach((p) => {
    const row = document.createElement("div");
    row.className = "voice-peer";
    let dotClass = "off";
    let label = "No voice";
    if (localStream && p.connected) {
      const status = voiceStatus.get(p.id) || "connecting";
      dotClass = speaking.get(p.id) ? "speaking" : status === "ready" ? "ready" : "connecting";
      label = speaking.get(p.id) ? "Speaking" : status === "ready" ? "Connected" : "Connecting…";
    } else if (!p.connected) {
      label = "Offline";
    }
    row.innerHTML = `<span>${escHtml(p.name)}</span><span class="vp-status"><span class="vp-dot ${dotClass}"></span>${label}</span>`;
    voicePeers.appendChild(row);
    if (localStream && p.connected) ensurePeer(p.id, true);
  });
}

// Tear down peer connections for players who are no longer seated/present,
// so a later rejoin gets a fresh connection instead of a stale dead one.
function cleanupStaleVoicePeers(activeIds) {
  for (const id of [...peers.keys()]) {
    if (!activeIds.has(id)) teardownPeer(id);
  }
}

function teardownPeer(targetId) {
  const pc = peers.get(targetId);
  if (pc) { try { pc.close(); } catch {} }
  peers.delete(targetId);
  pendingCandidates.delete(targetId);
  voiceStatus.delete(targetId);
  speaking.delete(targetId);
  const audio = document.querySelector(`[data-audio="${targetId}"]`);
  if (audio) audio.remove();
}

// ── Sound & reactions ─────────────────────────────────────────────────────────
function reactToStateChange(prev, cur) {
  if (!prev) return;
  if (prev.phase !== cur.phase) playSound(cur.phase === "showdown" ? "win" : "deal");
  if (prev.pot !== cur.pot) playSound("chips");
  const prevTurn = prev.players[prev.turnIndex]?.id;
  const curTurn  = cur.players[cur.turnIndex]?.id;
  if (curTurn === playerId && prevTurn !== curTurn) playSound("turn");
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem("pokerSound", soundEnabled ? "on" : "off");
  soundBtn.textContent = soundEnabled ? "Sound On" : "Sound Off";
}

function toggleAway() {
  const me = state?.players.find((p) => p.id === playerId);
  send("setAway", { away: !me?.sittingOut });
}

function addMessage(name, text) {
  const el = document.createElement("div");
  el.className = "message";
  el.innerHTML = `<strong>${escHtml(name)}</strong> ${escHtml(text)}`;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

function playSound(kind) {
  if (!soundEnabled) return;
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  const ctx = audioContext;
  const now = ctx.currentTime;
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  const map  = { deal: [440, 0.05], chips: [620, 0.06], turn: [780, 0.08], win: [880, 0.14] };
  const [freq, dur] = map[kind] || map.deal;
  osc.frequency.value = freq; osc.type = "sine";
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now); osc.stop(now + dur + 0.02);
}

// ── Voice ─────────────────────────────────────────────────────────────────────
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" }
];

async function startVoice() {
  if (!navigator.mediaDevices?.getUserMedia) { addMessage("Voice", "This browser does not support microphone access."); return; }
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    addMessage("Voice", "Voice chat needs HTTPS (or localhost) — browsers block the microphone on plain http:// for anyone but you.");
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (err) {
    addMessage("Voice", `Couldn't access your microphone (${err.name || "error"}). Check the browser's site permissions.`);
    return;
  }
  muteBtn.disabled = false; voiceBtn.disabled = true; voiceBtn.textContent = "Voice On";
  muteBtn.textContent = "Mute";
  send("setVoice", { muted: false });
  startLevelMeter(localStream, "local");
  state.players.filter((p) => p.id !== playerId && p.connected).forEach((p) => ensurePeer(p.id, true));
}

function toggleMute() {
  const willMute = muteBtn.textContent === "Mute"; // currently unmuted -> user wants to mute
  localStream?.getAudioTracks().forEach((t) => (t.enabled = !willMute));
  muteBtn.textContent = willMute ? "Unmute" : "Mute";
  send("setVoice", { muted: willMute });
}

function ensurePeer(targetId, polite) {
  if (peers.has(targetId) || !localStream) return peers.get(targetId);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers.set(targetId, pc);
  pendingCandidates.set(targetId, []);
  voiceStatus.set(targetId, "connecting");
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate) send("voiceSignal", { targetId, signal: { candidate: e.candidate } });
  });

  pc.addEventListener("track", (e) => {
    let audio = document.querySelector(`[data-audio="${targetId}"]`);
    if (!audio) { audio = document.createElement("audio"); audio.autoplay = true; audio.dataset.audio = targetId; audioMount.appendChild(audio); }
    audio.srcObject = e.streams[0];
    startLevelMeter(e.streams[0], targetId);
  });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected") voiceStatus.set(targetId, "ready");
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      // Drop it so the next state broadcast rebuilds a fresh connection.
      teardownPeer(targetId);
    }
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      voiceStatus.set(targetId, "ready");
    }
    if (pc.iceConnectionState === "failed" && pc.restartIce) pc.restartIce();
  });

  if (polite && playerId < targetId) {
    pc.createOffer().then((o) => pc.setLocalDescription(o))
      .then(() => send("voiceSignal", { targetId, signal: { description: pc.localDescription } }));
  }
  return pc;
}

async function handleVoiceSignal(payload) {
  if (!localStream) return; // voice not started locally yet — nothing to answer with
  const pc = ensurePeer(payload.fromId, false);
  const { signal } = payload;
  if (signal.description) {
    await pc.setRemoteDescription(signal.description);
    // Flush any ICE candidates that arrived before the remote description was set.
    const queued = pendingCandidates.get(payload.fromId) || [];
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch {}
    }
    pendingCandidates.set(payload.fromId, []);
    if (signal.description.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send("voiceSignal", { targetId: payload.fromId, signal: { description: pc.localDescription } });
    }
  }
  if (signal.candidate) {
    if (pc.remoteDescription) {
      try { await pc.addIceCandidate(signal.candidate); } catch {}
    } else {
      pendingCandidates.get(payload.fromId)?.push(signal.candidate);
    }
  }
}

// Lightweight speaking indicator: samples audio level from a MediaStream and
// toggles a "speaking" flag used to highlight the seat's mic badge and the
// voice peer list, so people can actually see that the mic is live.
function startLevelMeter(stream, key) {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const check = () => {
      if (key !== "local" && !peers.has(key)) return; // peer gone, stop this loop
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const isSpeaking = avg > 14;
      if (speaking.get(key) !== isSpeaking) {
        speaking.set(key, isSpeaking);
        const badge = document.querySelector(`[data-mic="${key === "local" ? playerId : key}"]`);
        if (badge) badge.classList.toggle("speaking", isSpeaking);
        if (key !== "local" && state) renderVoicePeers();
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  } catch {
    // Web Audio unavailable — the mic still works, we just skip the visual indicator.
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function copyRoomCode() {
  const url = new URL(location.href);
  url.searchParams.set("room", roomCode);
  navigator.clipboard?.writeText(url.toString());
  copyCodeBtn.textContent = "Copied!";
  setTimeout(() => (copyCodeBtn.textContent = "Copy Invite Link"), 2000);
}

function readSavedSeat(code) {
  try { return JSON.parse(localStorage.getItem(`pokerSeat:${code}`) || "null"); } catch { return null; }
}
function saveSeat(code, name, token) {
  localStorage.setItem(`pokerSeat:${code}`, JSON.stringify({ name, token }));
}

const suitMap = { S: "♠", H: "♥", D: "♦", C: "♣" };
function suit(s) { return suitMap[s] || s; }
function rnk(r)  { return r === "T" ? "10" : r; }
function isRed(card) { return card.suit === "H" || card.suit === "D"; }
function escHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

// ── Auto-rejoin on page refresh ───────────────────────────────────────────────
window.addEventListener("load", () => {
  const savedName = localStorage.getItem("pokerName");
  const roomFromUrl = new URLSearchParams(location.search).get("room");
  const savedRoom = roomFromUrl || localStorage.getItem("pokerLastRoom");
  if (!savedName || !savedRoom) return;

  // KEY FIX: only auto-reconnect if sessionStorage confirms this was an active session
  // (i.e. this is a refresh, not a friend opening the invite link fresh)
  const activeRoom = sessionStorage.getItem("pokerActive");
  if (activeRoom !== savedRoom) {
    // This is a fresh open — just pre-fill the room code, don't auto-connect
    roomInput.value = savedRoom;
    return;
  }

  const savedSeat = readSavedSeat(savedRoom);
  if (!savedSeat?.token || savedSeat?.name !== savedName) return;

  roomInput.value = savedRoom;
  notice.textContent = "Reconnecting to your table…";
  connect("joinRoom");
});
