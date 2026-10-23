// Named tunnels keep the HTTPS origin stable. Never silently fall back to quick.
export function tunnelConfig(config, port) {
  const tunnel = config.tunnel ?? {mode: 'quick'};
  if (tunnel.mode === 'quick') return {mode: 'quick', args: ['tunnel','--url',`http://127.0.0.1:${port}`,'--no-autoupdate','--protocol','http2']};
  if (tunnel.mode === 'relay') {
    if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(tunnel.publicUrl ?? '') || !tunnel.secretFile) throw Error('Invalid fixed relay settings');
    return {mode:'relay', publicUrl:tunnel.publicUrl, args:['tunnel','--url',`http://127.0.0.1:${port}`,'--no-autoupdate','--protocol','http2']};
  }
  if (tunnel.mode !== 'named') throw Error('Unsupported tunnel mode');
  const url = new URL(tunnel.publicUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !url.hostname.includes('.') || url.hostname.endsWith('.trycloudflare.com')) throw Error('Named tunnel requires a fixed HTTPS origin');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(tunnel.name ?? '')) throw Error('Invalid named tunnel name or ID');
  return {mode: 'named', publicUrl: url.origin, args: ['tunnel','--no-autoupdate','--url',`http://127.0.0.1:${port}`,'--protocol','http2','run',tunnel.name]};
}
