import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createBridgeServer } from '../server.mjs';
import { BridgeStore, BridgeError } from '../lib/store.mjs';
import { isTrustedClient, defaultAdvertiseHost } from '../lib/network.mjs';

const interfaces = {
  Ethernet: [{ address: '192.168.50.10', netmask: '255.255.255.0', family: 'IPv4', internal: false }]
};

test('LAN filtering follows the adapter subnet and permits loopback', () => {
  assert.equal(isTrustedClient('192.168.50.44', interfaces), true);
  assert.equal(isTrustedClient('::ffff:192.168.50.44', interfaces), true);
  assert.equal(isTrustedClient('192.168.51.44', interfaces), false);
  assert.equal(isTrustedClient('8.8.8.8', interfaces), false);
  assert.equal(isTrustedClient('::1', interfaces), true);
  assert.equal(defaultAdvertiseHost(interfaces), '192.168.50.10');
});

test('short-lived codes, IP-bound phone tokens and bounded event queue', () => {
  let now = 1000000;
  const store = new BridgeStore({ now: () => now });
  const created = store.createReceiver({ name: ' Test TV ', fields: [
    { id: 'search', label: 'Search', kind: 'text' },
    { id: 'stream', label: 'Stream URL', kind: 'url' }
  ] }, 'http://192.168.50.10:8767/phone');
  assert.match(created.code, /^\d{8}$/);
  const phone = store.connect({ code: created.code }, '192.168.50.21');
  assert.equal(phone.receiverName, 'Test TV');
  assert.throws(() => store.connect({ code: created.code }, '192.168.50.21'),
    (error) => error instanceof BridgeError && error.code === 'INVALID_CODE');
  assert.throws(() => store.send({ token: phone.token, type: 'text', field: 'search', value: 'hello' },
    '192.168.50.22'), (error) => error.code === 'INVALID_PHONE');
  assert.throws(() => store.send({ token: phone.token, type: 'text', field: 'stream',
    value: 'javascript:alert(1)' }, '192.168.50.21'), (error) => error.code === 'INVALID_URL');
  assert.equal(store.send({ token: phone.token, type: 'text', field: 'search',
    value: 'hello' }, '192.168.50.21').seq, 1);
  assert.equal(store.send({ token: phone.token, type: 'key', key: 'ArrowRight' },
    '192.168.50.21').seq, 2);
  const polled = store.poll({ receiverToken: created.receiverToken, after: 0 });
  assert.equal(polled.pairedCount, 1);
  assert.throws(() => store.poll({ receiverToken: created.receiverToken, after: 3 }),
    (error) => error.code === 'INVALID_CURSOR');
  assert.deepEqual(polled.events, [
    { seq: 1, type: 'text', field: 'search', value: 'hello' },
    { seq: 2, type: 'key', key: 'ArrowRight' }
  ]);
  assert.equal(store.ack({ receiverToken: created.receiverToken, through: 1 }).through, 1);
  assert.deepEqual(store.poll({ receiverToken: created.receiverToken, after: 0 }).events,
    [{ seq: 2, type: 'key', key: 'ArrowRight' }]);
  const rotated = store.rotate({ receiverToken: created.receiverToken }, 'http://example/phone');
  assert.match(rotated.code, /^\d{8}$/);
  assert.throws(() => store.send({ token: phone.token, type: 'key', key: 'Enter' }, '192.168.50.21'),
    (error) => error.code === 'INVALID_PHONE');
  now += 5 * 60 * 1000 + 1;
  assert.throws(() => store.connect({ code: rotated.code }, '192.168.50.21'),
    (error) => error.code === 'INVALID_CODE');
});

test('pairing guesses are rate limited', () => {
  const store = new BridgeStore();
  for (let i = 0; i < 5; i++) {
    assert.throws(() => store.connect({ code: '00000000' }, '192.168.50.22'),
      (error) => error.code === 'INVALID_CODE');
  }
  assert.throws(() => store.connect({ code: '00000000' }, '192.168.50.22'),
    (error) => error.code === 'TOO_MANY_ATTEMPTS');
});

test('HTTP pairing and input flow with legacy text/plain and origin checks', async (t) => {
  const { server } = createBridgeServer({ port: 0, advertiseHost: '127.0.0.1', allowFileOrigin: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, value, origin = 'null') => fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', ...(origin && { origin }) },
    body: JSON.stringify(value)
  });
  let response = await fetch(base + '/health');
  assert.equal(response.status, 200);
  response = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/receiver');
  response = await fetch(base + '/api/receivers', {
    method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type' }
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'null');
  response = await post('/api/receivers', { name: 'Living room', fields: [
    { id: 'search', label: 'Search', kind: 'text' }
  ] });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('access-control-allow-origin'), 'null');
  const created = await response.json();
  assert.equal(created.phoneUrl, base + '/phone');
  response = await post('/api/phones/connect', { code: created.code }, base);
  assert.equal(response.status, 200);
  const connected = await response.json();
  response = await post('/api/phones/send', { token: connected.token,
    type: 'text', field: 'search', value: 'open source' }, base);
  assert.equal(response.status, 200);
  response = await post('/api/receivers/poll', { receiverToken: created.receiverToken, after: 0 });
  assert.equal(response.status, 200);
  const polled = await response.json();
  assert.equal(polled.pairedCount, 1);
  assert.equal(polled.events[0].value, 'open source');
  response = await post('/api/receivers/ack', { receiverToken: created.receiverToken, through: 1 });
  assert.equal(response.status, 200);
  response = await post('/api/receivers/poll', { receiverToken: created.receiverToken, after: 0 });
  assert.deepEqual((await response.json()).events, []);
  response = await post('/api/receivers', { name: 'Bad', fields: [] }, 'http://evil.example');
  assert.equal(response.status, 403);
  response = await post('/api/phones/send', { token: connected.token, type: 'key', key: 'Enter' }, 'null');
  assert.equal(response.status, 403);
  response = await post('/api/phones/disconnect', { token: connected.token }, base);
  assert.equal(response.status, 200);
  response = await post('/api/receivers/poll', { receiverToken: created.receiverToken, after: 0 });
  assert.equal((await response.json()).pairedCount, 0);
  response = await post('/api/receivers/close', { receiverToken: created.receiverToken });
  assert.equal(response.status, 200);
  response = await post('/api/phones/send', { token: connected.token, type: 'key', key: 'Enter' }, base);
  assert.equal(response.status, 401);
});

test('file-origin receiver requests require an explicit opt-in', async (t) => {
  const { server } = createBridgeServer({ port: 0, advertiseHost: '127.0.0.1', allowFileOrigin: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/api/receivers', {
    method: 'POST',
    headers: { origin: 'null', 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ name: 'TV', fields: [{ id: 'search', label: 'Search', kind: 'text' }] })
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'ORIGIN_NOT_ALLOWED');
});
