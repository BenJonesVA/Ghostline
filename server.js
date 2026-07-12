'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || undefined;

// Signaling payloads are just JSON (SDP text, ICE candidate strings, small
// metadata) — a few KB at most. Capping this well below Socket.io's 1MB
// default limits the blast radius of a malicious/buggy client flooding the
// signaling channel; it never touches media or file bytes (those are P2P).
const MAX_SIGNALING_PAYLOAD_BYTES = 100 * 1024;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN || true,
    methods: ['GET', 'POST'],
  },
  // The `cors` option above only controls response headers, which browsers
  // only enforce for XHR/fetch reads — it does nothing for the websocket
  // transport this app uses exclusively, since WebSocket handshakes aren't
  // subject to CORS at all. allowRequest is what actually rejects a
  // handshake from a disallowed origin at the server, regardless of
  // transport. Skipped entirely when ALLOWED_ORIGIN is unset (local/dev).
  allowRequest: (req, callback) => {
    if (!ALLOWED_ORIGIN) return callback(null, true);
    callback(null, req.headers.origin === ALLOWED_ORIGIN);
  },
  // websocket-only: no long-polling fallback. Removes an entire transport's
  // attack surface and request-logging exposure on intermediary proxies. Any
  // network hostile enough to block WebSocket already blocks the WebRTC UDP
  // traffic this app fundamentally needs, so there's no real connectivity to
  // preserve here.
  transports: ['websocket'],
  maxHttpBufferSize: MAX_SIGNALING_PAYLOAD_BYTES,
});

// ---------------------------------------------------------------------------
// Security headers. Hand-rolled (not helmet defaults) so the CSP matches
// exactly what this page needs. Tailwind and the QR library are vendored
// into public/vendor/ (version-pinned, SRI-checked in index.html) rather
// than loaded from a CDN at request time, so script-src is 'self' only —
// no third-party origin is trusted to serve executable code.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws: wss:",
      "img-src 'self' data:",
      "media-src 'self' blob:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  // Safe to enable now that every subresource is same-origin (vendored) —
  // isolates this page's browsing context/process from cross-origin pages.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});

// No request logging middleware is added anywhere in this file — that is the
// zero-log guarantee. Do not add morgan or similar.
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// ICE server configuration. STUN is always included; TURN is appended only
// if configured via env vars, so the app runs STUN-only with no config.
// ---------------------------------------------------------------------------
// TURN credential TTL for the use-auth-secret (time-limited) scheme below.
// Short enough that a leaked credential is useless soon after; long enough to
// outlast any single call setup.
const TURN_CREDENTIAL_TTL_SECONDS = 3600;

// Cross-network calls (e.g. both peers behind carrier-grade NAT or a
// restrictive firewall) can fail on STUN alone — TURN relays the media as a
// fallback. Two ways to supply it:
//   - TURN_SECRET set: derive short-lived HMAC credentials per session
//     (coturn's `use-auth-secret` mode — recommended, avoids a long-lived
//     shared password ever leaving the server).
//   - TURN_USERNAME/TURN_CREDENTIAL set: static long-term credentials
//     (simpler, fine for a trusted/self-hosted deployment).
function buildIceServers() {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];

  if (!process.env.TURN_URL) return iceServers;
  const urls = process.env.TURN_URL.split(',').map((u) => u.trim()).filter(Boolean);

  if (process.env.TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_SECONDS}`;
    const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
    iceServers.push({ urls, username, credential });
  } else if (process.env.TURN_USERNAME) {
    iceServers.push({
      urls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  return iceServers;
}

// ---------------------------------------------------------------------------
// In-memory room state. Never persisted. Purged synchronously on disconnect.
// ---------------------------------------------------------------------------
const rooms = new Map(); // roomId -> { sockets: Set<socketId>, reaperTimer: Timeout|null }

// A created-but-never-joined room stays guessable/shareable indefinitely
// otherwise. Auto-expire it after this TTL so an idle/forgotten code has a
// bounded lifetime. Cancelled the moment a second peer actually joins.
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 10 * 60 * 1000;

function expireRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('room-expired');
  rooms.delete(roomId);
}

// A room is "idle and guessable" whenever it has exactly one occupant —
// either nobody has joined yet, or a peer left mid-call and it's waiting on
// a reconnect. Arm/disarm around that single condition so both cases expire
// the same way instead of only covering the initial pre-join wait.
function armReaper(roomId, room) {
  if (room.reaperTimer) clearTimeout(room.reaperTimer);
  room.reaperTimer = setTimeout(() => expireRoom(roomId), ROOM_TTL_MS);
}

function disarmReaper(room) {
  if (room.reaperTimer) {
    clearTimeout(room.reaperTimer);
    room.reaperTimer = null;
  }
}

const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const ROOM_ID_LENGTH = 6;

function generateRoomId() {
  let roomId;
  do {
    roomId = '';
    for (let i = 0; i < ROOM_ID_LENGTH; i++) {
      roomId += ROOM_ID_ALPHABET[crypto.randomInt(ROOM_ID_ALPHABET.length)];
    }
  } while (rooms.has(roomId));
  return roomId;
}

// Per-socket rate limiting for room create/join attempts. Keyed on the
// socket, never on IP, so no client-identifying data is retained.
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

function isRateLimited(socket) {
  const now = Date.now();
  const attempts = (socket.data.attempts || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  attempts.push(now);
  socket.data.attempts = attempts;
  return attempts.length > RATE_LIMIT_MAX_ATTEMPTS;
}

function cleanupSocket(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.sockets.delete(socket.id);
  socket.data.roomId = undefined;

  if (room.sockets.size === 0) {
    disarmReaper(room);
    rooms.delete(roomId);
  } else {
    socket.to(roomId).emit('peer-left');
    armReaper(roomId, room);
  }
}

io.on('connection', (socket) => {
  socket.data.attempts = [];

  socket.on('create-room', () => {
    if (isRateLimited(socket)) {
      socket.emit('join-error', { reason: 'rate-limited' });
      return;
    }
    const roomId = generateRoomId();
    const room = { sockets: new Set([socket.id]), reaperTimer: null };
    rooms.set(roomId, room);
    armReaper(roomId, room);
    socket.data.roomId = roomId;
    socket.join(roomId);
    socket.emit('room-created', { roomId, iceServers: buildIceServers() });
  });

  socket.on('join-room', ({ roomId } = {}) => {
    if (isRateLimited(socket)) {
      socket.emit('join-error', { reason: 'rate-limited' });
      return;
    }
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('join-error', { reason: 'not-found' });
      return;
    }
    if (room.sockets.size >= 2) {
      socket.emit('join-error', { reason: 'room-full' });
      return;
    }

    // Second peer has arrived — the room is no longer "idle and guessable",
    // so the expiry timer no longer applies.
    disarmReaper(room);

    room.sockets.add(socket.id);
    socket.data.roomId = roomId;
    socket.join(roomId);

    socket.emit('join-success', { roomId, isInitiator: false, iceServers: buildIceServers() });
    socket.to(roomId).emit('peer-joined', { isInitiator: true });
  });

  socket.on('leave-room', () => {
    cleanupSocket(socket);
  });

  // Pure relay for the WebRTC handshake. Server never inspects SDP/candidate
  // contents beyond confirming the sender actually belongs to the room.
  const relay = (event) => (payload = {}) => {
    const { roomId } = payload;
    const room = rooms.get(roomId);
    if (!room || !room.sockets.has(socket.id)) return;
    socket.to(roomId).emit(event, payload);
  };

  socket.on('signal-offer', relay('signal-offer'));
  socket.on('signal-answer', relay('signal-answer'));
  socket.on('signal-ice', relay('signal-ice'));

  socket.on('disconnect', () => {
    cleanupSocket(socket);
  });
});

server.listen(PORT);

// Node ignores SIGTERM by default when running as PID 1 (the container's
// init process), so without an explicit handler `docker stop`/orchestrator
// shutdowns never exit cleanly — they just burn the full stop timeout before
// being SIGKILLed, dropping in-flight signaling instead of closing sockets.
function shutdown() {
  io.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
