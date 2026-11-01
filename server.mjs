import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeStore, BridgeError } from './lib/store.mjs';
import { defaultAdvertiseHost, isTrustedClient, isPrivateIPv4 } from './lib/network.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const ASSETS = new Map([
  ['/receiver', ['receiver.html', 'text/html; charset=utf-8']],
  ['/phone', ['phone.html', 'text/html; charset=utf-8']],
  ['/receiver.js', ['receiver.js', 'text/javascript; charset=utf-8']],
  ['/phone.js', ['phone.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);
const RECEIVER_ROUTES = new Set([
  '/api/receivers', '/api/receivers/poll', '/api/receivers/ack',
  '/api/receivers/rotate', '/api/receivers/close'
]);
const PHONE_ROUTES = new Set(['/api/phones/connect', '/api/phones/send', '/api/phones/disconnect']);
const MAX_BODY = 16 * 1024;

function send(response, status, body, origin = null, extra = {}) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'vary': 'Origin',
    ...(origin && { 'access-control-allow-origin': origin }),
    ...extra
  });
  response.end(data);
}

async function readJson(request) {
  const type = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'text/plain' && type !== 'application/json')
    throw new BridgeError(415, 'UNSUPPORTED_CONTENT_TYPE');
  if (Number(request.headers['content-length'] || 0) > MAX_BODY)
    throw new BridgeError(413, 'BODY_TOO_LARGE');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new BridgeError(413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not object');
    return parsed;
  } catch { throw new BridgeError(400, 'INVALID_JSON'); }
}

function parseOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch { return null; }
}

export function createBridgeServer(options = {}) {
  const store = options.store || new BridgeStore();
  const advertiseHost = options.advertiseHost || process.env.ADVERTISE_HOST || defaultAdvertiseHost();
  const configuredPort = Number(options.port ?? process.env.PORT ?? 8767);
  const allowFileOrigin = options.allowFileOrigin ?? (process.env.ALLOW_FILE_ORIGIN === '1');
  const allowedOrigins = new Set(
    (options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? '')
      .split(',').map((value) => parseOrigin(value.trim())).filter(Boolean)
  );
  if (!isPrivateIPv4(advertiseHost) && advertiseHost !== '127.0.0.1' && advertiseHost !== 'localhost')
    throw new Error('ADVERTISE_HOST must be a private LAN address or localhost');
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535)
    throw new Error('PORT must be an integer from 0 to 65535');

  const server = http.createServer(async (request, response) => {
    let origin = null;
    try {
      if (!isTrustedClient(request.socket.remoteAddress, options.interfaces))
        throw new BridgeError(403, 'LOCAL_NETWORK_ONLY');
      const url = new URL(request.url || '/', 'http://local.invalid');
      const route = url.pathname;
      const port = server.address()?.port || configuredPort;
      const phoneUrl = `http://${advertiseHost}:${port}/phone`;
      const requestOrigin = request.headers.origin;
      if (requestOrigin) {
        const allowed = new Set(allowedOrigins);
        allowed.add(`http://${advertiseHost}:${port}`);
        allowed.add(`http://127.0.0.1:${port}`);
        allowed.add(`http://localhost:${port}`);
        if (allowFileOrigin && (requestOrigin === 'null' || /^file:\/\/\/*$/.test(requestOrigin)) &&
            RECEIVER_ROUTES.has(route)) origin = 'null';
        else if (allowed.has(parseOrigin(requestOrigin))) origin = requestOrigin;
        else throw new BridgeError(403, 'ORIGIN_NOT_ALLOWED');
      }
      if (request.method === 'OPTIONS' && RECEIVER_ROUTES.has(route)) {
        if (!origin) throw new BridgeError(403, 'ORIGIN_NOT_ALLOWED');
        response.writeHead(204, {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
          'cache-control': 'no-store', 'vary': 'Origin'
        });
        response.end();
        return;
      }
      if (route === '/health' && request.method === 'GET') {
        send(response, 200, { ok: true, service: 'second-screen-bridge' }, origin);
        return;
      }
      if (route === '/' && request.method === 'GET') {
        response.writeHead(302, { location: '/receiver', 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (ASSETS.has(route) && request.method === 'GET') {
        const [filename, type] = ASSETS.get(route);
        const body = await fs.readFile(path.join(PUBLIC, filename));
        response.writeHead(200, {
          'content-type': type, 'content-length': body.length, 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        });
        response.end(body);
        return;
      }
      if (request.method !== 'POST' || (!RECEIVER_ROUTES.has(route) && !PHONE_ROUTES.has(route))) {
        send(response, 404, { ok: false, code: 'NOT_FOUND' }, origin);
        return;
      }
      const payload = await readJson(request);
      const address = request.socket.remoteAddress?.replace(/^::ffff:/, '') || '';
      const result = route === '/api/receivers' ? store.createReceiver(payload, phoneUrl) :
        route === '/api/receivers/poll' ? store.poll(payload) :
        route === '/api/receivers/ack' ? store.ack(payload) :
        route === '/api/receivers/rotate' ? store.rotate(payload, phoneUrl) :
        route === '/api/receivers/close' ? store.close(payload) :
        route === '/api/phones/connect' ? store.connect(payload, address) :
        route === '/api/phones/disconnect' ? store.disconnect(payload, address) :
        store.send(payload, address);
      send(response, route === '/api/receivers' ? 201 : 200, result, origin);
    } catch (error) {
      if (error instanceof BridgeError) send(response, error.status, { ok: false, code: error.code }, origin);
      else {
        if (process.env.NODE_ENV !== 'test') console.error('Request failed:', error);
        send(response, 500, { ok: false, code: 'INTERNAL_ERROR' }, origin);
      }
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 12_000;
  return { server, store, advertiseHost, configuredPort };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '0.0.0.0';
  const bridge = createBridgeServer();
  bridge.server.listen(bridge.configuredPort, host, () => {
    const port = bridge.server.address().port;
    console.log(`Second Screen Bridge ready: http://${bridge.advertiseHost}:${port}/receiver`);
    console.log(`Phone page: http://${bridge.advertiseHost}:${port}/phone`);
  });
}
