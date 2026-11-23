export class DashboardError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'DashboardError';
    this.code = code;
  }
}

const SAFE_MESSAGES = Object.freeze({
  CONFIGURATION_ERROR: 'Bitcoin Core RPC credentials are not configured on the dashboard server.',
  AUTHENTICATION_ERROR: 'Bitcoin Core rejected the configured RPC credentials.',
  RPC_CONNECTION_ERROR: 'The dashboard could not reach Bitcoin Core RPC on the configured local address.',
  RPC_RESPONSE_ERROR: 'Bitcoin Core returned an unexpected response.',
  ELECTRS_CONNECTION_ERROR: 'The dashboard could not reach electrs on the configured local address.',
  ELECTRS_PROTOCOL_ERROR: 'electrs returned an unexpected Electrum response.',
  REQUEST_TIMEOUT: 'The local service did not respond before the timeout.'
});

export function publicError(error, fallback = 'The local service could not be queried.') {
  const code = error instanceof DashboardError ? error.code : 'UNKNOWN_ERROR';
  return {
    code,
    message: SAFE_MESSAGES[code] || fallback
  };
}
