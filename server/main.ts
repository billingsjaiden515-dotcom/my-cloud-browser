import { createServer } from './http-server.js';
import { startFfmpegWatchdog, killAllTracked, killAllTrackedSync } from './process-reaper.js';

// Render provides PORT; fall back to 3001 for local dev.
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || '3001', 10);

const { server, sessionManager } = createServer();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Cloud Browser backend listening on port ${PORT}`);
  console.log(`[Server] HTTP API: http://0.0.0.0:${PORT}/api`);
  console.log(`[Server] WebSocket signaling: ws://0.0.0.0:${PORT}/signal`);
});

// Watchdog: every 60s log the running ffmpeg processes and SIGKILL any that
// predate the current session -- i.e. that survived a previous session or a
// hard parent kill, which no in-process teardown could have prevented.
startFfmpegWatchdog();

// Last-resort safety net. The 'exit' hook cannot await anything, so this is a
// purely synchronous SIGKILL of everything still tracked.
process.on('exit', () => { killAllTrackedSync(); });

// Hard ceiling on teardown. A wedged child must never be able to keep the
// process alive forever, so we always force-exit after this.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 5000;

let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Server] Shutting down (${reason})...`);

  // unref'd: this must not itself be a reason for the process to stay alive,
  // but it must still fire if an open connection (or a stuck child) holds the
  // event loop open past the ceiling.
  const forceExit = setTimeout(() => {
    console.error(`[Server] Teardown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
    process.exit(exitCode);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    // This is what actually kills Chromium and the three ffmpeg children
    // (x11grab, VP8, Opus). It MUST be awaited, and it must happen BEFORE the
    // listener is closed: the previous handler called server.close() and then
    // process.exit(0) on the very next line, so stopAll() never got to run and
    // every shutdown/restart orphaned its children.
    await sessionManager.stopAll();
  } catch (e) {
    console.error('[Server] Error stopping sessions:', e);
  }

  // Final sweep: children that belong to no session (or that outlived a failed
  // session teardown) are killed here, and we wait for them.
  try {
    await killAllTracked('server shutdown');
  } catch (e) {
    console.error('[Server] Error reaping child processes:', e);
  }

  server.close(() => {
    clearTimeout(forceExit);
    console.log('[Server] Closed cleanly');
    process.exit(exitCode);
  });

  // server.close() waits for open connections to drain. A held keep-alive or
  // WebSocket would otherwise stall teardown until the ceiling above fires.
  const withConn = server as unknown as { closeAllConnections?: () => void };
  withConn.closeAllConnections?.();
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

// Crashes must also tear down, or the children outlive the server they belong
// to and accumulate as orphans. Exit code 1 keeps the failure visible.
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason);
  void shutdown('unhandledRejection', 1);
});
