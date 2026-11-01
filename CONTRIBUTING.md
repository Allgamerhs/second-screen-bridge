# Contributing

Thanks for helping make Second Screen Bridge more useful on real TVs and embedded browsers.

## Before opening a pull request

1. Open an issue for substantial API or security changes so the behavior can be discussed first.
2. Keep runtime dependencies at zero unless a dependency solves a clear need that cannot be met safely with Node.js built-ins.
3. Keep the receiver SDK usable in older TV browsers. Avoid adding a build requirement or modern-only syntax to `public/receiver.js`.
4. Run `npm test` on Node.js 20 or newer. Add a focused test when changing pairing, authorization, expiry, queues, or input validation.
5. Update the README when changing an API route, environment variable, browser behavior, or security limit.

Small bug fixes, accessibility improvements, translations of the phone interface, and browser compatibility reports are welcome. Please describe the device/browser, operating system, steps to reproduce, expected behavior, and actual behavior. Never attach a real pairing token or private URL.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
