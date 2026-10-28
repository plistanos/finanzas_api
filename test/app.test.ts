import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { MongoNetworkError } from 'mongodb';
import { createApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import { emptyData, type FinanceData, type FinanceState } from '../src/schema.js';
import type { FinanceStore } from '../src/store.js';

class MemoryStore implements FinanceStore {
  data: FinanceState = { ...emptyData(), revision: 0 };
  async read() { return structuredClone(this.data); }
  async replace(revision: number, data: FinanceData) {
    if (this.data.revision !== revision) throw new ApiError(409, 'REVISION_CONFLICT', 'Conflicto');
    this.data = { ...structuredClone(data), revision: revision + 1 };
    return this.read();
  }
}
const transaction = { id: 'test-1', type: 'expense', description: 'Comida', category: 'comida', amount: 10000, date: '2026-10-28' };
const setup = (env: Record<string, string> = {}) => {
  const store = new MemoryStore();
  return { store, app: createApp({ config: parseConfig(env), store, ping: async () => {} }) };
};

test('configuración local por defecto y validación de producción', () => {
  const config = parseConfig({});
  assert.equal(config.NODE_ENV, 'development');
  assert.equal(config.MONGODB_URI, 'mongodb://localhost:27017/finanzas');
  assert.equal(config.HOST, '127.0.0.1');
  assert.throws(() => parseConfig({ NODE_ENV: 'test' }));
  assert.throws(() => parseConfig({ NODE_ENV: 'production' }));
  assert.throws(() => parseConfig({ HOST: '0.0.0.0' }));
  const production = parseConfig({ NODE_ENV: 'production', APP_PASSWORD: 'my-test-password', SESSION_SECRET: 's'.repeat(48), MONGODB_URI: 'mongodb://localhost:27017/other_db' });
  assert.equal(production.MONGODB_URI, 'mongodb://localhost:27017/other_db');
});

test('CRUD persiste movimientos y actualiza la revisión', async () => {
  const { app } = setup();
  await request(app).get('/api/health').expect(200).expect(({ body }) => assert.equal(body.database, 'connected'));
  await request(app).get('/api/data').expect(200).expect('ETag', '"0"');
  const created = await request(app).post('/api/transactions').set('If-Match', '"0"').send(transaction).expect(201);
  assert.equal(created.body.revision, 1);
  const changed = await request(app).put('/api/transactions/test-1').set('If-Match', '"1"').send({ ...transaction, amount: 12000 }).expect(200);
  assert.equal(changed.body.transactions[0].amount, 12000);
  await request(app).get('/api/transactions?month=2026-10').expect(200).expect(({ body }) => assert.equal(body.transactions.length, 1));
  await request(app).get('/api/transactions?month=2026-11').expect(200).expect(({ body }) => assert.equal(body.transactions.length, 0));
  const removed = await request(app).delete('/api/transactions/test-1').set('If-Match', '"2"').expect(200);
  assert.equal(removed.body.transactions.length, 0);
  assert.equal(removed.body.revision, 3);
});

test('valida montos, fechas, categorías, identificadores y precondiciones', async () => {
  const { app } = setup();
  for (const patch of [{ amount: -1 }, { amount: '5' }, { amount: 1.5 }, { date: '2026-02-30' }, { category: 'ingreso' }, { category: 'otro' }, { description: ' ' }, { id: 'id/invalid' }]) {
    await request(app).post('/api/transactions').set('If-Match', '"0"').send({ ...transaction, ...patch }).expect(400);
  }
  await request(app).post('/api/transactions').send(transaction).expect(428);
  await request(app).get('/api/transactions?month=2026-13').expect(400);
  await request(app).put('/api/transactions/other').set('If-Match', '"0"').send(transaction).expect(400);
  await request(app).delete('/api/transactions/missing').set('If-Match', '"0"').expect(404);
  await request(app).post('/api/transactions').set('Content-Type', 'application/json').send('{invalid').expect(400);
  await request(app).get('/not-found').expect(404);
});

test('importa y vacía de manera atómica; rechaza respaldos duplicados', async () => {
  const { app, store } = setup();
  await request(app).put('/api/data').set('If-Match', '"0"').send({ version: 1, demo: false, transactions: [transaction, { ...transaction, id: 'test-2' }] }).expect(200);
  await request(app).put('/api/data').set('If-Match', '"1"').send({ version: 1, demo: false, transactions: [transaction, transaction] }).expect(400);
  assert.equal(store.data.transactions.length, 2);
  await request(app).delete('/api/data').set('If-Match', '"1"').expect(200);
  assert.equal(store.data.transactions.length, 0);
  assert.equal(store.data.revision, 2);
});

test('los cambios concurrentes no sobrescriben datos', async () => {
  const { app, store } = setup();
  const responses = await Promise.all([
    request(app).post('/api/transactions').set('If-Match', '"0"').send(transaction),
    request(app).post('/api/transactions').set('If-Match', '"0"').send({ ...transaction, id: 'test-2' }),
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal(store.data.transactions.length, 1);
  await request(app).delete('/api/data').set('If-Match', '"0"').expect(409);
});

test('inicio de sesión, cookie HttpOnly, cierre de sesión y control de origen', async () => {
  const { app } = setup({ APP_PASSWORD: 'only-for-this-test', SESSION_SECRET: 's'.repeat(48) });
  const agent = request.agent(app);
  await agent.get('/api/data').expect(401);
  await agent.get('/api/auth/session').expect(200).expect(({ body }) => assert.equal(body.authenticated, false));
  await agent.post('/api/auth/login').send({ password: 'wrong' }).expect(401);
  const logged = await agent.post('/api/auth/login').send({ password: 'only-for-this-test' }).expect(200);
  assert.match(String(logged.headers['set-cookie']), /HttpOnly/);
  assert.match(String(logged.headers['set-cookie']), /SameSite=Lax/);
  await agent.get('/api/data').expect(200);
  await agent.delete('/api/data').set('Origin', 'https://untrusted.example').set('If-Match', '"0"').expect(403);
  await agent.post('/api/auth/logout').expect(204);
  await agent.get('/api/data').expect(401);
  await agent.post('/api/auth/login').set('Origin', 'null').send({ password: 'only-for-this-test' }).expect(403);
});

test('responde 503 sin revelar la cadena de MongoDB cuando falla la conexión', async () => {
  const app = createApp({ config: parseConfig({}), store: new MemoryStore(), ping: async () => { throw new MongoNetworkError('mongodb://private-password@localhost/finanzas'); } });
  const response = await request(app).get('/api/health').expect(503);
  assert.equal(response.body.error.code, 'DATABASE_UNAVAILABLE');
  assert.ok(!response.text.includes('private-password'));
});
