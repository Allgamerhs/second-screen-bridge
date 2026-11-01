# Second Screen Bridge

Use a phone as a text keyboard and simple remote for a TV browser, kiosk, projector, or another screen on the same local network. Open the receiver on the large screen, enter its short pairing code on your phone, then send text, URLs, or navigation keys. There is no account, cloud service, framework, or build step.

Second Screen Bridge is a standalone project. Its pairing code, phone page, server, and browser receiver SDK do not depend on an IPTV application or a particular set-top box vendor.

## Features

- **Phone input:** send text to a named field, paste a URL, and use a touch-friendly D-pad with Enter, Backspace, and Escape.
- **Short-lived pairing:** a single-use eight-digit code expires after five minutes. A phone connection lasts 15 minutes, is bound to its local IP address, and can be disconnected immediately.
- **Multiple receivers:** each screen gets its own code, event queue, and phone session. Rotating a code disconnects its phones.
- **Browser integration:** a plain JavaScript receiver SDK uses `XMLHttpRequest` and `text/plain` JSON requests for older TV browsers.
- **Small footprint:** Node.js built-ins on the server; HTML, CSS, and JavaScript in the browser; no runtime packages.
- **Local control:** bounded messages and queues, pairing attempt limits, and no stored account credentials. State stays in memory and disappears when the server stops.

## Requirements

- Node.js 20 or newer on a computer reachable by both screens.
- The computer, TV/receiver, and phone on the same trusted local network.
- A modern phone browser. The receiver SDK also targets older embedded WebKit browsers.

## Quick start

```sh
git clone https://github.com/Allgamerhs/second-screen-bridge.git
cd second-screen-bridge
npm start
```

The server prints a local address. Open its **`/receiver`** page on the large screen and **`/phone`** on the phone. Enter the eight-digit code shown on the receiver. You can also open the printed base address on the large screen; it redirects to `/receiver`.

For example, if the computer's LAN address is `192.168.1.10`, the pages are `http://192.168.1.10:8767/receiver` and `http://192.168.1.10:8767/phone`. Replace that example address with the one printed by your server. If the computer has multiple network adapters, set `ADVERTISE_HOST` to the address your phone and receiver can reach.

On PowerShell, an explicit adapter address looks like this:

```powershell
$env:ADVERTISE_HOST = 'YOUR_COMPUTER_LAN_IP'
npm start
```

On macOS or Linux:

```sh
ADVERTISE_HOST=YOUR_COMPUTER_LAN_IP npm start
```

Your operating system may ask whether Node.js may receive connections on the private network. Allow it only on the trusted network you intend to use. The server must not be exposed to the public Internet.

## Add a receiver to your own page

The demo at `/receiver` is useful for trying the project. For an existing web app, load the SDK from your running bridge server and handle its callbacks:

```html
<div>Pairing code: <strong id="bridge-code">Waiting…</strong></div>
<div>Phone address: <span id="bridge-phone"></span></div>
<input id="search" aria-label="Search">
<script src="http://YOUR_COMPUTER_LAN_IP:8767/receiver.js"></script>
<script>
  var bridge = SecondScreenBridge.createReceiver({
    server: 'http://YOUR_COMPUTER_LAN_IP:8767',
    name: 'Living room screen',
    fields: [{ id: 'search', label: 'Search', kind: 'text' }],
    onPairing: function (pairing) {
      document.getElementById('bridge-code').textContent = pairing.code;
      document.getElementById('bridge-phone').textContent = pairing.phoneUrl;
    },
    onText: function (event) {
      if (event.field === 'search') {
        document.getElementById('search').value = event.value;
      }
    },
    onKey: function (event) {
      // Route event.key through your application's navigation logic.
      // The SDK never synthesizes an untrusted keyboard event for you.
    }
  });
  bridge.start();
</script>
```

`createReceiver` returns `start()`, `stop()`, `rotate()`, and `getState()`. `onText` receives `{ field, value, seq }`; `onKey` receives `{ key, seq }`. `onStatus`, `onPairing`, and `onError` are available for your own status UI. `rotate()` creates a fresh code and revokes connected phones. If your app uses a restrictive Content Security Policy, place the integration code in your own script file and allow the bridge server in `script-src` and `connect-src`.

The demo receiver at `/receiver` works without cross-origin configuration. A receiver loaded from a local `file://` page requires `ALLOW_FILE_ORIGIN=1` on the server; leave this disabled unless you need it on a trusted LAN. For receivers hosted on another web origin, add that exact origin to `ALLOWED_ORIGINS`. The phone page is always served by the bridge server.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address the HTTP server listens on. |
| `PORT` | `8767` | HTTP port. |
| `ADVERTISE_HOST` | Detected private IPv4 address | Address shown to phones and receivers. Set this when multiple adapters exist. |
| `ALLOWED_ORIGINS` | Same-origin only | Comma-separated additional web origins allowed to call receiver APIs. Use exact origins, not `*`. |
| `ALLOW_FILE_ORIGIN` | `0` | Set to `1` to permit `file://` receiver pages on the trusted LAN. |

Restart the server after changing these variables. Active pairings are intentionally lost on restart.

## API overview

The provided SDK and phone page handle the API for most users. JSON is sent in `text/plain` POST bodies so an older file-based TV browser can make a simple cross-origin request. Responses are JSON.

| Caller | Route | Purpose |
| --- | --- | --- |
| Receiver | `POST /api/receivers` | Create a receiver and get its pairing code and private receiver token. |
| Receiver | `POST /api/receivers/poll` | Read queued phone events after a sequence number. |
| Receiver | `POST /api/receivers/ack` | Remove events after handling them. |
| Receiver | `POST /api/receivers/rotate` | Revoke phones and create a fresh pairing code. |
| Receiver | `POST /api/receivers/close` | Close the receiver session. |
| Phone | `POST /api/phones/connect` | Exchange a short code for a temporary phone token. |
| Phone | `POST /api/phones/send` | Send text or a supported remote key. |
| Phone | `POST /api/phones/disconnect` | Revoke the phone token immediately. |
| Anyone on the allowed LAN | `GET /health` | Minimal health check. |

The receiver token and phone token must remain private. Do not put them into URLs, screenshots, logs, or a Git repository. Pairing codes are short-lived but should be treated as temporary credentials.

## Network and privacy limits

This is an **HTTP service for a trusted local network**. Traffic, including text and URLs sent from a phone, is not encrypted. Do not send passwords or private playlist URLs on a network you do not trust. Do not port-forward the service, publish it through a tunnel, or use it as an Internet-facing login system. For remote access, put a separately reviewed HTTPS and authentication layer in front of it.

Sessions and pending messages are held in the server process's memory. The project does not provide durable queues, accounts, multi-server synchronization, or automatic discovery across separate subnets. A server restart disconnects receivers and phones; refresh the receiver page to get a new code.

## Development

```sh
npm test
```

Tests cover the server's pairing, authorization, and event flow. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [SECURITY.md](SECURITY.md) for reporting security issues.

## License

[MIT](LICENSE).
