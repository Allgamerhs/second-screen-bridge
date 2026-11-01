import crypto from 'node:crypto';

const PAIR_MS = 5 * 60 * 1000;
const PHONE_MS = 15 * 60 * 1000;
const RECEIVER_MS = 2 * 60 * 60 * 1000;
const EVENT_MS = 10 * 60 * 1000;
const ATTEMPT_MS = 10 * 60 * 1000;
const KEY_NAMES = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape',
  'Backspace', 'MediaPlayPause', 'VolumeUp', 'VolumeDown', 'Mute',
  'ChannelUp', 'ChannelDown'
]);

export class BridgeError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function fail(status, code) { throw new BridgeError(status, code); }
function token() { return crypto.randomBytes(32).toString('base64url'); }
function validName(value) {
  if (typeof value !== 'string') fail(400, 'INVALID_NAME');
  const name = value.trim();
  if (!name || name.length > 64) fail(400, 'INVALID_NAME');
  return name;
}
function validFields(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8) fail(400, 'INVALID_FIELDS');
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item.id !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,31}$/.test(item.id) || seen.has(item.id) ||
      typeof item.label !== 'string' || !item.label.trim() || item.label.length > 48 ||
      !['text', 'url'].includes(item.kind)) fail(400, 'INVALID_FIELDS');
    seen.add(item.id);
    return { id: item.id, label: item.label.trim(), kind: item.kind };
  });
}

export class BridgeStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.receivers = new Map();
    this.phones = new Map();
    this.attempts = new Map();
  }

  prune() {
    const now = this.now();
    for (const [id, receiver] of this.receivers) {
      if (receiver.expires <= now) this.removeReceiver(id);
      else receiver.events = receiver.events.filter((event) => event.expires > now);
    }
    for (const [phoneToken, phone] of this.phones) {
      if (phone.expires <= now || !this.receivers.has(phone.receiverId)) this.phones.delete(phoneToken);
    }
    for (const [address, attempt] of this.attempts) {
      if (attempt.until <= now) this.attempts.delete(address);
    }
  }

  issueCode() {
    for (let i = 0; i < 10; i++) {
      const code = String(crypto.randomInt(100000000)).padStart(8, '0');
      if (![...this.receivers.values()].some((receiver) => receiver.code === code)) return code;
    }
    fail(503, 'CODE_UNAVAILABLE');
  }

  createReceiver(payload, phoneUrl) {
    this.prune();
    if (this.receivers.size >= 32) fail(503, 'RECEIVER_LIMIT');
    const name = validName(payload?.name);
    const fields = validFields(payload?.fields);
    const receiverId = crypto.randomUUID();
    const receiverToken = token();
    const code = this.issueCode();
    const now = this.now();
    this.receivers.set(receiverId, {
      id: receiverId, token: receiverToken, name, fields, code,
      codeExpires: now + PAIR_MS, expires: now + RECEIVER_MS,
      events: [], nextSeq: 0
    });
    return { ok: true, receiverId, receiverToken, code,
      expiresAt: new Date(now + PAIR_MS).toISOString(), phoneUrl };
  }

  receiver(receiverToken) {
    this.prune();
    if (typeof receiverToken !== 'string') fail(401, 'INVALID_RECEIVER');
    const entry = [...this.receivers.values()].find((item) => item.token === receiverToken);
    if (!entry) fail(401, 'INVALID_RECEIVER');
    entry.expires = this.now() + RECEIVER_MS;
    return entry;
  }

  poll(payload) {
    const receiver = this.receiver(payload?.receiverToken);
    const after = payload?.after;
    if (!Number.isSafeInteger(after) || after < 0 || after > receiver.nextSeq)
      fail(400, 'INVALID_CURSOR');
    const events = receiver.events.filter((event) => event.seq > after)
      .map(({ seq, type, field, value, key }) => ({ seq, type, ...(field && { field }),
        ...(value !== undefined && { value }), ...(key && { key }) }));
    const pairedCount = [...this.phones.values()].filter((phone) => phone.receiverId === receiver.id).length;
    return { ok: true, events, nextSeq: events.at(-1)?.seq ?? after, pairedCount };
  }

  ack(payload) {
    const receiver = this.receiver(payload?.receiverToken);
    const through = payload?.through;
    if (!Number.isSafeInteger(through) || through < 0 || through > receiver.nextSeq)
      fail(400, 'INVALID_CURSOR');
    receiver.events = receiver.events.filter((event) => event.seq > through);
    return { ok: true, through };
  }

  rotate(payload, phoneUrl) {
    const receiver = this.receiver(payload?.receiverToken);
    for (const [phoneToken, phone] of this.phones) {
      if (phone.receiverId === receiver.id) this.phones.delete(phoneToken);
    }
    receiver.events = [];
    receiver.code = this.issueCode();
    receiver.codeExpires = this.now() + PAIR_MS;
    return { ok: true, code: receiver.code,
      expiresAt: new Date(receiver.codeExpires).toISOString(), phoneUrl };
  }

  removeReceiver(id) {
    this.receivers.delete(id);
    for (const [phoneToken, phone] of this.phones) {
      if (phone.receiverId === id) this.phones.delete(phoneToken);
    }
  }

  close(payload) {
    const receiver = this.receiver(payload?.receiverToken);
    this.removeReceiver(receiver.id);
    return { ok: true };
  }

  connect(payload, address) {
    this.prune();
    const now = this.now();
    const attempt = this.attempts.get(address);
    if (attempt && attempt.count >= 5 && attempt.until > now) fail(429, 'TOO_MANY_ATTEMPTS');
    const submitted = payload?.code;
    let receiver = null;
    if (typeof submitted === 'string' && /^\d{8}$/.test(submitted)) {
      const candidate = Buffer.from(submitted);
      receiver = [...this.receivers.values()].find((entry) =>
        entry.code && entry.codeExpires > now &&
        crypto.timingSafeEqual(candidate, Buffer.from(entry.code)));
    }
    if (!receiver) {
      this.attempts.set(address, { count: (attempt?.count || 0) + 1, until: now + ATTEMPT_MS });
      if (this.attempts.size > 256) this.attempts.delete(this.attempts.keys().next().value);
      fail(401, 'INVALID_CODE');
    }
    this.attempts.delete(address);
    receiver.code = null;
    receiver.codeExpires = 0;
    const phoneToken = token();
    this.phones.set(phoneToken, { receiverId: receiver.id, address, expires: now + PHONE_MS });
    return { ok: true, token: phoneToken, receiverName: receiver.name,
      fields: receiver.fields, expiresAt: new Date(now + PHONE_MS).toISOString() };
  }

  send(payload, address) {
    this.prune();
    const phone = this.phones.get(payload?.token);
    if (!phone || phone.address !== address) fail(401, 'INVALID_PHONE');
    const receiver = this.receivers.get(phone.receiverId);
    if (!receiver) fail(401, 'INVALID_PHONE');
    if (payload.type !== 'text' && payload.type !== 'key') fail(400, 'INVALID_EVENT');
    let event;
    if (payload.type === 'text') {
      const field = receiver.fields.find((item) => item.id === payload.field);
      if (!field || typeof payload.value !== 'string' || payload.value.length > 4096)
        fail(400, 'INVALID_EVENT');
      if (field.kind === 'url') {
        try {
          const parsed = new URL(payload.value);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
            fail(400, 'INVALID_URL');
        } catch { fail(400, 'INVALID_URL'); }
      }
      event = { type: 'text', field: field.id, value: payload.value };
    } else {
      if (!KEY_NAMES.has(payload.key)) fail(400, 'INVALID_KEY');
      event = { type: 'key', key: payload.key };
    }
    if (receiver.events.length >= 32) fail(429, 'QUEUE_FULL');
    const seq = ++receiver.nextSeq;
    receiver.events.push({ seq, ...event, expires: this.now() + EVENT_MS });
    return { ok: true, seq };
  }

  disconnect(payload, address) {
    this.prune();
    const phone = this.phones.get(payload?.token);
    if (!phone || phone.address !== address) fail(401, 'INVALID_PHONE');
    this.phones.delete(payload.token);
    return { ok: true };
  }
}
