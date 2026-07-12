'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 16 * 1024; // 16KB — safest interoperable size across mobile Safari/WebKit
const BUFFERED_AMOUNT_LOW_THRESHOLD = 1 * 1024 * 1024; // 1MB backpressure ceiling
const LARGE_FILE_WARNING_BYTES = 750 * 1024 * 1024;

// Installability only (see sw.js) — not used for offline caching.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // non-critical — app works fully without it, just not installable
    });
  });
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const btnLogoHomeEl = document.getElementById('btnLogoHome');
const statusBadgeEl = document.getElementById('statusBadge');
const statusDotEl = document.getElementById('statusDot');
const statusTextEl = document.getElementById('statusText');

const screenLandingEl = document.getElementById('screen-landing');
const btnCreateRoomEl = document.getElementById('btnCreateRoom');
const formJoinRoomEl = document.getElementById('formJoinRoom');
const inputRoomCodeEl = document.getElementById('inputRoomCode');
const landingErrorEl = document.getElementById('landingError');
const landingErrorTextEl = document.getElementById('landingErrorText');
const otpBoxEls = Array.from(document.querySelectorAll('.otp-box'));

const screenWaitingEl = document.getElementById('screen-waiting');
const qrCanvasEl = document.getElementById('qrCanvas');
const roomCodeDisplayEl = document.getElementById('roomCodeDisplay');
const btnShareQrEl = document.getElementById('btnShareQr');
const btnCopyLinkEl = document.getElementById('btnCopyLink');
const btnCancelWaitingEl = document.getElementById('btnCancelWaiting');

const screenCallEl = document.getElementById('screen-call');
const remoteVideoEl = document.getElementById('remoteVideo');
const localVideoEl = document.getElementById('localVideo');
const connectingOverlayEl = document.getElementById('connectingOverlay');
const sasBadgeEl = document.getElementById('sasBadge');
const sasCodeEl = document.getElementById('sasCode');
const btnSasCloseEl = document.getElementById('btnSasClose');
const btnSasConfirmEl = document.getElementById('btnSasConfirm');
const btnSasRejectEl = document.getElementById('btnSasReject');
const btnToggleMicEl = document.getElementById('btnToggleMic');
const btnToggleCamEl = document.getElementById('btnToggleCam');
const btnSwitchDeviceEl = document.getElementById('btnSwitchDevice');
const btnSendFileEl = document.getElementById('btnSendFile');
const btnEndCallEl = document.getElementById('btnEndCall');
const fileInputEl = document.getElementById('fileInput');
const transfersEl = document.getElementById('transfers');
const transferItemTemplateEl = document.getElementById('transferItemTemplate');
const transferOverlayEl = document.getElementById('transferOverlay');
const btnCloseTransfersEl = document.getElementById('btnCloseTransfers');

const deviceOverlayEl = document.getElementById('deviceOverlay');
const btnCloseDeviceEl = document.getElementById('btnCloseDevice');
const selectCameraEl = document.getElementById('selectCamera');
const selectMicEl = document.getElementById('selectMic');
const deviceSwitchErrorEl = document.getElementById('deviceSwitchError');

const btnToggleChatEl = document.getElementById('btnToggleChat');
const chatUnreadBadgeEl = document.getElementById('chatUnreadBadge');
const chatOverlayEl = document.getElementById('chatOverlay');
const chatMessagesEl = document.getElementById('chatMessages');
const btnCloseChatEl = document.getElementById('btnCloseChat');
const formChatSendEl = document.getElementById('formChatSend');
const inputChatMessageEl = document.getElementById('inputChatMessage');

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

let chatOpen = false;
let chatUnreadCount = 0;

// ---------------------------------------------------------------------------
// Screen / status UI
// ---------------------------------------------------------------------------
function showScreen(name) {
  screenLandingEl.classList.toggle('hidden', name !== 'landing');
  screenWaitingEl.classList.toggle('hidden', name !== 'waiting');
  screenCallEl.classList.toggle('hidden', name !== 'call');
}

function setStatusText(text) {
  statusTextEl.textContent = text;
}

const STATUS_DOT_COLORS = {
  idle: '#6f675a',
  warn: '#eab308',
  good: '#2fb888',
  bad: '#e0616b',
};

function setStatusDot(kind) {
  statusDotEl.style.background = STATUS_DOT_COLORS[kind] || STATUS_DOT_COLORS.idle;
  statusDotEl.classList.toggle('animate-pulse', kind === 'good' || kind === 'warn');
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
  const dotKind = {
    new: 'warn',
    connecting: 'warn',
    connected: 'good',
    disconnected: 'warn',
    failed: 'bad',
    closed: 'idle',
  };
  setStatusText(map[state] || state || 'idle');
  setStatusDot(dotKind[state] || 'idle');
}

function showLandingError(reason) {
  const messages = {
    'not-found': 'Room not found. Check the code and try again.',
    'room-full': 'That room already has two people in it.',
    'rate-limited': 'Too many attempts — please wait a moment.',
  };
  landingErrorTextEl.textContent = messages[reason] || 'Something went wrong.';
  landingErrorEl.classList.remove('hidden');
  otpBoxEls.forEach((b) => b.classList.add('error'));
  showScreen('landing');
}

// ---------------------------------------------------------------------------
// Room code entry (6 individual boxes, synced into the hidden #inputRoomCode
// that the join-form submit handler reads)
// ---------------------------------------------------------------------------
function syncOtpValue() {
  inputRoomCodeEl.value = otpBoxEls.map((b) => b.value).join('').toUpperCase();
}

function clearOtpError() {
  landingErrorEl.classList.add('hidden');
  otpBoxEls.forEach((b) => b.classList.remove('error'));
}

function resetOtpBoxes() {
  otpBoxEls.forEach((b) => { b.value = ''; b.classList.remove('error'); });
  inputRoomCodeEl.value = '';
}

otpBoxEls.forEach((box, i) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/[^a-zA-Z0-9]/g, '').slice(-1).toUpperCase();
    clearOtpError();
    syncOtpValue();
    if (box.value && i < otpBoxEls.length - 1) otpBoxEls[i + 1].focus();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) {
      otpBoxEls[i - 1].focus();
      otpBoxEls[i - 1].value = '';
      syncOtpValue();
    }
  });
  box.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    e.preventDefault();
    const chars = text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, otpBoxEls.length).split('');
    chars.forEach((c, idx) => { if (otpBoxEls[idx]) otpBoxEls[idx].value = c; });
    clearOtpError();
    syncOtpValue();
    const next = otpBoxEls[Math.min(chars.length, otpBoxEls.length - 1)];
    if (next) next.focus();
  });
});

// ---------------------------------------------------------------------------
// Room code / QR
// ---------------------------------------------------------------------------
function renderRoomCodeUI(rid) {
  roomCodeDisplayEl.textContent = rid.length === 6 ? `${rid.slice(0, 3)} · ${rid.slice(3)}` : rid;
  qrCanvasEl.innerHTML = '';
  pendingJoinUrl = `${location.origin}/?room=${rid}`;
  // eslint-disable-next-line no-undef
  new QRCode(qrCanvasEl, { text: pendingJoinUrl, width: 200, height: 200, colorDark: '#1c1915', colorLight: '#fbf8f2' });
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

// Only offer this where file sharing is actually possible (mobile Safari/
// Chrome) — a button that silently does nothing is worse than no button.
const shareFilesSupported = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
btnShareQrEl.classList.toggle('hidden', !shareFilesSupported);

btnShareQrEl.addEventListener('click', () => {
  const canvas = qrCanvasEl.querySelector('canvas');
  if (!canvas) return;
  canvas.toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], 'ghostline-room-code.png', { type: 'image/png' });
    const shareText = `Join my Ghostline call: ${pendingJoinUrl}`;
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Ghostline room code', text: shareText });
      } else {
        // Platform supports navigator.share but not file attachments — fall
        // back to sharing the link alone rather than doing nothing.
        await navigator.share({ title: 'Ghostline room code', text: shareText, url: pendingJoinUrl });
      }
    } catch (err) {
      // user dismissed the share sheet — non-critical
    }
  }, 'image/png');
});

btnCancelWaitingEl.addEventListener('click', () => {
  if (roomId) socket.emit('leave-room', { roomId });
  roomId = null;
  history.replaceState(null, '', '/');
  showScreen('landing');
  setStatusText('idle');
  setStatusDot('idle');
  resetOtpBoxes();
});

// Logo — always returns to the landing screen, tearing down an in-progress
// call/waiting-room first so it doesn't leave a dangling peer connection.
btnLogoHomeEl.addEventListener('click', () => {
  if (!screenCallEl.classList.contains('hidden')) teardownCall();
  if (roomId) socket.emit('leave-room', { roomId });
  roomId = null;
  history.replaceState(null, '', '/');
  showScreen('landing');
  setStatusText('idle');
  setStatusDot('idle');
  resetOtpBoxes();
});

// ---------------------------------------------------------------------------
// Landing actions
// ---------------------------------------------------------------------------
btnCreateRoomEl.addEventListener('click', () => {
  clearOtpError();
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
    setStatusDot('warn');
    showScreen('waiting');
    renderRoomCodeUI(roomId);
  } else {
    showScreen('landing');
    resetOtpBoxes();
  }
});

socket.on('room-expired', () => {
  roomId = null;
  history.replaceState(null, '', '/');
  teardownCall();
  showScreen('landing');
  resetOtpBoxes();
  landingErrorTextEl.textContent = 'This room code expired after sitting idle. Create a new one.';
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
  setStatusDot('warn');
  connectingOverlayEl.classList.remove('hidden');
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
    setStatusDot('warn');
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
    if (pc.connectionState === 'connected') {
      connectingOverlayEl.classList.add('hidden');
      if (!sasComputed) {
        sasComputed = true;
        computeAndDisplaySAS();
      }
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
  connectingOverlayEl.classList.add('hidden');
  hideSAS();
  resetTransferState();
  resetChatState();
  closeDeviceSwitcher();
}

btnEndCallEl.addEventListener('click', () => {
  if (roomId) socket.emit('leave-room', { roomId });
  teardownCall();
  roomId = null;
  history.replaceState(null, '', '/');
  showScreen('landing');
  setStatusText('idle');
  setStatusDot('idle');
  resetOtpBoxes();
});

// ---------------------------------------------------------------------------
// SAS card actions — "It matches" / close both dismiss; "Doesn't match" ends
// the call outright since a mismatch means someone may be intercepting it.
// ---------------------------------------------------------------------------
btnSasCloseEl.addEventListener('click', hideSAS);
btnSasConfirmEl.addEventListener('click', hideSAS);
btnSasRejectEl.addEventListener('click', () => btnEndCallEl.click());

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
  btnToggleMicEl.classList.toggle('muted', !micEnabled);
});

btnToggleCamEl.addEventListener('click', () => {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach((t) => { t.enabled = camEnabled; });
  btnToggleCamEl.classList.toggle('muted', !camEnabled);
});

// ---------------------------------------------------------------------------
// Camera / microphone device switching
// ---------------------------------------------------------------------------
btnSwitchDeviceEl.addEventListener('click', () => {
  if (!localStream) return;
  openDeviceSwitcher();
});

btnCloseDeviceEl.addEventListener('click', closeDeviceSwitcher);

async function openDeviceSwitcher() {
  deviceSwitchErrorEl.classList.add('hidden');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const currentVideoId = localStream?.getVideoTracks()[0]?.getSettings().deviceId;
    const currentAudioId = localStream?.getAudioTracks()[0]?.getSettings().deviceId;
    populateDeviceSelect(selectCameraEl, devices.filter((d) => d.kind === 'videoinput'), currentVideoId, 'Camera');
    populateDeviceSelect(selectMicEl, devices.filter((d) => d.kind === 'audioinput'), currentAudioId, 'Microphone');
    deviceOverlayEl.classList.remove('hidden');
  } catch (err) {
    // enumerateDevices failed (unsupported/blocked) — nothing to switch to
  }
}

function closeDeviceSwitcher() {
  deviceOverlayEl.classList.add('hidden');
}

function populateDeviceSelect(selectEl, devices, currentId, fallbackLabel) {
  selectEl.innerHTML = '';
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
    if (d.deviceId === currentId) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

selectCameraEl.addEventListener('change', () => switchDevice('video', selectCameraEl.value));
selectMicEl.addEventListener('change', () => switchDevice('audio', selectMicEl.value));

async function switchDevice(kind, deviceId) {
  if (!deviceId) return;
  deviceSwitchErrorEl.classList.add('hidden');
  try {
    const constraints = kind === 'video'
      ? { video: { deviceId: { exact: deviceId } } }
      : { audio: { deviceId: { exact: deviceId } } };
    const newStream = await navigator.mediaDevices.getUserMedia(constraints);
    const newTrack = kind === 'video' ? newStream.getVideoTracks()[0] : newStream.getAudioTracks()[0];

    if (pc) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === kind);
      if (sender) await sender.replaceTrack(newTrack);
    }

    const oldTracks = kind === 'video' ? localStream.getVideoTracks() : localStream.getAudioTracks();
    oldTracks.forEach((t) => {
      localStream.removeTrack(t);
      try { t.stop(); } catch (err) { /* noop */ }
    });

    newTrack.enabled = kind === 'video' ? camEnabled : micEnabled;
    localStream.addTrack(newTrack);
    localVideoEl.srcObject = localStream;
  } catch (err) {
    deviceSwitchErrorEl.textContent = `Couldn't switch ${kind === 'video' ? 'camera' : 'microphone'} — device may be in use elsewhere.`;
    deviceSwitchErrorEl.classList.remove('hidden');
  }
}

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
    } else if (msg.type === 'chat') {
      appendChatMessage(msg.text, 'in');
      if (!chatOpen) {
        chatUnreadCount += 1;
        chatUnreadBadgeEl.textContent = chatUnreadCount > 9 ? '9+' : String(chatUnreadCount);
        chatUnreadBadgeEl.classList.remove('hidden');
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
    a.className = 'font-semibold';
    a.style.color = 'var(--accent-bright)';
    action.appendChild(a);
  } else {
    action.textContent = 'Sent';
    action.className = 'transfer-action mt-2 text-xs';
    action.style.color = 'var(--text-faint)';
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
// Text chat (fallback communication channel over the same data channel —
// useful even when the connection is still negotiating, or just to type a
// quick message alongside/instead of video)
// ---------------------------------------------------------------------------
btnToggleChatEl.addEventListener('click', () => {
  if (chatOpen) closeChat(); else openChat();
});

btnCloseChatEl.addEventListener('click', closeChat);

function openChat() {
  chatOpen = true;
  chatOverlayEl.classList.remove('hidden');
  chatUnreadCount = 0;
  chatUnreadBadgeEl.classList.add('hidden');
  inputChatMessageEl.focus();
}

function closeChat() {
  chatOpen = false;
  chatOverlayEl.classList.add('hidden');
}

formChatSendEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputChatMessageEl.value.trim();
  if (!text || !dataChannel || dataChannel.readyState !== 'open') return;
  dataChannel.send(JSON.stringify({ type: 'chat', text }));
  appendChatMessage(text, 'out');
  inputChatMessageEl.value = '';
});

function appendChatMessage(text, direction) {
  const bubble = document.createElement('div');
  bubble.className = direction === 'out'
    ? 'ml-auto max-w-[80%] rounded-2xl rounded-br-sm px-3 py-2 break-words font-medium'
    : 'mr-auto max-w-[80%] rounded-2xl rounded-bl-sm px-3 py-2 break-words';
  bubble.style.background = direction === 'out' ? 'var(--accent)' : 'var(--surface)';
  bubble.style.color = direction === 'out' ? 'var(--accent-ink)' : 'var(--text)';
  bubble.textContent = text;
  chatMessagesEl.appendChild(bubble);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function resetChatState() {
  chatOpen = false;
  chatUnreadCount = 0;
  chatMessagesEl.innerHTML = '';
  chatUnreadBadgeEl.classList.add('hidden');
  chatOverlayEl.classList.add('hidden');
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
