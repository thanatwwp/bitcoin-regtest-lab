import { createAppServer } from '../server.mjs';
import { ActionService } from '../src/actions.mjs';
import { DashboardService } from '../src/dashboard-service.mjs';
import { createFixtureRpc } from './regtest-fixture.mjs';
import { ExplorerService } from '../src/explorer-service.mjs';

const bitcoin = createFixtureRpc();
const electrum = {
  host: '127.0.0.1', port: 60401, endpointLabel: 'SIMULATED ELECTRS',
  async inspect() { return { serverSoftware: 'Simulated electrs', protocolVersion: '1.4', tipHeight: (await bitcoin.call('getblockchaininfo')).blocks, latencyMs: 1 }; }
};
const service = new DashboardService({ bitcoin, electrum });
const server = createAppServer({
  dashboard: { async snapshot() { return { ...await service.snapshot(), testing: true }; } },
  actions: new ActionService({ bitcoin }),
  explorer: new ExplorerService({ bitcoin, electrum })
});
server.listen(3001, '127.0.0.1', () => console.log('SIMULATED interactive preview: http://127.0.0.1:3001'));
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
