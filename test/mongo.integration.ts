import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MongoFinanceStore } from '../src/store.js';
import { parseConfig } from '../src/config.js';

test('API y persistencia reales en una base MongoDB aislada', { skip: !process.env.MONGODB_TEST_URI }, async () => {
  const client = new MongoClient(process.env.MONGODB_TEST_URI!, { serverSelectionTimeoutMS: 5000 });
  const db = client.db(`savia_test_${randomUUID().replaceAll('-', '')}`);
  try {
    await client.connect();
    const store = new MongoFinanceStore(db);
    await store.initialize();
    const app = createApp({ config: parseConfig({}), store, ping: async () => { await db.command({ ping: 1 }); } });
    const transaction = { id: randomUUID(), type: 'income', description: 'Prueba aislada', amount: 1500000, category: 'ingreso', date: '2026-10-28' };
    await request(app).post('/api/transactions').set('If-Match', '"0"').send(transaction).expect(201);
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
    await request(app).get('/api/data').expect(200).expect(({ body }) => assert.equal(body.revision, 2));
  } finally {
    // Solo esta base temporal generada por la prueba; nunca finanzas.
    await db.dropDatabase();
    await client.close();
  }
});
