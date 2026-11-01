(function (root) {
  'use strict';

  function noop() {}

  function request(base, path, payload, done) {
    var xhr = new XMLHttpRequest();
    var complete = false;
    var timer;
    function finish(error, data) {
      if (complete) { return; }
      complete = true;
      clearTimeout(timer);
      done(error, data);
    }
    try {
      xhr.open('POST', base + path, true);
      // A simple request also works in older file:// TV WebKit builds.
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      timer = setTimeout(function () {
        try { xhr.abort(); } catch (ignored) {}
        finish({ code: 'TIMEOUT', message: 'The bridge did not respond.' });
      }, 8000);
      xhr.onreadystatechange = function () {
        var data;
        if (xhr.readyState !== 4 || complete) { return; }
        try { data = JSON.parse(xhr.responseText || '{}'); }
        catch (ignored) { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300 && data.ok === true) {
          finish(null, data);
        } else {
          finish({ code: data.code || 'HTTP_ERROR', message: data.message ||
            'Bridge request failed (' + xhr.status + ').' }, data);
        }
      };
      xhr.onerror = function () {
        finish({ code: 'NETWORK_ERROR', message: 'Cannot reach the bridge.' });
      };
      xhr.send(JSON.stringify(payload || {}));
    } catch (error) {
      finish({ code: 'REQUEST_ERROR', message: error.message || 'Cannot start request.' });
    }
  }

  function createReceiver(options) {
    options = options || {};
    var origin = root.location && /^https?:$/.test(root.location.protocol) ?
      root.location.protocol + '//' + root.location.host : '';
    var base = String(options.server || origin || '').replace(/\/+$/, '');
    var fields = options.fields || [{ id: 'text', label: 'Text', kind: 'text' }];
    var name = options.name || 'TV receiver';
    var onText = options.onText || noop;
    var onKey = options.onKey || noop;
    var onStatus = options.onStatus || noop;
    var onPairing = options.onPairing || noop;
    var onError = options.onError || noop;
    var generation = 0;
    var timer = 0;
    var running = false;
    var token = '';
    var status = 'stopped';
    var code = '';
    var phoneUrl = '';
    var expiresAt = '';
    var lastSeq = 0;
    var deliveredSeq = 0;
    var pairedCount = 0;

    if (!/^https?:\/\/[^/]+$/i.test(base)) {
      throw new Error('Set server to the bridge origin, for example http://192.168.1.10:8767.');
    }

    function setStatus(next, message) {
      status = next;
      onStatus({ status: next, message: message || '' });
    }
    function schedule(delay, runId) {
      if (!running || runId !== generation) { return; }
      clearTimeout(timer);
      timer = setTimeout(function () { poll(runId); }, delay);
    }
    function ackDelivered(runId) {
      var through = deliveredSeq;
      request(base, '/api/receivers/ack', { receiverToken: token, through: through },
        function (error) {
          if (!running || runId !== generation) { return; }
          if (error) {
            onError(error);
            schedule(1500, runId);
            return;
          }
          lastSeq = through;
          setStatus('active', 'Input received from a paired phone.');
          schedule(350, runId);
        });
    }
    function processEvents(events, runId) {
      var i, item;
      for (i = 0; i < events.length; i += 1) {
        item = events[i];
        if (!item || typeof item.seq !== 'number' || item.seq <= deliveredSeq) { continue; }
        try {
          if (item.type === 'text') {
            onText({ field: item.field, value: item.value, seq: item.seq });
          } else if (item.type === 'key') {
            onKey({ key: item.key, seq: item.seq });
          }
        } catch (error) {
          onError({ code: 'HANDLER_ERROR', message: error.message || 'Event handler failed.' });
          if (deliveredSeq > lastSeq) { ackDelivered(runId); }
          else { schedule(1500, runId); }
          return;
        }
        // ACK can fail transiently. Remember callbacks that already ran so a
        // retry never dispatches the same event twice within this page.
        deliveredSeq = item.seq;
      }
      if (deliveredSeq === lastSeq) { schedule(900, runId); return; }
      ackDelivered(runId);
    }
    function poll(runId) {
      if (!running || runId !== generation || !token) { return; }
      request(base, '/api/receivers/poll', { receiverToken: token, after: lastSeq },
        function (error, data) {
          if (!running || runId !== generation) { return; }
          if (error) {
            if (error.code === 'INVALID_RECEIVER' || error.code === 'RECEIVER_NOT_FOUND' ||
                error.code === 'UNAUTHORIZED') {
              token = '';
              running = false;
              setStatus('disconnected', 'Session ended. Start a new pairing session.');
              onError(error);
              return;
            }
            setStatus('reconnecting', 'Connection interrupted; retrying.');
            onError(error);
            schedule(2000, runId);
            return;
          }
          if (typeof data.pairedCount === 'number') {
            var previousPairedCount = pairedCount;
            pairedCount = data.pairedCount;
            if (pairedCount > 0 && (status === 'pairing' || status === 'disconnected')) {
              code = '';
              expiresAt = '';
              setStatus('paired', 'A phone is connected.');
            } else if (pairedCount === 0 && previousPairedCount > 0) {
              code = '';
              expiresAt = '';
              setStatus('disconnected', 'Phone disconnected. Choose New code to pair again.');
            }
          }
          processEvents(data.events || [], runId);
        });
    }
    function start() {
      var runId;
      if (running) { return; }
      generation += 1;
      runId = generation;
      running = true;
      lastSeq = 0;
      deliveredSeq = 0;
      pairedCount = 0;
      setStatus('connecting', 'Connecting to the local bridge…');
      request(base, '/api/receivers', { name: name, fields: fields },
        function (error, data) {
          if (!running || runId !== generation) { return; }
          if (error) {
            running = false;
            setStatus('error', error.message);
            onError(error);
            return;
          }
          token = data.receiverToken;
          code = data.code;
          phoneUrl = data.phoneUrl;
          expiresAt = data.expiresAt;
          onPairing({ code: code, phoneUrl: phoneUrl, expiresAt: expiresAt });
          setStatus('pairing', 'Open the phone page and enter the code.');
          schedule(100, runId);
        });
    }
    function rotate() {
      if (!running || !token) { return; }
      var runId = generation;
      request(base, '/api/receivers/rotate', { receiverToken: token },
        function (error, data) {
          if (!running || runId !== generation) { return; }
          if (error) { onError(error); return; }
          code = data.code;
          phoneUrl = data.phoneUrl || phoneUrl;
          expiresAt = data.expiresAt;
          pairedCount = 0;
          onPairing({ code: code, phoneUrl: phoneUrl, expiresAt: expiresAt });
          setStatus('pairing', 'Previous phone sessions were disconnected.');
        });
    }
    function stop() {
      var oldToken = token;
      generation += 1;
      running = false;
      clearTimeout(timer);
      token = '';
      code = '';
      phoneUrl = '';
      expiresAt = '';
      pairedCount = 0;
      setStatus('stopped', 'Receiver disconnected.');
      if (oldToken) {
        request(base, '/api/receivers/close', { receiverToken: oldToken }, noop);
      }
    }
    function getState() {
      return { running: running, status: status, code: code, phoneUrl: phoneUrl,
        expiresAt: expiresAt, pairedCount: pairedCount, lastSeq: lastSeq };
    }
    return { start: start, stop: stop, rotate: rotate, getState: getState };
  }

  root.SecondScreenBridge = { createReceiver: createReceiver };

  function startDemo() {
    var marker = document.getElementById('bridgeDemo');
    if (!marker) { return; }
    var codeNode = document.getElementById('pairCode');
    var linkNode = document.getElementById('phoneUrl');
    var statusNode = document.getElementById('receiverStatus');
    var expiresNode = document.getElementById('pairExpires');
    var logNode = document.getElementById('eventLog');
    var fields = [document.getElementById('searchInput'), document.getElementById('urlInput')];
    var selected = 0;
    var bridge;

    function line(message) {
      var item = document.createElement('li');
      item.textContent = message;
      logNode.insertBefore(item, logNode.firstChild);
      while (logNode.children.length > 5) { logNode.removeChild(logNode.lastChild); }
    }
    function highlight() {
      for (var i = 0; i < fields.length; i += 1) {
        fields[i].parentNode.className = 'demo-field' + (i === selected ? ' active-field' : '');
      }
    }
    function handleKey(event) {
      var key = event.key, current = fields[selected], pos;
      if (key === 'ArrowUp' || key === 'ArrowLeft') { selected = 0; highlight(); }
      if (key === 'ArrowDown' || key === 'ArrowRight') { selected = 1; highlight(); }
      if (key === 'Backspace') { current.value = current.value.slice(0, -1); }
      if (key === 'Escape') { current.value = ''; }
      if (key === 'Enter') { line('Enter: ' + (current.value || '(empty)')); return; }
      if (key === 'MediaPlayPause') { line('Media play / pause'); return; }
      line('Remote: ' + key);
    }
    try {
      bridge = createReceiver({
        server: marker.getAttribute('data-server') || '',
        name: 'Living room demo',
        fields: [{ id: 'search', label: 'Search', kind: 'text' },
          { id: 'url', label: 'URL', kind: 'url' }],
        onText: function (event) {
          var target = event.field === 'url' ? fields[1] : fields[0];
          target.value = event.value;
          selected = target === fields[1] ? 1 : 0;
          highlight();
          line('Text received for ' + event.field + '.');
        },
        onKey: handleKey,
        onPairing: function (pair) {
          codeNode.textContent = pair.code;
          linkNode.textContent = pair.phoneUrl;
          linkNode.href = pair.phoneUrl;
          expiresNode.textContent = 'Code expires in 5 minutes.';
        },
        onStatus: function (state) {
          var isRunning = bridge && bridge.getState().running;
          statusNode.textContent = state.message || state.status;
          statusNode.setAttribute('data-status', state.status);
          document.getElementById('startReceiver').disabled = !!isRunning;
          document.getElementById('rotateCode').disabled = !isRunning;
          document.getElementById('disconnectReceiver').disabled = !isRunning;
          if (state.status === 'disconnected') {
            codeNode.textContent = '--------';
            expiresNode.textContent = 'Choose New code to pair again.';
          } else if (state.status === 'paired') {
            codeNode.textContent = 'PAIRED';
            expiresNode.textContent = 'Phone connected. New code disconnects existing phones.';
          }
        },
        onError: function (error) { line('Bridge: ' + error.message); }
      });
    } catch (error) {
      statusNode.textContent = error.message;
      return;
    }
    document.getElementById('rotateCode').onclick = function () { bridge.rotate(); };
    document.getElementById('disconnectReceiver').onclick = function () {
      bridge.stop(); codeNode.textContent = '--------'; linkNode.textContent = 'Disconnected';
      linkNode.removeAttribute('href'); expiresNode.textContent = '';
    };
    document.getElementById('startReceiver').onclick = function () { bridge.start(); };
    highlight();
    bridge.start();
    setInterval(function () {
      var state = bridge.getState();
      var remaining = state.expiresAt ? Date.parse(state.expiresAt) - Date.now() : 0;
      if (state.running && state.expiresAt && remaining <= 0 && state.pairedCount === 0) {
        expiresNode.textContent = 'Code expired. Choose New code.';
      } else if (state.running && remaining > 0 && state.pairedCount === 0) {
        expiresNode.textContent = 'Code expires in ' + Math.ceil(remaining / 60000) + ' minute(s).';
      } else if (state.pairedCount > 0) {
        expiresNode.textContent = 'Phone connected. New code disconnects existing phones.';
      }
    }, 10000);
  }
  if (root.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startDemo, false);
    } else { startDemo(); }
  }
}(window));
