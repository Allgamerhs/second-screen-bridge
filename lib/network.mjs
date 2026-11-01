import os from 'node:os';

function ipNumber(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((number, part) => ((number << 8) | Number(part)) >>> 0, 0);
}

export function normalizeAddress(address) {
  const value = String(address || '');
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

export function isPrivateIPv4(address) {
  const value = normalizeAddress(address);
  if (ipNumber(value) === null) return false;
  const octets = value.split('.').map(Number);
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function privateInterfaces(interfaces) {
  return Object.values(interfaces).flat().filter((entry) =>
    entry && !entry.internal && (entry.family === 'IPv4' || entry.family === 4) &&
    isPrivateIPv4(entry.address) && ipNumber(entry.netmask) !== null);
}

export function isTrustedClient(address, interfaces = os.networkInterfaces()) {
  const value = normalizeAddress(address);
  if (value === '::1' || value === '127.0.0.1') return true;
  const client = ipNumber(value);
  if (client === null || !isPrivateIPv4(value)) return false;
  return privateInterfaces(interfaces).some((entry) => {
    const mask = ipNumber(entry.netmask);
    return (client & mask) === (ipNumber(entry.address) & mask);
  });
}

export function defaultAdvertiseHost(interfaces = os.networkInterfaces()) {
  return privateInterfaces(interfaces)[0]?.address || '127.0.0.1';
}
