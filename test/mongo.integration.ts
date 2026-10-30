import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MongoFinanceStore } from '../src/store.js';
import { parseConfig } from '../src/config.js';
import { MongoCategoryStore } from '../src/categories.js';
import { bootstrapAccounts } from '../src/accounts.js';
import { secret } from './auth-fixture.js';

test('API y persistencia reales en una base MongoDB aislada', { skip: !process.env.MONGODB_TEST_URI }, async () => {
  const client = new MongoClient(process.env.MONGODB_TEST_URI!, { serverSelectionTimeoutMS: 5000 });
  const db = client.db(`test_${randomUUID().replaceAll('-', '')}`);
  try {
    await client.connect();
    const store = new MongoFinanceStore(db);
    await store.initialize();
    const categoryStore = new MongoCategoryStore(db);
    await categoryStore.initialize();
    const category = { id: 'salud', name: 'Salud', color: '#123abc', type: 'expense' as const };
    await categoryStore.create(category);
    await categoryStore.update({ ...category, name: 'Bienestar' }, 0);
    await categoryStore.update({ id: 'comida', name: 'Alimentación', color: '#abcdef', type: 'expense' }, 0);
    const restoredCategories = new MongoCategoryStore(db);
    await restoredCategories.initialize();
    assert.equal((await restoredCategories.read()).find(c => c.id === 'salud')?.name, 'Bienestar');
    assert.equal((await restoredCategories.read()).find(c => c.id === 'comida')?.name, 'Alimentación');
    await assert.rejects(categoryStore.update(category, 0));
    // Simula el catálogo anterior a las cuentas y verifica su migración.
    await db.collection('categories').updateMany({}, { $unset: { userId: '' } });
    const config = parseConfig({ JWT_SECRET: secret, INITIAL_USERNAME: 'michael', INITIAL_PASSWORD: 'galaonli' });
    const accounts = await bootstrapAccounts(db, config);
    const app = createApp({ ...accounts, config, ping: async () => { await db.command({ ping: 1 }); } });
    const agent = request.agent(app);
    await request(app).get('/api/data').expect(401);
    const login = await agent.post('/api/auth/login').send({ username: 'michael', password: 'galaonli' }).expect(200);
    const savedCookie = String(login.headers['set-cookie']).split(';')[0];
    await agent.get('/api/categories').expect(200).expect(({ body }) => assert.equal(body.find((c: { id: string }) => c.id === 'comida').name, 'Alimentación'));
    const transaction = { id: randomUUID(), type: 'income', description: 'Prueba aislada', amount: 1500000, category: 'ingreso', date: '2026-10-28' };
    await agent.post('/api/transactions').set('If-Match', '"0"').send(transaction).expect(201);
    const anotherStore = new MongoFinanceStore(db);
    const loaded = await anotherStore.read();
    assert.equal(loaded.transactions[0].amount, 1500000);
    assert.equal(loaded.revision, 1);
    const conflict = await Promise.allSettled([
      store.replace(1, { version: 1, demo: false, transactions: [] }),
      anotherStore.replace(1, { version: 1, demo: false, transactions: [] }),
    ]);
    assert.equal(conflict.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(conflict.filter(result => result.status === 'rejected').length, 1);
    await agent.get('/api/data').expect(200).expect(({ body }) => assert.equal(body.revision, 2));
    // Reiniciar servicios conserva la cuenta, los datos, la sesión y las ediciones.
    const restarted = await bootstrapAccounts(db, { ...config, INITIAL_PASSWORD: 'otra-password-ignorada' });
    const afterRestart = createApp({ ...restarted, config, ping: async () => {} });
    await request(afterRestart).get('/api/data').set('Cookie', savedCookie).expect(200);
    await request(afterRestart).post('/api/auth/login').send({ username: 'michael', password: 'galaonli' }).expect(200);
    const other = request.agent(afterRestart);
    await other.post('/api/auth/register').send({ username: 'segunda', password: 'clave-segunda' }).expect(201);
    await other.get('/api/data').expect(200).expect(({ body }) => { assert.equal(body.transactions.length, 0); assert.equal(body.categories.find((c: { id: string }) => c.id === 'comida').name, 'Comida'); });
    await other.post('/api/transactions').set('If-Match', '"0"').send({ ...transaction, id: 'solo-segunda' }).expect(201);
    const first = await request(afterRestart).get('/api/data').set('Cookie', savedCookie).expect(200);
    assert.equal(first.body.transactions.length, 0);
    await request(afterRestart).post('/api/auth/logout').set('Cookie', savedCookie).expect(204);
    await request(afterRestart).get('/api/data').set('Cookie', savedCookie).expect(401);
    const user = await restarted.auth.repository.byName('michael');
    assert.ok(user?.passwordHash && !user.passwordHash.includes('galaonli'));
  } finally {
    // Solo esta base temporal generada por la prueba; nunca finanzas.
    try { await db.dropDatabase(); }
    finally { await client.close(); }
  }
});
