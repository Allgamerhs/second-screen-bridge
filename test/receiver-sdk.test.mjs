import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('a failed ACK retries without applying the same remote key twice', async () => {
  const source = fs.readFileSync(new URL('../public/receiver.js', import.meta.url), 'utf8');
  let ackCalls = 0;
  let acked = false;
  let delivered = 0;
  let closed = false;
  class FakeXHR {
    open(_method, url) { this.url = url; }
    setRequestHeader() {}
    send() {
      setImmediate(() => {
        let status = 200;
        let body = { ok: true };
        if (this.url.endsWith('/api/receivers')) {
          status = 201;
          body = { ok: true, receiverToken: 'receiver-token', code: '12345678',
            phoneUrl: 'http://localhost:8767/phone', expiresAt: new Date(Date.now() + 300000).toISOString() };
        } else if (this.url.endsWith('/api/receivers/poll')) {
          body = { ok: true, events: acked ? [] : [{ seq: 1, type: 'key', key: 'ArrowRight' }],
            nextSeq: acked ? 1 : 0, pairedCount: 1 };
        } else if (this.url.endsWith('/api/receivers/ack')) {
          ackCalls += 1;
          if (ackCalls === 1) { status = 503; body = { ok: false, code: 'TEMPORARY' }; }
          else { acked = true; body = { ok: true, through: 1 }; }
        } else if (this.url.endsWith('/api/receivers/close')) {
          closed = true;
        }
        this.status = status;
        this.responseText = JSON.stringify(body);
        this.readyState = 4;
        this.onreadystatechange?.();
      });
    }
    abort() {}
  }
  const window = { location: { protocol: 'http:', host: 'localhost:8767' } };
  vm.runInNewContext(source, { window, XMLHttpRequest: FakeXHR, setTimeout, clearTimeout });
  const receiver = window.SecondScreenBridge.createReceiver({
    name: 'Test screen',
    fields: [{ id: 'search', label: 'Search', kind: 'text' }],
    onKey: () => { delivered += 1; }
  });
  receiver.start();
  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('ACK retry did not finish')), 4000);
      const poll = setInterval(() => {
        if (!acked) return;
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }, 20);
    });
    assert.equal(ackCalls, 2);
    assert.equal(delivered, 1);
    assert.equal(receiver.getState().lastSeq, 1);
  } finally {
    receiver.stop();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
});
