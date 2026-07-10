'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 16 * 1024; // 16KB — safest interoperable size across mobile Safari/WebKit
const BUFFERED_AMOUNT_LOW_THRESHOLD = 1 * 1024 * 1024; // 1MB backpressure ceiling
const LARGE_FILE_WARNING_BYTES = 750 * 1024 * 1024;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const statusBadgeEl = document.getElementById('statusBadge');

const screenLandingEl = document.getElementById('screen-landing');
const btnCreateRoomEl = document.getElementById('btnCreateRoom');
const formJoinRoomEl = document.getElementById('formJoinRoom');
const inputRoomCodeEl = document.getElementById('inputRoomCode');
const landingErrorEl = document.getElementById('landingError');

const screenWaitingEl = document.getElementById('screen-waiting');
const qrCanvasEl = document.getElementById('qrCanvas');
const roomCodeDisplayEl = document.getElementById('roomCodeDisplay');
const btnCopyLinkEl = document.getElementById('btnCopyLink');
const btnCancelWaitingEl = document.getElementById('btnCancelWaiting');

const screenCallEl = document.getElementById('screen-call');
const remoteVideoEl = document.getElementById('remoteVideo');
const localVideoEl = document.getElementById('localVideo');
const sasBadgeEl = document.getElementById('sasBadge');
const sasCodeEl = document.getElementById('sasCode');
const btnToggleMicEl = document.getElementById('btnToggleMic');
const btnToggleCamEl = document.getElementById('btnToggleCam');
const btnSendFileEl = document.getElementById('btnSendFile');
const btnEndCallEl = document.getElementById('btnEndCall');
const fileInputEl = document.getElementById('fileInput');
const transfersEl = document.getElementById('transfers');
const transferItemTemplateEl = document.getElementById('transferItemTemplate');
const transferOverlayEl = document.getElementById('transferOverlay');
const btnCloseTransfersEl = document.getElementById('btnCloseTransfers');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
// websocket-only to match the server's transports config — no polling fallback.
const socket = io({ transports: ['websocket'] });

let roomId = null;
let iceServers = [];
let pendingUrlRejoin = false;
let pendingJoinUrl = '';

let pc = null;
let dataChannel = null;
let localStream = null;
let pendingCandidates = [];
let earlyCandidates = []; // ICE candidates that arrive before `pc` exists yet
let pendingOffer = null; // offer that arrives before `pc` exists yet (answerer still in getUserMedia)
let remoteDescSet = false;
let sasComputed = false;

let micEnabled = true;
let camEnabled = true;

const sendQueue = [];
let currentSend = null;
let receiveState = null;
let lastRenderedPct = {};

// ---------------------------------------------------------------------------
// Screen / status UI
// ---------------------------------------------------------------------------
function showScreen(name) {
  screenLandingEl.classList.toggle('hidden', name !== 'landing');
  screenWaitingEl.classList.toggle('hidden', name !== 'waiting');
  screenCallEl.classList.toggle('hidden', name !== 'call');
}

function setStatusText(text) {
  statusBadgeEl.textContent = text;
}

function updateConnectionStatus(state) {
  const map = {
    new: 'Connecting…',
    connecting: 'Connecting…',
    connected: 'Secure connection established',
    disconnected: 'Connection lost — reconnecting…',
    failed: 'Connection failed',
    closed: 'Call ended',
  };
  setStatusText(map[state] || state || 'idle');
}

function showLandingError(reason) {
  const messages = {
    'not-found': 'Room not found. Check the code and try again.',
    'room-full': 'That room already has two people in it.',
    'rate-limited': 'Too many attempts — please wait a moment.',
  };
  landingErrorEl.textContent = messages[reason] || 'Something went wrong.';
  landingErrorEl.classList.remove('hidden');
  showScreen('landing');
}

// ---------------------------------------------------------------------------
// Room code / QR
// ---------------------------------------------------------------------------
function renderRoomCodeUI(rid) {
  roomCodeDisplayEl.textContent = rid;
  qrCanvasEl.innerHTML = '';
  pendingJoinUrl = `${location.origin}/?room=${rid}`;
  // eslint-disable-next-line no-undef
  new QRCode(qrCanvasEl, { text: pendingJoinUrl, width: 200, height: 200 });
}

btnCopyLinkEl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pendingJoinUrl);
    btnCopyLinkEl.textContent = 'Copied!';
    setTimeout(() => { btnCopyLinkEl.textContent = 'Copy join link'; }, 1500);
  } catch (err) {
    // clipboard API unavailable — non-critical
  }
});

btnCancelWaitingEl.addEventListener('click', () => {
  if (roomId) socket.emit('leave-room', { roomId });
  roomId = null;
  history.replaceState(null, '', '/');
  showScreen('landing');
  setStatusText('idle');
});

// ---------------------------------------------------------------------------
// Landing actions
// ---------------------------------------------------------------------------
btnCreateRoomEl.addEventListener('click', () => {
  landingErrorEl.classList.add('hidden');
  socket.emit('create-room');
});

formJoinRoomEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = inputRoomCodeEl.value.trim().toUpperCase();
  if (!code) return;
  landingErrorEl.classList.add('hidden');
  socket.emit('join-room', { roomId: code });
});

// ---------------------------------------------------------------------------
// Signaling
// ---------------------------------------------------------------------------
socket.on('room-created', ({ roomId: rid, iceServers: ice }) => {
  roomId = rid;
  iceServers = ice;
  history.replaceState(null, '', `?room=${roomId}`);
  showScreen('waiting');
  renderRoomCodeUI(roomId);
});

socket.on('join-success', ({ roomId: rid, isInitiator, iceServers: ice }) => {
  pendingUrlRejoin = false;
  roomId = rid;
  iceServers = ice;
  history.replaceState(null, '', `?room=${roomId}`);
  initCallSession(isInitiator);
});

socket.on('peer-joined', ({ isInitiator }) => {
  initCallSession(isInitiator);
});

socket.on('peer-left', () => {
  teardownCall();
  if (roomId) {
    setStatusText('Peer disconnected — waiting to reconnect…');
    showScreen('waiting');
    renderRoomCodeUI(roomId);
  } else {
    showScreen('landing');
  }
});

socket.on('room-expired', () => {
  roomId = null;
  history.replaceState(null, '', '/');
  teardownCall();
  showScreen('landing');
  landingErrorEl.textContent = 'This room code expired after sitting idle. Create a new one.';
  landingErrorEl.classList.remove('hidden');
});

socket.on('join-error', ({ reason }) => {
  if (reason === 'not-found' && pendingUrlRejoin) {
    pendingUrlRejoin = false;
    socket.emit('create-room');
    return;
  }
  pendingUrlRejoin = false;
  showLandingError(reason);
});

socket.on('signal-offer', async ({ sdp }) => {
  // The answerer may still be awaiting getUserMedia (pc not created yet) when
  // the initiator's offer arrives. Buffer it — initCallSession() replays it
  // once the peer connection exists, instead of silently dropping the offer.
  if (!pc) {
    pendingOffer = sdp;
    return;
  }
  await handleRemoteOffer(sdp);
});

async function handleRemoteOffer(sdp) {
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  remoteDescSet = true;
  drainPendingCandidates();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('signal-answer', { roomId, sdp: pc.localDescription });
}

socket.on('signal-answer', async ({ sdp }) => {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  remoteDescSet = true;
  drainPendingCandidates();
});

socket.on('signal-ice', async ({ candidate }) => {
  if (!candidate) return;
  if (!pc) {
    earlyCandidates.push(candidate);
    return;
  }
  if (remoteDescSet) {
    pc.addIceCandidate(candidate).catch(() => {});
  } else {
    pendingCandidates.push(candidate);
  }
});

function drainPendingCandidates() {
  const queued = pendingCandidates.splice(0);
  queued.forEach((c) => pc.addIceCandidate(c).catch(() => {}));
}

// ---------------------------------------------------------------------------
// Call session lifecycle
// ---------------------------------------------------------------------------
async function initCallSession(isInitiator) {
  showScreen('call');
  setStatusText('Connecting…');
  await acquireLocalMedia();
  createPeerConnection();

  // Merge any ICE candidates that arrived while `pc` didn't exist yet into
  // the normal post-connection queue (still gated behind remoteDescSet).
  if (earlyCandidates.length) {
    pendingCandidates.push(...earlyCandidates.splice(0));
  }

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal-offer', { roomId, sdp: pc.localDescription });
  } else if (pendingOffer) {
    const offer = pendingOffer;
    pendingOffer = null;
    await handleRemoteOffer(offer);
  }
}

async function acquireLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: true,
    });
    localVideoEl.srcObject = localStream;
  } catch (err) {
    localStream = null;
    setStatusText('Camera/mic unavailable — file transfer only');
  }
}

function createPeerConnection() {
  pc = new RTCPeerConnection({ iceServers });
  remoteDescSet = false;
  pendingCandidates = [];
  sasComputed = false;

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  dataChannel = pc.createDataChannel('file-transfer', { negotiated: true, id: 0, ordered: true });
  dataChannel.binaryType = 'arraybuffer';
  dataChannel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
  wireDataChannel(dataChannel);

  pc.ontrack = (e) => {
    remoteVideoEl.srcObject = e.streams[0];
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal-ice', { roomId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    updateConnectionStatus(pc.connectionState);
    if (pc.connectionState === 'connected' && !sasComputed) {
      sasComputed = true;
      computeAndDisplaySAS();
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc && typeof pc.connectionState === 'undefined') {
      updateConnectionStatus(pc.iceConnectionState);
    }
  };
}

function teardownCall() {
  if (dataChannel) {
    try { dataChannel.close(); } catch (err) { /* noop */ }
    dataChannel = null;
  }
  if (pc) {
    pc.getSenders().forEach((s) => {
      try { if (s.track) s.track.stop(); } catch (err) { /* noop */ }
    });
    try { pc.close(); } catch (err) { /* noop */ }
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => { try { t.stop(); } catch (err) { /* noop */ } });
    localStream = null;
  }
  pendingCandidates = [];
  earlyCandidates = [];
  pendingOffer = null;
  remoteDescSet = false;
  localVideoEl.srcObject = null;
  remoteVideoEl.srcObject = null;
  hideSAS();
  resetTransferState();
}

btnEndCallEl.addEventListener('click', () => {
  if (roomId) socket.emit('leave-room', { roomId });
  teardownCall();
  roomId = null;
  history.replaceState(null, '', '/');
  showScreen('landing');
  setStatusText('idle');
});

// ---------------------------------------------------------------------------
// Session fingerprint (SAS) verification
// ---------------------------------------------------------------------------
function extractFingerprint(sdp) {
  const match = sdp.match(/a=fingerprint:(\S+) ([0-9A-Fa-f:]+)/);
  return match ? `${match[1]} ${match[2].toUpperCase()}` : '';
}

async function computeAndDisplaySAS() {
  try {
    const localFp = extractFingerprint(pc.localDescription.sdp);
    const remoteFp = extractFingerprint(pc.remoteDescription.sdp);
    if (!localFp || !remoteFp) return;
    const combined = [localFp, remoteFp].sort().join('|');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(combined));
    const bytes = new Uint8Array(digest);
    const groups = [];
    for (let i = 0; i < 6; i += 2) {
      const val = ((bytes[i] << 8) | bytes[i + 1]) % 1000;
      groups.push(String(val).padStart(3, '0'));
    }
    sasCodeEl.textContent = groups.join(' - ');
    sasBadgeEl.classList.remove('hidden');
  } catch (err) {
    // fingerprint extraction is a best-effort UX feature, never block the call
  }
}

function hideSAS() {
  sasBadgeEl.classList.add('hidden');
  sasCodeEl.textContent = '— — —';
  sasComputed = false;
}

// ---------------------------------------------------------------------------
// Mic / camera toggles (track.enabled only — never renegotiates)
// ---------------------------------------------------------------------------
btnToggleMicEl.addEventListener('click', () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((t) => { t.enabled = micEnabled; });
  btnToggleMicEl.classList.toggle('bg-rose-600', !micEnabled);
  btnToggleMicEl.classList.toggle('bg-slate-800', micEnabled);
});

btnToggleCamEl.addEventListener('click', () => {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach((t) => { t.enabled = camEnabled; });
  btnToggleCamEl.classList.toggle('bg-rose-600', !camEnabled);
  btnToggleCamEl.classList.toggle('bg-slate-800', camEnabled);
});

// ---------------------------------------------------------------------------
// Chunked file transfer
// ---------------------------------------------------------------------------
function generateTransferId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function wireDataChannel(channel) {
  channel.onopen = () => processSendQueue();
  channel.onbufferedamountlow = () => sendNextChunk();
  channel.onmessage = handleDataChannelMessage;
}

btnSendFileEl.addEventListener('click', () => fileInputEl.click());

fileInputEl.addEventListener('change', () => {
  const files = Array.from(fileInputEl.files || []);
  files.forEach((file) => enqueueFileSend(file));
  fileInputEl.value = '';
});

function enqueueFileSend(file) {
  const transferId = generateTransferId();
  sendQueue.push({ file, transferId });
  addTransferItem(transferId, file.name, 'out');
  if (file.size > LARGE_FILE_WARNING_BYTES) {
    markTransferWarning(transferId, 'Large file — may fail on low-memory devices');
  }
  processSendQueue();
}

function processSendQueue() {
  if (currentSend || sendQueue.length === 0) return;
  if (!dataChannel || dataChannel.readyState !== 'open') return;

  const next = sendQueue.shift();
  currentSend = { file: next.file, transferId: next.transferId, offset: 0 };

  dataChannel.send(JSON.stringify({
    type: 'file-meta',
    transferId: next.transferId,
    name: next.file.name,
    size: next.file.size,
    mimeType: next.file.type || 'application/octet-stream',
  }));

  sendNextChunk();
}

function sendNextChunk() {
  if (!currentSend || !dataChannel || dataChannel.readyState !== 'open') return;
  const { file, transferId } = currentSend;

  if (currentSend.offset >= file.size) {
    dataChannel.send(JSON.stringify({ type: 'file-complete', transferId }));
    markTransferComplete(transferId, null, null, 'out');
    currentSend = null;
    processSendQueue();
    return;
  }

  if (dataChannel.bufferedAmount > BUFFERED_AMOUNT_LOW_THRESHOLD) {
    return; // resumes from channel.onbufferedamountlow
  }

  const slice = file.slice(currentSend.offset, currentSend.offset + CHUNK_SIZE);
  slice.arrayBuffer().then((buf) => {
    if (!currentSend || currentSend.transferId !== transferId) return;
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    dataChannel.send(buf);
    currentSend.offset += buf.byteLength;
    updateTransferProgress(transferId, currentSend.offset / file.size);
    sendNextChunk();
  });
}

function handleDataChannelMessage(event) {
  if (typeof event.data === 'string') {
    let msg;
    try { msg = JSON.parse(event.data); } catch (err) { return; }

    if (msg.type === 'file-meta') {
      receiveState = {
        transferId: msg.transferId,
        name: msg.name,
        size: msg.size,
        mimeType: msg.mimeType,
        chunks: [],
        received: 0,
      };
      addTransferItem(msg.transferId, msg.name, 'in');
      if (msg.size > LARGE_FILE_WARNING_BYTES) {
        markTransferWarning(msg.transferId, 'Large file — may fail on low-memory devices');
      }
    } else if (msg.type === 'file-complete') {
      if (!receiveState || receiveState.transferId !== msg.transferId) return;
      const blob = new Blob(receiveState.chunks, { type: receiveState.mimeType });
      const url = URL.createObjectURL(blob);
      markTransferComplete(msg.transferId, url, receiveState.name, 'in');
      receiveState = null;
    } else if (msg.type === 'file-cancel') {
      if (receiveState && receiveState.transferId === msg.transferId) {
        removeTransferItem(msg.transferId);
        receiveState = null;
      }
    }
    return;
  }

  if (!receiveState) return;
  receiveState.chunks.push(event.data);
  receiveState.received += event.data.byteLength;
  updateTransferProgress(receiveState.transferId, receiveState.received / receiveState.size);
}

// ---------------------------------------------------------------------------
// Transfer list UI
// ---------------------------------------------------------------------------
function findTransferEl(transferId) {
  return transfersEl.querySelector(`[data-transfer-id="${transferId}"]`);
}

function showTransferOverlay() {
  transferOverlayEl.classList.remove('hidden');
}

function hideTransferOverlay() {
  transferOverlayEl.classList.add('hidden');
}

btnCloseTransfersEl.addEventListener('click', hideTransferOverlay);

function addTransferItem(transferId, name, direction) {
  const node = transferItemTemplateEl.content.cloneNode(true);
  const el = node.querySelector('.transfer-item');
  el.dataset.transferId = transferId;
  el.querySelector('.transfer-name').textContent = `${direction === 'out' ? '↑' : '↓'} ${name}`;
  transfersEl.appendChild(node);
  showTransferOverlay();
}

function updateTransferProgress(transferId, ratio) {
  const pct = Math.min(100, Math.round(ratio * 100));
  if (lastRenderedPct[transferId] === pct) return;
  lastRenderedPct[transferId] = pct;
  const el = findTransferEl(transferId);
  if (!el) return;
  el.querySelector('.transfer-bar').style.width = `${pct}%`;
  el.querySelector('.transfer-pct').textContent = `${pct}%`;
}

function markTransferComplete(transferId, url, name, direction) {
  const el = findTransferEl(transferId);
  if (!el) return;
  el.querySelector('.transfer-bar').style.width = '100%';
  el.querySelector('.transfer-pct').textContent = '100%';
  const action = el.querySelector('.transfer-action');
  if (direction === 'in' && url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.textContent = 'Download';
    a.className = 'text-emerald-400 underline';
    action.appendChild(a);
  } else {
    action.textContent = 'Sent';
    action.className = 'transfer-action mt-1 text-slate-500';
  }
}

function markTransferWarning(transferId, text) {
  const el = findTransferEl(transferId);
  if (!el) return;
  const warn = document.createElement('div');
  warn.className = 'text-amber-400 mt-1';
  warn.textContent = text;
  el.appendChild(warn);
}

function removeTransferItem(transferId) {
  const el = findTransferEl(transferId);
  if (el) el.remove();
}

function resetTransferState() {
  sendQueue.length = 0;
  currentSend = null;
  receiveState = null;
  lastRenderedPct = {};
  transfersEl.innerHTML = '';
  hideTransferOverlay();
}

// ---------------------------------------------------------------------------
// Bootstrap — auto-join from ?room= (QR scan or refresh recovery)
// ---------------------------------------------------------------------------
(function bootstrap() {
  const params = new URLSearchParams(location.search);
  const roomFromUrl = (params.get('room') || '').toUpperCase();
  if (roomFromUrl) {
    pendingUrlRejoin = true;
    socket.emit('join-room', { roomId: roomFromUrl });
  }
})();
