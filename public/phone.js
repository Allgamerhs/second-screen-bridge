(function () {
  'use strict';

  var token = '';
  var expiresAt = '';
  var pairSection = document.getElementById('pairSection');
  var controlSection = document.getElementById('controlSection');
  var pairForm = document.getElementById('pairForm');
  var pairCodeInput = document.getElementById('pairCodeInput');
  var connectButton = document.getElementById('connectButton');
  var disconnectButton = document.getElementById('disconnectButton');
  var receiverName = document.getElementById('receiverName');
  var sessionExpires = document.getElementById('sessionExpires');
  var targetField = document.getElementById('targetField');
  var messageText = document.getElementById('messageText');
  var sendForm = document.getElementById('sendForm');
  var sendText = document.getElementById('sendText');
  var clearText = document.getElementById('clearText');
  var status = document.getElementById('phoneStatus');

  function showStatus(message, failed) {
    status.textContent = message;
    status.setAttribute('data-status', failed ? 'error' : 'ok');
  }

  function request(path, payload, done) {
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
      xhr.open('POST', path, true);
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
            'Request failed (' + xhr.status + ').' }, data);
        }
      };
      xhr.onerror = function () {
        finish({ code: 'NETWORK_ERROR', message: 'Cannot reach the bridge.' });
      };
      xhr.send(JSON.stringify(payload));
    } catch (error) {
      finish({ code: 'REQUEST_ERROR', message: error.message || 'Cannot send request.' });
    }
  }

  function isSessionError(error) {
    return error && (error.code === 'INVALID_PHONE' || error.code === 'PHONE_NOT_FOUND' ||
      error.code === 'SESSION_EXPIRED' || error.code === 'UNAUTHORIZED');
  }

  function leave(message) {
    token = '';
    expiresAt = '';
    controlSection.classList.add('is-hidden');
    pairSection.classList.remove('is-hidden');
    pairCodeInput.value = '';
    showStatus(message || 'Left the screen. Enter a new code to reconnect.', false);
  }

  function updateExpiry() {
    var ms, minutes;
    if (!token || !expiresAt) { return; }
    ms = Date.parse(expiresAt) - Date.now();
    if (ms <= 0) {
      leave('Session expired. Ask the screen for a new code.');
      return;
    }
    minutes = Math.ceil(ms / 60000);
    sessionExpires.textContent = 'Session ends in about ' + minutes + ' minute(s).';
  }

  pairCodeInput.addEventListener('input', function () {
    var digits = pairCodeInput.value.replace(/\D/g, '').slice(0, 8);
    if (pairCodeInput.value !== digits) { pairCodeInput.value = digits; }
  });

  pairForm.addEventListener('submit', function (event) {
    var code = pairCodeInput.value.replace(/\D/g, '');
    event.preventDefault();
    if (!/^\d{8}$/.test(code)) {
      showStatus('Enter the eight digits displayed on your screen.', true);
      pairCodeInput.focus();
      return;
    }
    connectButton.disabled = true;
    showStatus('Pairing with your screen…', false);
    request('/api/phones/connect', { code: code }, function (error, data) {
      var i, option, fields;
      connectButton.disabled = false;
      if (error) {
        showStatus(error.code === 'INVALID_CODE' ?
          'Code not accepted. Check it on the screen or request a new one.' :
          error.message, true);
        return;
      }
      token = data.token;
      expiresAt = data.expiresAt || '';
      receiverName.textContent = data.receiverName || 'your screen';
      fields = data.fields || [];
      while (targetField.firstChild) { targetField.removeChild(targetField.firstChild); }
      for (i = 0; i < fields.length; i += 1) {
        option = document.createElement('option');
        option.value = fields[i].id;
        option.textContent = fields[i].label;
        option.setAttribute('data-kind', fields[i].kind);
        targetField.appendChild(option);
      }
      pairSection.classList.add('is-hidden');
      controlSection.classList.remove('is-hidden');
      updateExpiry();
      showStatus('Connected. Type or paste, then send to the screen.', false);
      messageText.focus();
    });
  });

  sendForm.addEventListener('submit', function (event) {
    var value = messageText.value;
    var choice = targetField.options[targetField.selectedIndex];
    event.preventDefault();
    if (!token) { leave('Pair with a screen first.'); return; }
    if (!targetField.value) { showStatus('This screen has no text fields.', true); return; }
    if (!value.trim()) { showStatus('Type or paste some text first.', true); return; }
    if (choice && choice.getAttribute('data-kind') === 'url') {
      try {
        var parsed = new URL(value);
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            parsed.username || parsed.password) { throw new Error('Invalid URL'); }
      } catch (ignored) {
        showStatus('Enter a complete http:// or https:// URL without embedded credentials.', true);
        return;
      }
    }
    sendText.disabled = true;
    request('/api/phones/send', {
      token: token, type: 'text', field: targetField.value, value: value
    }, function (error) {
      sendText.disabled = false;
      if (error) {
        if (isSessionError(error)) { leave('Session ended. Pair again with a new code.'); }
        else { showStatus(error.code === 'INVALID_URL' ?
          'Enter a complete http:// or https:// URL without embedded credentials.' :
          error.message, true); }
        return;
      }
      showStatus('Sent to ' + targetField.options[targetField.selectedIndex].text + '.', false);
    });
  });

  clearText.addEventListener('click', function () {
    messageText.value = '';
    messageText.focus();
  });
  disconnectButton.addEventListener('click', function () {
    if (!token) { leave(); return; }
    disconnectButton.disabled = true;
    request('/api/phones/disconnect', { token: token }, function (error) {
      disconnectButton.disabled = false;
      if (error && !isSessionError(error)) {
        showStatus('Could not disconnect. Check the connection and try again.', true);
        return;
      }
      leave('Disconnected from the screen.');
    });
  });

  var keyButtons = document.querySelectorAll('[data-key]');
  for (var i = 0; i < keyButtons.length; i += 1) {
    keyButtons[i].addEventListener('click', function () {
      var key = this.getAttribute('data-key');
      if (!token) { leave('Pair with a screen first.'); return; }
      request('/api/phones/send', { token: token, type: 'key', key: key },
        function (error) {
          if (error) {
            if (isSessionError(error)) { leave('Session ended. Pair again with a new code.'); }
            else { showStatus(error.message, true); }
          } else { showStatus('Sent ' + key + '.', false); }
        });
    });
  }

  setInterval(updateExpiry, 30000);
}());
