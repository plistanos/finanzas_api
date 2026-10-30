import { MongoClient } from 'mongodb';
import { bootstrapAccounts } from './accounts.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { mongoDiagnostic } from './mongoDiagnostic.js';

// Una conexión y una inicialización por instancia, reutilizadas entre solicitudes.
let application: Promise<ReturnType<typeof createApp>> | undefined;
export function getApplication() {
  application ??= initialize().catch(error => {
    application = undefined;
    throw error;
  });
  return application;
}

async function initialize() {
  const config = loadConfig();
  const client = new MongoClient(config.MONGODB_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db();
    const { auth, storesForUser } = await bootstrapAccounts(db, config);
    return createApp({ config, auth, storesForUser, ping: async () => { await db.command({ ping: 1 }); } });
  } catch (error) {
    console.error('MONGODB_CONNECTION_FAILED', mongoDiagnostic(config.MONGODB_URI, error));
    await client.close();
    throw error;
  }
}
