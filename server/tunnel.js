const { spawn } = require('child_process');

let activeTunnelProcess = null;
let currentTunnelUrl = null;

/**
 * Spawns an official Cloudflare Tunnel to expose a local port (e.g. 4005, 3000, 5173)
 * to a free, secure public HTTPS URL accessible on any mobile device worldwide.
 */
function startCloudflareTunnel(port = 4005) {
  return new Promise((resolve) => {
    // If a tunnel is already running, reuse the URL
    if (currentTunnelUrl && activeTunnelProcess) {
      return resolve(currentTunnelUrl);
    }

    console.log(`[Cloudflare] Starting tunnel on port ${port}...`);
    const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      shell: true
    });

    activeTunnelProcess = tunnel;

    let resolved = false;

    // Cloudflare outputs the public URL to stderr
    tunnel.stderr.on('data', (data) => {
      const output = data.toString();
      // Look for the https://*.trycloudflare.com URL pattern
      const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        currentTunnelUrl = match[0];
        console.log(`[Cloudflare] 🎉 Tunnel live at: ${currentTunnelUrl}`);
        resolve(currentTunnelUrl);
      }
    });

    tunnel.stdout.on('data', (data) => {
      const output = data.toString();
      const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        currentTunnelUrl = match[0];
        console.log(`[Cloudflare] 🎉 Tunnel live at: ${currentTunnelUrl}`);
        resolve(currentTunnelUrl);
      }
    });

    tunnel.on('error', (err) => {
      console.error('[Cloudflare] Tunnel process error:', err.message);
      if (!resolved) {
        resolved = true;
        resolve('http://192.168.1.36:' + port);
      }
    });

    // Fallback if URL is not found within 10 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(currentTunnelUrl || 'http://192.168.1.36:' + port);
      }
    }, 10000);
  });
}

function stopCloudflareTunnel() {
  if (activeTunnelProcess) {
    activeTunnelProcess.kill();
    activeTunnelProcess = null;
    currentTunnelUrl = null;
  }
}

module.exports = { startCloudflareTunnel, stopCloudflareTunnel };
