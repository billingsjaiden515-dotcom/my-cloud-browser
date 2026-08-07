import { createServer } from './http-server.js';

const PORT = parseInt(process.env.SERVER_PORT || '3001', 10);

const server = createServer();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Cloud Browser backend listening on port ${PORT}`);
  console.log(`[Server] HTTP API: http://0.0.0.0:${PORT}/api`);
  console.log(`[Server] WebSocket signaling: ws://0.0.0.0:${PORT}/signal`);
});

const cleanup = async () => {
  console.log('[Server] Shutting down...');
  server.close();
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
