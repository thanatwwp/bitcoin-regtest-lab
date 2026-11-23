import { DashboardError } from './errors.mjs';

// No DNS-controlled or remote destination may receive local RPC credentials.
export function localEndpoint(host, port) {
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
      || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DashboardError('CONFIGURATION_ERROR', 'Local services must use a loopback address and a valid port.');
  }
  return { host: host === 'localhost' ? '127.0.0.1' : host.replace(/^\[|\]$/g, ''), port };
}
