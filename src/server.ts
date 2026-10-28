import { MongoClient } from 'mongodb';
import MongoStore from 'connect-mongo';
import { loadConfig } from './config.js';
import { MongoFinanceStore } from './store.js';
import { createApp } from './app.js';

async function start() {
  const config = loadConfig();
  const client = new MongoClient(config.MONGODB_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db();
    await db.command({ ping: 1 });
    const store = new MongoFinanceStore(db);
    await store.initialize();
    const sessionStore = config.APP_PASSWORD ? MongoStore.create({ client, dbName: db.databaseName, collectionName: 'sessions', ttl: 8 * 60 * 60 }) : undefined;
    const app = createApp({ config, store, sessionStore, ping: async () => { await db.command({ ping: 1 }); } });
    const server = app.listen(config.PORT, config.HOST, () => {
      console.info(`Finanzas API: http://${config.HOST}:${config.PORT}/api (${config.NODE_ENV})`);
      console.info(`MongoDB conectado. Acceso ${config.APP_PASSWORD ? 'con contraseña' : 'local sin contraseña'}.`);
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
start().catch(() => { console.error('Configuración inválida. Revisa NODE_ENV, MONGODB_URI, PORT, HOST, FRONTEND_URL y los requisitos de APP_PASSWORD y SESSION_SECRET del README.'); process.exitCode = 1; });
