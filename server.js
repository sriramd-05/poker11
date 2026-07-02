const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const STARTING_STACK = 2000;
const MIN_BUY_IN = 100;
const MAX_BUY_IN = 100000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const TURN_MS = 30000;
const MAX_PLAYERS = 10;

const rooms = new Map();
const clients = new Map();

const server = http.createServer((req, res) => {
  let requested = decodeURIComponent(req.url.split("?")[0]);
  if (requested === "/") requested = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(content);
  });
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );

  const client = {
    id: id("c"),
    socket,
    roomCode: null,
    playerId: null,
    buffer: Buffer.alloc(0)
  };
  clients.set(client.id, client);

  socket.on("data", (chunk) => handleSocketData(client, chunk));
  socket.on("close", () => disconnect(client));
  socket.on("error", () => disconnect(client));
});

server.listen(PORT, () => {
  console.log(`Friends Poker is running at http://localhost:${PORT}`);
});

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
}

function handleSocketData(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const second = client.buffer[1];
    let offset = 2;
    let length = second & 0x7f;

    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const high = client.buffer.readUInt32BE(2);
      const low = client.buffer.readUInt32BE(6);
      length = high * 2 ** 32 + low;
      offset = 10;
    }

    const masked = (second & 0x80) !== 0;
    const maskOffset = masked ? offset : -1;
    const dataOffset = masked ? offset + 4 : offset;
    const frameLength = dataOffset + length;
    if (client.buffer.length < frameLength) return;

    const opcode = client.buffer[0] & 0x0f;
    if (opcode === 8) {
      client.socket.end();
      return;
    }

    if (opcode === 1) {
      const payload = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) {
        const source = client.buffer[dataOffset + i];
        payload[i] = masked ? source ^ client.buffer[maskOffset + (i % 4)] : source;
      }

      try {
        handleMessage(client, JSON.parse(payload.toString("utf8")));
      } catch (error) {
        send(client, "error", { message: "Could not read that message." });
      }
    }

    client.buffer = client.buffer.slice(frameLength);
  }
}

function handleMessage(client, message) {
  const { type, payload = {} } = message;
  if (type === "createRoom") createRoom(client, payload);
  if (type === "joinRoom") joinRoom(client, payload);
  if (type === "startHand") startHandForClient(client);
  if (type === "action") playerAction(client, payload);
  if (type === "chat") chat(client, payload);
  if (type === "voiceSignal") voiceSignal(client, payload);
  if (type === "setVoice") setVoice(client, payload);
  if (type === "requestChips") requestChips(client, payload);
  if (type === "approveChips") approveChips(client, payload);
  if (type === "setAway") setAway(client, payload);
  if (type === "pauseGame") pauseGame(client, payload);
  if (type === "showCards") showCards(client);
  if (type === "leaveSeat") leaveSeat(client);
  if (type === "rejoinSeat") rejoinSeat(client, payload);
}

function createRoom(client, payload) {
  const room = makeRoom();
  rooms.set(room.code, room);
  joinExistingRoom(client, room, payload, true);
}

function joinRoom(client, payload) {
  const code = String(payload.code || "").trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    send(client, "error", { message: "Room not found." });
    return;
  }
  joinExistingRoom(client, room, payload, false);
}

function joinExistingRoom(client, room, payload, owner = false) {
  const trimmed = cleanName(payload.name);
  const requestedToken = String(payload.token || "").trim();
  const existing = room.players.find((player) => player.token === requestedToken);
  const seatedCount = room.players.filter((player) => player.seatNumber).length;
  if (!existing && seatedCount >= MAX_PLAYERS) {
    send(client, "error", { message: "This table is full." });
    return;
  }
  const seatNumber = existing?.seatNumber || chooseSeat(room, payload.seatNumber);
  if (!existing && !seatNumber) {
    send(client, "error", { message: "That seat is already taken." });
    return;
  }

  const buyIn = clampChips(payload.buyIn || STARTING_STACK);
  const seat = existing || {
    id: id("p"),
    token: id("t"),
    name: trimmed,
    seatNumber,
    stack: buyIn,
    bet: 0,
    totalBet: 0,
    hand: [],
    folded: false,
    allIn: false,
    acted: false,
    showCards: false,
    sittingOut: false,
    left: false,
    connected: true,
    muted: false,
    stats: makeStats(buyIn)
  };

  if (!existing) {
    room.players.push(seat);
    sortPlayersBySeat(room);
  }
  if (owner || !room.ownerId) room.ownerId = seat.id;
  seat.name = trimmed;
  seat.left = false;
  seat.connected = true;
  client.roomCode = room.code;
  client.playerId = seat.id;
  client.playerToken = seat.token;

  send(client, "joined", { roomCode: room.code, playerId: seat.id, token: seat.token, owner: room.ownerId === seat.id });
  addLedger(room, existing ? "rejoin" : "join", seat, existing ? `${seat.name} rejoined seat ${seat.seatNumber} with ${seat.stack} chips.` : `${seat.name} joined seat ${seat.seatNumber} with ${seat.stack} chips.`);
  broadcast(room, "system", { message: existing ? `${seat.name} rejoined the table.` : `${seat.name} joined with ${seat.stack} chips.` });
  broadcastState(room);
}

function startHandForClient(client) {
  const room = getRoom(client);
  if (!room) return;
  if (room.paused) {
    broadcast(room, "system", { message: "Game is paused by the owner." });
    return;
  }
  if (room.phase !== "waiting" && room.phase !== "showdown") return;
  const seated = room.players.filter((player) => player.seatNumber && player.stack > 0 && !player.sittingOut);
  if (seated.length < 2) {
    broadcast(room, "system", { message: "Need at least two players with chips to start." });
    return;
  }
  startHand(room);
}

function playerAction(client, payload) {
  const room = getRoom(client);
  const player = getPlayer(client);
  if (!room || !player || room.phase === "waiting" || room.phase === "showdown") return;
  if (room.paused || player.sittingOut) return;
  if (room.players[room.turnIndex]?.id !== player.id) return;

  const callAmount = Math.max(0, room.currentBet - player.bet);
  const minimumRaise = BIG_BLIND;
  const action = payload.action;
  const amount = Math.max(0, Number(payload.amount) || 0);
  let handled = false;

  if (action === "fold") {
    player.folded = true;
    player.acted = true;
    room.log.unshift(`${player.name} folded.`);
    handled = true;
  }

  if (action === "check") {
    if (callAmount > 0) return;
    player.acted = true;
    room.log.unshift(`${player.name} checked.`);
    handled = true;
  }

  if (action === "call") {
    const paid = takeChips(player, callAmount);
    player.acted = true;
    room.pot += paid;
    room.log.unshift(callAmount ? `${player.name} called ${paid}.` : `${player.name} checked.`);
    handled = true;
  }

  if (action === "raise") {
    const targetBet = Math.max(room.currentBet + minimumRaise, amount);
    const needed = Math.max(0, targetBet - player.bet);
    if (needed <= callAmount || player.stack <= 0) return;
    const paid = takeChips(player, needed);
    room.pot += paid;
    if (player.bet > room.currentBet) {
      room.currentBet = player.bet;
      room.lastAggressor = room.turnIndex;
      resetActed(room);
    }
    player.acted = true;
    room.log.unshift(`${player.name} raised to ${player.bet}.`);
    handled = true;
  }

  if (action === "allIn") {
    const paid = takeChips(player, player.stack);
    room.pot += paid;
    if (player.bet > room.currentBet) {
      room.currentBet = player.bet;
      room.lastAggressor = room.turnIndex;
      resetActed(room);
    }
    player.allIn = true;
    player.acted = true;
    room.log.unshift(`${player.name} moved all-in.`);
    handled = true;
  }

  if (handled) afterAction(room);
}

function chat(client, payload) {
  const room = getRoom(client);
  const player = getPlayer(client);
  if (!room || !player) return;
  const text = String(payload.text || "").trim().slice(0, 240);
  if (!text) return;
  broadcast(room, "chat", { playerId: player.id, name: player.name, text, at: Date.now() });
}

function requestChips(client, payload) {
  const room = getRoom(client);
  const player = getPlayer(client);
  if (!room || !player) return;
  const amount = clampChips(payload.amount || STARTING_STACK);
  const request = {
    id: id("r"),
    playerId: player.id,
    name: player.name,
    amount,
    at: Date.now()
  };
  room.chipRequests = room.chipRequests.filter((item) => item.playerId !== player.id);
  room.chipRequests.push(request);
  room.log.unshift(`${player.name} requested ${amount} chips.`);
  broadcast(room, "system", { message: `${player.name} requested ${amount} chips from the owner.` });
  broadcastState(room);
}

function approveChips(client, payload) {
  const room = getRoom(client);
  const owner = getPlayer(client);
  if (!room || !owner || owner.id !== room.ownerId) return;
  const request = room.chipRequests.find((item) => item.id === payload.requestId);
  if (!request) return;
  const player = room.players.find((seat) => seat.id === request.playerId);
  if (!player) return;
  const amount = clampChips(payload.amount || request.amount);
  player.stack += amount;
  player.folded = false;
  player.allIn = false;
  player.sittingOut = false;
  player.stats.buyIns += amount;
  player.stats.rebuys += 1;
  player.stats.chipsAdded += amount;
  room.chipRequests = room.chipRequests.filter((item) => item.id !== request.id);
  room.log.unshift(`${owner.name} added ${amount} chips to ${player.name}.`);
  broadcast(room, "system", { message: `${owner.name} added ${amount} chips to ${player.name}.` });
  broadcastState(room);
}

function setAway(client, payload) {
  const room = getRoom(client);
  const player = getPlayer(client);
  if (!room || !player) return;
  const away = Boolean(payload.away);
  player.sittingOut = away;
  if (away && player.hand.length && !player.folded && room.phase !== "waiting" && room.phase !== "showdown") {
    player.folded = true;
    player.acted = true;
    room.log.unshift(`${player.name} is away and folded.`);
    if (room.players[room.turnIndex]?.id === player.id) {
      afterAction(room);
      return;
    }
  }
  room.log.unshift(`${player.name} is ${away ? "away" : "back"}.`);
  broadcastState(room);
}

function pauseGame(client, payload) {
  const room = getRoom(client);
  const player = getPlayer(client);
  if (!room || !player || player.id !== room.ownerId) return;
  room.paused = Boolean(payload.paused);
  room.log.unshift(`${player.name} ${room.paused ? "paused" : "resumed"} the game.`);
  if (room.paused) {
    clearTurnTimer(room);
    if (room.autoStartTimer) { clearTimeout(room.autoStartTimer); room.autoStartTimer = null; }
    broadcastState(room);
    return;
  }
  if (room.phase !== "waiting" && room.phase !== "showdown" && room.turnIndex !== -1) {
    beginTurn(room);
    return;
  }
  broadcastState(room);
}

function voiceSignal(client, payload) {
  const room = getRoom(client);
  const player = getPlayer(client);
  if (!room || !player) return;
  const target = room.players.find((seat) => seat.id === payload.targetId);
  if (!target) return;
  for (const recipient of clients.values()) {
    if (recipient.roomCode === room.code && recipient.playerId === target.id) {
      send(recipient, "voiceSignal", {
        fromId: player.id,
        signal: payload.signal
      });
    }
  }
}

function setVoice(client, payload) {
  const room = getRoom(client);
  const player = getPlayer(client);
  if (!room || !player) return;
  player.muted = Boolean(payload.muted);
  broadcastState(room);
}

function leaveSeat(client) {
  const room = getRoom(client);
  const player = getPlayer(client);
  if (!room || !player || !player.seatNumber) return;
  const oldSeat = player.seatNumber;
  const wasTurn = room.players[room.turnIndex]?.id === player.id;
  if (player.hand.length && !player.folded && room.phase !== "waiting" && room.phase !== "showdown") {
    player.folded = true;
    player.acted = true;
  }
  player.seatNumber = null;
  player.sittingOut = true;
  room.chipRequests = room.chipRequests.filter((item) => item.playerId !== player.id);
  addLedger(room, "leave", player, `${player.name} left seat ${oldSeat} with ${player.stack} chips.`);
  broadcast(room, "system", { message: `${player.name} left the table with ${player.stack} chips.` });
  if (wasTurn && room.phase !== "waiting" && room.phase !== "showdown") {
    afterAction(room);
    return;
  }
  broadcastState(room);
}

function rejoinSeat(client, payload) {
  const room = getRoom(client);
  const player = getPlayer(client);
  if (!room || !player || player.seatNumber) return;
  const seatNumber = chooseSeat(room, payload.seatNumber);
  if (!seatNumber) {
    send(client, "error", { message: "That seat is already taken." });
    return;
  }
  player.seatNumber = seatNumber;
  player.sittingOut = false;
  addLedger(room, "rejoin", player, `${player.name} rejoined seat ${seatNumber} with ${player.stack} chips.`);
  broadcast(room, "system", { message: `${player.name} took seat ${seatNumber}.` });
  broadcastState(room);
}

function addLedger(room, type, player, message) {
  room.ledger.unshift({
    id: id("l"),
    type,
    playerId: player.id,
    name: player.name,
    seatNumber: player.seatNumber,
    stack: player.stack,
    message,
    at: Date.now()
  });
  if (room.ledger.length > 200) room.ledger.length = 200;
}

function makeRoom() {
  return {
    code: roomCode(),
    players: [],
    ownerId: null,
    chipRequests: [],
    ledger: [],
    paused: false,
    deck: [],
    board: [],
    pot: 0,
    dealerIndex: -1,
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND,
    currentBet: 0,
    turnIndex: -1,
    lastAggressor: -1,
    phase: "waiting",
    log: ["Create a private table, invite friends, and start a hand."],
    timer: null,
    autoStartTimer: null,
    autoStartDeadline: null,
    turnDeadline: null,
    lastWin: null
  };
}

function startHand(room) {
  clearTurnTimer(room);
  room.deck = shuffledDeck();
  room.board = [];
  room.pot = 0;
  room.currentBet = 0;
  room.phase = "preflop";
  room.log = [];
  room.lastWin = null;
  room.autoStartDeadline = null;

  room.players.forEach((player) => {
    player.hand = player.seatNumber && player.stack > 0 && !player.sittingOut ? [room.deck.pop(), room.deck.pop()] : [];
    player.bet = 0;
    player.totalBet = 0;
    player.folded = player.stack <= 0;
    player.allIn = false;
    player.acted = false;
    player.showCards = false;
    if (player.hand.length) player.stats.hands += 1;
  });

  room.dealerIndex = nextActiveIndex(room, room.dealerIndex);
  const sbIndex = nextActiveIndex(room, room.dealerIndex);
  const bbIndex = nextActiveIndex(room, sbIndex);
  postBlind(room, sbIndex, room.smallBlind, "small blind");
  postBlind(room, bbIndex, room.bigBlind, "big blind");
  room.currentBet = room.players[bbIndex].bet;
  room.lastAggressor = bbIndex;
  room.turnIndex = nextActiveIndex(room, bbIndex);
  room.log.unshift("New hand started.");
  beginTurn(room);
}

function postBlind(room, index, amount, label) {
  const player = room.players[index];
  const paid = takeChips(player, amount);
  room.pot += paid;
  room.log.unshift(`${player.name} posted ${label} ${paid}.`);
}

function afterAction(room) {
  clearTurnTimer(room);
  const contenders = room.players.filter((player) => player.hand.length && !player.folded);
  if (contenders.length === 1) {
    awardPot(room, contenders[0], `${contenders[0].name} wins ${room.pot}.`);
    return;
  }

  if (bettingRoundComplete(room)) {
    advancePhase(room);
    return;
  }

  room.turnIndex = nextActionIndex(room, room.turnIndex);
  beginTurn(room);
}

function bettingRoundComplete(room) {
  const active = room.players.filter((player) => player.hand.length && !player.folded && !player.allIn);
  if (active.length === 0) return true;
  return active.every((player) => player.bet === room.currentBet && player.acted);
}

function advancePhase(room) {
  room.players.forEach((player) => {
    player.bet = 0;
    player.acted = false;
  });
  room.currentBet = 0;
  room.lastAggressor = -1;

  if (room.phase === "preflop") {
    room.board.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    room.phase = "flop";
    room.log.unshift("Flop dealt.");
  } else if (room.phase === "flop") {
    room.board.push(room.deck.pop());
    room.phase = "turn";
    room.log.unshift("Turn dealt.");
  } else if (room.phase === "turn") {
    room.board.push(room.deck.pop());
    room.phase = "river";
    room.log.unshift("River dealt.");
  } else {
    showdown(room);
    return;
  }

  const next = nextActionIndex(room, room.dealerIndex);
  if (next === -1) {
    advancePhase(room);
    return;
  }
  room.turnIndex = next;
  beginTurn(room);
}

function resetActed(room) {
  room.players.forEach((player) => {
    if (player.hand.length && !player.folded && !player.allIn) player.acted = false;
  });
}

// ── Side pot calculation ──────────────────────────────────────────────────────
function calculateSidePots(room) {
  // All players who put chips in this hand (including folded)
  const contributors = room.players.filter((p) => p.totalBet > 0);
  // Players still in contention at showdown
  const contenders = room.players.filter((p) => p.hand.length && !p.folded);
  if (contenders.length === 0 || contributors.length === 0) return [];

  // Build pots level-by-level from smallest all-in upward
  const levels = [...new Set(contributors.map((p) => p.totalBet))].sort((a, b) => a - b);
  const pots = [];
  let prevLevel = 0;

  for (const level of levels) {
    const slice = level - prevLevel;
    const inThisLevel = contributors.filter((p) => p.totalBet >= level).length;
    const amount = slice * inThisLevel;
    const eligible = contenders.filter((p) => p.totalBet >= level);
    if (amount > 0 && eligible.length > 0) pots.push({ amount, eligible });
    prevLevel = level;
  }
  return pots;
}

function showdown(room) {
  clearTurnTimer(room);
  const pots = calculateSidePots(room);

  if (pots.length === 0) {
    // Fallback: no contributors tracked, award to last contender
    const contenders = room.players.filter((p) => p.hand.length && !p.folded);
    if (contenders.length > 0) awardPot(room, contenders[0], `${contenders[0].name} wins ${room.pot}.`);
    return;
  }

  const logLines = [];
  let mainWinEntry = null;

  for (let i = 0; i < pots.length; i++) {
    const { amount, eligible } = pots[i];
    const ranked = eligible
      .map((p) => ({ player: p, score: bestHand([...p.hand, ...room.board]) }))
      .sort((a, b) => compareScores(b.score, a.score));
    const best = ranked[0];
    const winners = ranked.filter((e) => compareScores(e.score, best.score) === 0);
    const share = Math.floor(amount / winners.length);
    winners.forEach((e) => {
      e.player.stack += share;
      e.player.showCards = true;
      e.player.stats.wins += 1;
      e.player.stats.chipsWon += share;
      e.player.stats.biggestPot = Math.max(e.player.stats.biggestPot || 0, share);
    });
    const label = pots.length > 1 ? (i === pots.length - 1 ? "main pot" : `side pot ${i + 1}`) : "pot";
    const line = `${winners.map((e) => e.player.name).join(" & ")} win ${share} (${label}) with ${best.score.name}.`;
    logLines.push(line);
    if (i === pots.length - 1) {
      mainWinEntry = { names: winners.map((e) => e.player.name), handName: best.score.name, amount: share };
    }
  }

  room.log.unshift(...logLines.reverse());
  room.pot = 0;
  room.phase = "showdown";
  room.turnIndex = -1;
  room.lastWin = mainWinEntry;
  broadcastState(room);
  scheduleAutoStart(room);
}

function awardPot(room, player, message) {
  clearTurnTimer(room);
  const won = room.pot;
  player.stack += won;
  player.stats.wins += 1;
  player.stats.chipsWon += won;
  player.stats.biggestPot = Math.max(player.stats.biggestPot || 0, won);
  room.pot = 0;
  room.phase = "showdown";
  room.turnIndex = -1;
  room.log.unshift(message);
  room.lastWin = { names: [player.name], handName: null, amount: won };
  broadcastState(room);
  scheduleAutoStart(room);
}

function showCards(client) {
  const room = getRoom(client);
  const player = getPlayer(client);
  if (!room || !player || room.phase !== "showdown" || !player.hand.length) return;
  player.showCards = true;
  room.log.unshift(`${player.name} showed their cards.`);
  broadcastState(room);
}

function beginTurn(room) {
  if (room.turnIndex === -1) {
    advancePhase(room);
    return;
  }
  if (room.paused) {
    room.turnDeadline = null;
    broadcastState(room);
    return;
  }
  room.turnDeadline = Date.now() + TURN_MS;
  room.timer = setTimeout(() => {
    const player = room.players[room.turnIndex];
    if (player && !player.folded) {
      if (room.currentBet > player.bet) player.folded = true;
      room.log.unshift(`${player.name} timed out.`);
      afterAction(room);
    }
  }, TURN_MS);
  broadcastState(room);
}

function clearTurnTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.turnDeadline = null;
}

function nextActiveIndex(room, fromIndex) {
  for (let step = 1; step <= room.players.length; step += 1) {
    const index = (fromIndex + step + room.players.length) % room.players.length;
    if (room.players[index].seatNumber && room.players[index].stack > 0 && !room.players[index].sittingOut) return index;
  }
  return -1;
}

function nextActionIndex(room, fromIndex) {
  for (let step = 1; step <= room.players.length; step += 1) {
    const index = (fromIndex + step + room.players.length) % room.players.length;
    const player = room.players[index];
    if (player.hand.length && !player.folded && !player.allIn && player.seatNumber && player.stack > 0 && !player.sittingOut) return index;
  }
  return -1;
}

function takeChips(player, amount) {
  const paid = Math.min(player.stack, Math.max(0, amount));
  player.stack -= paid;
  player.bet += paid;
  player.totalBet += paid;
  if (player.stack === 0) player.allIn = true;
  return paid;
}

function broadcastState(room) {
  for (const client of clients.values()) {
    if (client.roomCode === room.code) {
      const player = room.players.find((seat) => seat.id === client.playerId);
      send(client, "state", publicState(room, player?.id));
    }
  }
}

function publicState(room, viewerId) {
  return {
    code: room.code,
    phase: room.phase,
    board: room.board,
    pot: room.pot,
    roundPot: room.players.reduce((sum, player) => sum + player.bet, 0),
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    maxPlayers: MAX_PLAYERS,
    ownerId: room.ownerId,
    paused: room.paused,
    currentBet: room.currentBet,
    turnIndex: room.turnIndex,
    turnDeadline: room.turnDeadline,
    dealerIndex: room.dealerIndex,
    log: room.log.slice(0, 8),
    chipRequests: room.chipRequests,
    ledger: room.ledger.slice(0, 100),
    nextHandDeadline: room.autoStartDeadline || null,
    lastWin: room.lastWin || null,
    players: room.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      seatNumber: player.seatNumber,
      stack: player.stack,
      bet: player.bet,
      folded: player.folded,
      allIn: player.allIn,
      connected: player.connected,
      muted: player.muted,
      sittingOut: player.sittingOut,
      showingCards: player.showCards,
      isOwner: player.id === room.ownerId,
      stats: player.stats,
      dealer: index === room.dealerIndex,
      isTurn: index === room.turnIndex,
      cards: visibleCardsFor(player, viewerId, room.phase)
    }))
  };
}

function visibleCardsFor(player, viewerId, phase) {
  if (player.id === viewerId) return player.hand;
  if (phase === "showdown" && player.showCards) return player.hand;
  return player.hand.map(() => null);
}

function makeStats(buyIn) {
  return {
    hands: 0,
    wins: 0,
    buyIns: buyIn,
    rebuys: 0,
    chipsAdded: 0,
    chipsWon: 0,
    biggestPot: 0
  };
}

function chooseSeat(room, requested) {
  const number = Math.round(Number(requested) || 0);
  const taken = new Set(room.players.map((player) => player.seatNumber));
  if (number >= 1 && number <= MAX_PLAYERS && !taken.has(number)) return number;
  for (let seat = 1; seat <= MAX_PLAYERS; seat += 1) {
    if (!taken.has(seat)) return seat;
  }
  return null;
}

function sortPlayersBySeat(room) {
  room.players.sort((a, b) => a.seatNumber - b.seatNumber);
}

function clampChips(value) {
  const amount = Math.round(Number(value) || STARTING_STACK);
  return Math.min(MAX_BUY_IN, Math.max(MIN_BUY_IN, amount));
}

function broadcast(room, type, payload) {
  for (const client of clients.values()) {
    if (client.roomCode === room.code) send(client, type, payload);
  }
}

function send(client, type, payload) {
  if (client.socket.destroyed) return;
  const json = Buffer.from(JSON.stringify({ type, payload }), "utf8");
  let header;
  if (json.length < 126) {
    header = Buffer.from([0x81, json.length]);
  } else if (json.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(json.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(json.length, 6);
  }
  client.socket.write(Buffer.concat([header, json]));
}

function scheduleAutoStart(room) {
  if (room.autoStartTimer) clearTimeout(room.autoStartTimer);
  const delay = 6000;
  room.autoStartDeadline = Date.now() + delay;
  broadcastState(room);
  room.autoStartTimer = setTimeout(() => {
    room.autoStartTimer = null;
    room.autoStartDeadline = null;
    if (room.paused) return;
    const seated = room.players.filter((p) => p.seatNumber && p.stack > 0 && !p.sittingOut);
    if (seated.length >= 2) startHand(room);
  }, delay);
}

function disconnect(client) {
  if (!clients.has(client.id)) return;
  clients.delete(client.id);
  const room = getRoom(client);
  const player = getPlayer(client);
  if (room && player) {
    const stillConnected = [...clients.values()].some((other) => {
      return other.roomCode === room.code && other.playerId === player.id;
    });
    if (!stillConnected) {
      player.connected = false;
      broadcast(room, "system", { message: `${player.name} disconnected.` });
      broadcastState(room);
    }
  }
}

// Heartbeat: ping all clients every 25s to detect stale connections
setInterval(() => {
  for (const client of clients.values()) {
    try {
      // Send a raw WebSocket ping frame (opcode 0x89)
      client.socket.write(Buffer.from([0x89, 0x00]));
    } catch {
      disconnect(client);
    }
  }
}, 25000);

function getRoom(client) {
  return client.roomCode ? rooms.get(client.roomCode) : null;
}

function getPlayer(client) {
  const room = getRoom(client);
  return room ? room.players.find((player) => player.id === client.playerId) : null;
}

function shuffledDeck() {
  const suits = ["S", "H", "D", "C"];
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) deck.push({ rank, suit });
  }
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function bestHand(cards) {
  const combos = combinations(cards, 5);
  return combos.map(scoreHand).sort(compareScores).at(-1);
}

function scoreHand(cards) {
  const values = cards.map((card) => rankValue(card.rank)).sort((a, b) => b - a);
  const counts = groupCounts(values);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const straightHigh = straightHighCard(values);
  const groups = Object.entries(counts)
    .map(([value, count]) => ({ value: Number(value), count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  if (flush && straightHigh) return namedScore(8, [straightHigh], "straight flush");
  if (groups[0].count === 4) return namedScore(7, [groups[0].value, kicker(values, [groups[0].value])], "four of a kind");
  if (groups[0].count === 3 && groups[1].count === 2) return namedScore(6, [groups[0].value, groups[1].value], "full house");
  if (flush) return namedScore(5, values, "flush");
  if (straightHigh) return namedScore(4, [straightHigh], "straight");
  if (groups[0].count === 3) return namedScore(3, [groups[0].value, ...kickers(values, [groups[0].value], 2)], "three of a kind");
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairs = groups.filter((group) => group.count === 2).map((group) => group.value).sort((a, b) => b - a);
    return namedScore(2, [...pairs, kicker(values, pairs)], "two pair");
  }
  if (groups[0].count === 2) return namedScore(1, [groups[0].value, ...kickers(values, [groups[0].value], 3)], "one pair");
  return namedScore(0, values, "high card");
}

function namedScore(category, values, name) {
  return { category, values, name };
}

function compareScores(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const length = Math.max(a.values.length, b.values.length);
  for (let i = 0; i < length; i += 1) {
    if ((a.values[i] || 0) !== (b.values[i] || 0)) return (a.values[i] || 0) - (b.values[i] || 0);
  }
  return 0;
}

function rankValue(rank) {
  return "23456789TJQKA".indexOf(rank) + 2;
}

function groupCounts(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function straightHighCard(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let i = 0; i <= unique.length - 5; i += 1) {
    const slice = unique.slice(i, i + 5);
    if (slice[0] - slice[4] === 4) return slice[0];
  }
  return 0;
}

function kicker(values, used) {
  return values.find((value) => !used.includes(value)) || 0;
}

function kickers(values, used, count) {
  return values.filter((value) => !used.includes(value)).slice(0, count);
}

function combinations(items, count) {
  const result = [];
  function pick(start, combo) {
    if (combo.length === count) {
      result.push(combo);
      return;
    }
    for (let i = start; i < items.length; i += 1) pick(i + 1, [...combo, items[i]]);
  }
  pick(0, []);
  return result;
}

function roomCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function cleanName(name) {
  return String(name).trim().replace(/\s+/g, " ").slice(0, 24) || "Player";
}
