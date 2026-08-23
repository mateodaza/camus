// Application-boundary lifecycle wiring for the process-local tunnel manager.
// Importing the transport never installs global handlers; callers own removal.
export function installTunnelLifecycle({ manager, server, processRef = process, exit = (code) => processRef.exit(code) } = {}) {
  if (!manager || !server || !processRef?.on) throw new TypeError('manager, server, and processRef are required');
  let closing = false;
  const close = async (signal = 'SIGTERM') => {
    if (closing) return;
    closing = true;
    await manager.close();
    await new Promise((resolve) => server.close(() => resolve()));
    if (signal) exit(signal === 'SIGINT' ? 130 : 143);
  };
  const handlers = {
    SIGINT: () => { close('SIGINT').catch(() => exit(130)); },
    SIGTERM: () => { close('SIGTERM').catch(() => exit(143)); },
  };
  processRef.on('SIGINT', handlers.SIGINT);
  processRef.on('SIGTERM', handlers.SIGTERM);
  return Object.freeze({ close, remove: () => {
    processRef.off?.('SIGINT', handlers.SIGINT);
    processRef.off?.('SIGTERM', handlers.SIGTERM);
  } });
}

