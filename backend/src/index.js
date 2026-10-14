'use strict';
const { loadEnv } = require('./env');
loadEnv();
const { buildConfig } = require('./config');
const { createStore } = require('./store');
const { createServer } = require('./server');

async function main() {
  const config = buildConfig();
  for (const w of config.warnings) console.warn('[config]', w);

  const store = createStore(config);
  await store.init();

  const { app } = createServer({ config, store });
  const server = app.listen(config.port, () => {
    console.log(`[backend] listening on http://localhost:${config.port}  (authMode=${config.authMode}, store=${config.store})`);
    console.log(`[backend] admin page: http://localhost:${config.port}/admin`);
    if (!config.isProd) console.log(`[backend] dev ADMIN_TOKEN = ${config.adminToken}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[backend] fatal:', err);
  process.exit(1);
});
