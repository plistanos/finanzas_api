import type { Db } from 'mongodb';
import { AuthService, MongoAuthRepository } from './auth.js';
import { MongoCategoryStore } from './categories.js';
import type { Config } from './config.js';
import { MongoFinanceStore } from './store.js';

export async function bootstrapAccounts(db: Db, config: Config) {
  const repository = new MongoAuthRepository(db);
  await repository.initialize();
  const auth = new AuthService(repository, config.JWT_SECRET, config.NODE_ENV === 'production');
  const owner = await auth.seed(config.INITIAL_USERNAME, config.INITIAL_PASSWORD);
  // Los movimientos usan el _id personal, igual que la primera cuenta.
  // Asignación idempotente: nunca sobrescribe dueños, nombres o colores existentes.
  await db.collection('categories').updateMany({ userId: { $exists: false } }, { $set: { userId: owner.id } });
  await db.collection('categories').createIndex({ userId: 1, id: 1 }, { unique: true });
  type Stores = { store: MongoFinanceStore; categoryStore: MongoCategoryStore };
  const initialized = new Map<string, Promise<Stores>>();
  const storesForUser = (id: string): Promise<Stores> => {
    let pending = initialized.get(id);
    if (!pending) {
      pending = (async () => {
        const store = new MongoFinanceStore(db, id);
        const categoryStore = new MongoCategoryStore(db, id);
        await store.initialize();
        await categoryStore.initialize();
        return { store, categoryStore };
      })().catch(error => { initialized.delete(id); throw error; });
      initialized.set(id, pending);
    }
    return pending;
  };
  await storesForUser(owner.id);
  return { auth, storesForUser, owner: { id: owner.id, username: owner.username } };
}
