const path = require('path');
const os = require('os');

const appDir = __dirname;
const cloudflaredBin = path.join(os.homedir(), 'bin', 'cloudflared');

module.exports = {
  apps: [
    {
      name: 'cloudflared-tivishop',
      script: cloudflaredBin,
      args: 'tunnel --config cloudflared/config.yml run',
      cwd: appDir,
      autorestart: true,
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      error_file: path.join(appDir, 'logs/cloudflared-error.log'),
      out_file: path.join(appDir, 'logs/cloudflared-out.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
