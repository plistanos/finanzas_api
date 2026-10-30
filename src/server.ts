import { MongoClient } from 'mongodb';
import { bootstrapAccounts } from './accounts.js';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

async function start() {
  const config = loadConfig();
  const client = new MongoClient(config.MONGODB_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db();
    await db.command({ ping: 1 });
    const { auth, storesForUser } = await bootstrapAccounts(db, config);
    const app = createApp({ config, auth, storesForUser, ping: async () => { await db.command({ ping: 1 }); } });
    const server = app.listen(config.PORT, config.HOST, () => {
      console.info(`Finanzas API: http://${config.HOST}:${config.PORT}/api (${config.NODE_ENV})`);
      console.info('MongoDB conectado. Acceso con cuentas y JWT.');
    });
    server.on('error', async () => { console.error('No se pudo abrir el puerto de la API. Revisa HOST y PORT.'); await client.close(); process.exitCode = 1; });
    const shutdown = () => {
      const timeout = setTimeout(() => process.exit(1), 10000).unref();
      server.close(() => { void client.close().finally(() => { clearTimeout(timeout); process.exit(0); }); });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (error) {
    await client.close();
    console.error('No se pudo conectar a MongoDB. Verifica que MongoDB esté iniciado y que MONGODB_URI apunte a una base accesible.');
    console.error('Tipo de error:', error instanceof Error ? error.name : 'UnknownError');
    process.exitCode = 1;
  }
}
start().catch(() => { console.error('Configuración inválida. Revisa NODE_ENV, MONGODB_URI, PORT, HOST, FRONTEND_URL y los requisitos de JWT_SECRET y las credenciales iniciales del README.'); process.exitCode = 1; });
