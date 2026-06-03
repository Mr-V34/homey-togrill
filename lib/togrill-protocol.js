'use strict';

// ── BLE identifiers ───────────────────────────────────────────────────────────
const SERVICE_UUID = '0000cee0-0000-1000-8000-00805f9b34fb';
const WRITE_UUID   = '0000cee1-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID  = '0000cee2-0000-1000-8000-00805f9b34fb';
const COMPANY_ID   = 0x879A;
const NAME_FILTER  = ['ToGrill', 'AT-02'];

// ── Packet framing ────────────────────────────────────────────────────────────
// Frame: [0x55, 0xAA, len_hi, len_lo, ...payload, xor_checksum]
// checksum = XOR of every byte from 0x55 up to (and including) the last payload byte.

function wrapPayload(payload) {
  const len   = payload.length;
  const frame = Buffer.allocUnsafe(4 + len + 1);
  frame[0] = 0x55;
  frame[1] = 0xAA;
  frame[2] = (len >> 8) & 0xFF;
  frame[3] = len & 0xFF;
  payload.copy(frame, 4);
  let xor = 0;
  for (let i = 0; i < 4 + len; i++) xor ^= frame[i];
  frame[4 + len] = xor;
  return frame;
}

function unwrapPayload(data) {
  if (!Buffer.isBuffer(data) || data.length < 5) {
    throw new Error(`Frame too short (${data ? data.length : 0} bytes)`);
  }
  if (data[0] !== 0x55 || data[1] !== 0xAA) {
    throw new Error(`Invalid prefix: 0x${data[0].toString(16).padStart(2,'0')} 0x${data[1].toString(16).padStart(2,'0')}`);
  }
  const len = (data[2] << 8) | data[3];
  if (data.length < 4 + len + 1) {
    throw new Error(`Frame truncated: need ${4 + len + 1} bytes, have ${data.length}`);
  }
  let xor = 0;
  for (let i = 0; i < 4 + len; i++) xor ^= data[i];
  if (xor !== data[4 + len]) {
    throw new Error(`Checksum mismatch: expected 0x${xor.toString(16).padStart(2,'0')}, got 0x${data[4+len].toString(16).padStart(2,'0')}`);
  }
  return data.slice(4, 4 + len);
}

// ── Temperature codec ─────────────────────────────────────────────────────────
// Device uses big-endian uint16, scaled ×10.
// 0xFFFF = null/disconnected.
// value > 32768: negative temperature encoding → (value − 32768) / 10

function bytesToTemp(hi, lo) {
  const v = ((hi & 0xFF) << 8) | (lo & 0xFF);
  if (v === 0xFFFF) return null;
  if (v > 32768)    return (v - 32768) / 10;
  return v / 10;
}

function tempToBytes(tempC) {
  if (tempC === null || tempC === undefined) return [0xFF, 0xFF];
  const rounded = Math.round(tempC * 10);
  const v = rounded < 0 ? 32768 + rounded : rounded;
  return [(v >> 8) & 0xFF, v & 0xFF];
}

// ── Notification parser ───────────────────────────────────────────────────────

function parseNotification(raw) {
  const data = unwrapPayload(raw);
  if (!data.length) throw new Error('Empty payload after unwrap');
  switch (data[0]) {
    case 0xA0: return _parseA0(data);
    case 0xA1: return _parseA1(data);
    case 0xA5: return _parseA5(data);
    case 0xA8: return _parseA8(data);
    default:
      return { type: 'unknown', packetType: `0x${data[0].toString(16)}`, raw: data.toString('hex') };
  }
}

function _parseA0(data) {
  const flags = data.length > 5 ? data[5] : 0;
  return {
    type:       'status',
    battery:    data[1],
    version:    `${data[2]}.${data[3]}`,
    probeCount: (flags >> 4) & 0x07,
    hasAmbient: !!(flags & 0x80),
  };
}

function _parseA1(data) {
  // Parse every 2-byte pair available; device handler maps indices to channels.
  const count    = Math.floor((data.length - 1) / 2);
  const channels = [];
  for (let i = 0; i < count; i++) {
    channels.push(bytesToTemp(data[1 + i * 2], data[2 + i * 2]));
  }
  return { type: 'temperatures', channels };
}

function _parseA5(data) {
  const MSG = { 0: 'ack', 1: 'low_power', 3: 'below_min', 4: 'above_max' };
  return {
    type:    'probe_event',
    probe:   data[1],   // 0-based
    message: MSG[data[2]] ?? `unknown_0x${data[2].toString(16)}`,
  };
}

function _parseA8(data) {
  return {
    type:      'alarm_detail',
    probe:     data[1],  // 0-based
    alarmType: data[2],  // 0=range, 1=target, 0xFF=null
    temp1:     data.length > 4 ? bytesToTemp(data[3], data[4]) : null,
    temp2:     data.length > 6 ? bytesToTemp(data[5], data[6]) : null,
    timerSecs: data.length >= 13 ? (data[11] << 8) | data[12] : null,
  };
}

// ── Write command encoders ────────────────────────────────────────────────────

function encodeTarget(probeIdx, tempC) {
  const [th, tl] = tempToBytes(tempC);
  return wrapPayload(Buffer.from([0xA3, probeIdx, 0x01, th, tl, 0x00, 0x00]));
}

function encodeRange(probeIdx, minC, maxC) {
  const [mnh, mnl] = tempToBytes(minC);
  const [mxh, mxl] = tempToBytes(maxC);
  return wrapPayload(Buffer.from([0xA3, probeIdx, 0x00, mnh, mnl, mxh, mxl]));
}

function encodeTimer(probeIdx, seconds) {
  const s = Math.max(0, Math.round(seconds));
  return wrapPayload(Buffer.from([0xA7, probeIdx, 0x00, (s >> 8) & 0xFF, s & 0xFF]));
}

module.exports = {
  SERVICE_UUID,
  WRITE_UUID,
  NOTIFY_UUID,
  COMPANY_ID,
  NAME_FILTER,
  wrapPayload,
  unwrapPayload,
  parseNotification,
  encodeTarget,
  encodeRange,
  encodeTimer,
  bytesToTemp,
  tempToBytes,
};
