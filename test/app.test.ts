import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoNetworkError } from 'mongodb';
import { createApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import { emptyData, type FinanceData, type FinanceState } from '../src/schema.js';
import type { FinanceStore } from '../src/store.js';
import { MemoryCategoryStore } from '../src/categories.js';
import { testAuth, secret } from './auth-fixture.js';

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
const setup = async (ping = async () => {}, publicDir?: string) => {
  const store = new MemoryStore();
  const stores = new Map([['personal', { store, categoryStore: new MemoryCategoryStore() }]]);
  const auth = await testAuth();
  const app = createApp({ config: parseConfig({ JWT_SECRET: secret }), auth, storesForUser: async id => {
    if (!stores.has(id)) stores.set(id, { store: new MemoryStore(), categoryStore: new MemoryCategoryStore() });
    return stores.get(id)!;
  }, ping, publicDir });
  const client = request.agent(app);
  await client.post('/api/auth/login').send({ username: 'michael', password: 'galaonli' }).expect(200);
  return { store, app, client, auth };
};

test('configuración exige un secreto JWT persistente y admite producción', () => {
  assert.throws(() => parseConfig({}));
  assert.throws(() => parseConfig({ JWT_SECRET: 'short' }));
  const config = parseConfig({ JWT_SECRET: secret });
  assert.equal(config.NODE_ENV, 'development');
  assert.equal(config.MONGODB_URI, 'mongodb://localhost:27017/finanzas');
  assert.throws(() => parseConfig({ NODE_ENV: 'test', JWT_SECRET: secret }));
  assert.throws(() => parseConfig({ NODE_ENV: 'production', JWT_SECRET: secret }));
  assert.throws(() => parseConfig({ VERCEL: '1', JWT_SECRET: secret }));
  assert.equal(parseConfig({ NODE_ENV: 'production', JWT_SECRET: secret, MONGODB_URI: 'mongodb+srv://example.mongodb.net/finanzas' }).NODE_ENV, 'production');
});

test('CRUD persiste movimientos y actualiza la revisión', async () => {
  const { app, client } = await setup();
  await client.get('/api/health').expect(200).expect(({ body }) => assert.equal(body.database, 'connected'));
  await client.get('/api/data').expect(200).expect('ETag', '"0"');
  const created = await client.post('/api/transactions').set('If-Match', '"0"').send(transaction).expect(201);
  assert.equal(created.body.revision, 1);
  const changed = await client.put('/api/transactions/test-1').set('If-Match', '"1"').send({ ...transaction, amount: 12000 }).expect(200);
  assert.equal(changed.body.transactions[0].amount, 12000);
  await client.get('/api/transactions?month=2026-10').expect(200).expect(({ body }) => assert.equal(body.transactions.length, 1));
  await client.get('/api/transactions?month=2026-11').expect(200).expect(({ body }) => assert.equal(body.transactions.length, 0));
  const removed = await client.delete('/api/transactions/test-1').set('If-Match', '"2"').expect(200);
  assert.equal(removed.body.transactions.length, 0);
  assert.equal(removed.body.revision, 3);
});

test('valida montos, fechas, categorías, identificadores y precondiciones', async () => {
  const { app, client } = await setup();
  for (const patch of [{ amount: -1 }, { amount: '5' }, { amount: 1.5 }, { date: '2026-02-30' }, { category: 'ingreso' }, { category: 'otro' }, { description: ' ' }, { id: 'id/invalid' }]) {
    await client.post('/api/transactions').set('If-Match', '"0"').send({ ...transaction, ...patch }).expect(400);
  }
  await client.post('/api/transactions').send(transaction).expect(428);
  await client.get('/api/transactions?month=2026-13').expect(400);
  await client.put('/api/transactions/other').set('If-Match', '"0"').send(transaction).expect(400);
  await client.delete('/api/transactions/missing').set('If-Match', '"0"').expect(404);
  await client.post('/api/transactions').set('Content-Type', 'application/json').send('{invalid').expect(400);
  await client.get('/not-found').expect(404);
});

test('importa y vacía de manera atómica; rechaza respaldos duplicados', async () => {
  const { app, store, client } = await setup();
  await client.put('/api/data').set('If-Match', '"0"').send({ version: 1, demo: false, transactions: [transaction, { ...transaction, id: 'test-2' }] }).expect(200);
  await client.put('/api/data').set('If-Match', '"1"').send({ version: 1, demo: false, transactions: [transaction, transaction] }).expect(400);
  assert.equal(store.data.transactions.length, 2);
  await client.delete('/api/data').set('If-Match', '"1"').expect(200);
  assert.equal(store.data.transactions.length, 0);
  assert.equal(store.data.revision, 2);
});

test('los cambios concurrentes no sobrescriben datos', async () => {
  const { app, store, client } = await setup();
  const responses = await Promise.all([
    client.post('/api/transactions').set('If-Match', '"0"').send(transaction),
    client.post('/api/transactions').set('If-Match', '"0"').send({ ...transaction, id: 'test-2' }),
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal(store.data.transactions.length, 1);
  await client.delete('/api/data').set('If-Match', '"0"').expect(409);
});

test('JWT persistente, cookie HttpOnly, rechazo de manipulación, logout revoca y origen', async () => {
  const { app } = await setup();
  const agent = request.agent(app);
  await agent.get('/api/data').expect(401);
  await agent.get('/api/auth/session').expect(200).expect(({ body }) => assert.equal(body.authenticated, false));
  await agent.post('/api/auth/login').send({ username: 'michael', password: 'incorrecta' }).expect(401);
  const logged = await agent.post('/api/auth/login').send({ username: 'michael', password: 'galaonli' }).expect(200);
  const cookie = String(logged.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=2592000/);
  assert.equal(logged.body.user.username, 'michael');
  assert.ok(!JSON.stringify(logged.body).includes('password'));
  const savedCookie = cookie.split(';')[0];
  await request(app).get('/api/data').set('Cookie', savedCookie).expect(200);
  await request(app).get('/api/data').set('Cookie', savedCookie + 'tampered').expect(401);
  await agent.delete('/api/data').set('Origin', 'https://untrusted.example').set('If-Match', '"0"').expect(403);
  await agent.post('/api/auth/logout').expect(204);
  await request(app).get('/api/data').set('Cookie', savedCookie).expect(401);
});

test('responde 503 sin revelar la cadena de MongoDB cuando falla la conexión', async () => {
  const { client } = await setup(async () => { throw new MongoNetworkError('mongodb://private-password@localhost/finanzas'); });
  const response = await client.get('/api/health').expect(503);
  assert.equal(response.body.error.code, 'DATABASE_UNAVAILABLE');
  assert.ok(!response.text.includes('private-password'));
});

test('categorías editables conservan referencias y rechazan conflictos y colores inválidos', async () => {
  const { app, client } = await setup();
  const category = { id: 'salud', name: 'Salud', color: '#123abc', type: 'expense' };
  await client.post('/api/categories').send(category).expect(201);
  const transaction = { id: 'salud-1', type: 'expense', category: 'salud', description: 'Consulta', amount: 1000, date: '2026-10-30' };
  await client.post('/api/transactions').set('If-Match', '"0"').send(transaction).expect(201);
  await client.put('/api/categories/salud').set('If-Match', '"0"').send({ ...category, name: 'Bienestar', color: '#abcdef' }).expect(200);
  await client.put('/api/categories/salud').set('If-Match', '"0"').send(category).expect(409);
  await client.get('/api/data').expect(200).expect(({ body }) => {
    assert.equal(body.transactions[0].category, 'salud');
    assert.equal(body.categories.find((c: { id: string }) => c.id === 'salud').name, 'Bienestar');
  });
  await client.post('/api/categories').send({ ...category, color: 'red' }).expect(400);
  await client.post('/api/transactions').set('If-Match', '"1"').send({ ...transaction, id: 'bad', category: 'inexistente' }).expect(400);
  await client.put('/api/categories/ingreso').set('If-Match', '"0"').send({ id: 'ingreso', name: 'Entradas', color: '#111111', type: 'income' }).expect(200);
  await client.put('/api/categories/ingreso').set('If-Match', '"1"').send({ id: 'ingreso', name: 'Entradas', color: '#111111', type: 'expense' }).expect(400);
});

test('importa categorías nuevas del respaldo y valida referencias antes de guardar', async () => {
  const { app, client } = await setup();
  const transaction = { id: 'test-custom', type: 'expense', category: 'salud', description: 'Consulta', amount: 1000, date: '2026-10-30' };
  const data = { version: 1, demo: false, transactions: [transaction] };
  await client.put('/api/data').set('If-Match', '"0"').send(data).expect(400);
  await client.put('/api/data').set('If-Match', '"0"').send({ ...data, categories: [{ id: 'salud', name: 'Salud', color: '#123abc', type: 'expense' }] }).expect(200);
  await client.delete('/api/data').set('If-Match', '"1"').expect(200).expect(({ body }) => {
    assert.equal(body.transactions.length, 0);
    assert.ok(body.categories.some((c: { id: string }) => c.id === 'salud'));
  });
});

test('cuentas aíslan movimientos, categorías y borrados', async () => {
  const { app, client } = await setup();
  await client.post('/api/transactions').set('If-Match', '"0"').send(transaction).expect(201);
  await client.put('/api/categories/comida').set('If-Match', '"0"').send({ id: 'comida', name: 'Mi comida', color: '#123456', type: 'expense' }).expect(200);
  const other = request.agent(app);
  await other.post('/api/auth/register').send({ username: 'segunda', password: 'otra-clave-segura' }).expect(201);
  await other.get('/api/data').expect(200).expect(({ body }) => { assert.equal(body.transactions.length, 0); assert.equal(body.categories.find((c: { id: string }) => c.id === 'comida').name, 'Comida'); });
  await other.put('/api/transactions/test-1').set('If-Match', '"0"').send(transaction).expect(404);
  await other.delete('/api/transactions/test-1').set('If-Match', '"0"').expect(404);
  await other.delete('/api/data').set('If-Match', '"0"').expect(200);
  await client.get('/api/data').expect(200).expect(({ body }) => assert.equal(body.transactions.length, 1));
});

test('JWT vencido se rechaza y sesión activa antigua se renueva', async () => {
  const { SignJWT } = await import('jose');
  const { app, auth } = await setup();
  const now = Math.floor(Date.now() / 1000);
  const sid = 'session-renewal-test';
  await auth.repository.putSession({ id: sid, userId: 'personal', expiresAt: new Date(Date.now() + 86400000) });
  const token = await new SignJWT({ sid }).setProtectedHeader({ alg: 'HS256' }).setIssuer('savia-api').setAudience('savia-web').setSubject('personal').setIssuedAt(now - 2 * 86400).setExpirationTime(now + 86400).sign(new TextEncoder().encode(secret));
  const renewed = await request(app).get('/api/auth/session').set('Cookie', 'savia.auth=' + token).expect(200);
  assert.equal(renewed.body.authenticated, true);
  assert.match(String(renewed.headers['set-cookie']), /Max-Age=2592000/);
  const expired = await new SignJWT({ sid }).setProtectedHeader({ alg: 'HS256' }).setIssuer('savia-api').setAudience('savia-web').setSubject('personal').setIssuedAt(now - 86400).setExpirationTime(now - 60).sign(new TextEncoder().encode(secret));
  await request(app).get('/api/data').set('Cookie', 'savia.auth=' + expired).expect(401);
  const session = await auth.repository.getSession(sid);
  session!.expiresAt = new Date(Date.now() - 1000);
  await request(app).get('/api/data').set('Cookie', 'savia.auth=' + token).expect(401);
});

test('sirve public y rutas SPA; conserva JSON en API y rechaza assets inexistentes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'finanzas-public-'));
  try {
    await mkdir(join(folder, 'assets'));
    await writeFile(join(folder, 'index.html'), '<!doctype html><html><body>Savia build</body></html>');
    await writeFile(join(folder, 'assets', 'app.js'), 'console.log("Savia");');
    const { app, client } = await setup(undefined, folder);
    await request(app).get('/').expect(200).expect('Content-Type', /html/).expect('X-Content-Type-Options', 'nosniff').expect('Content-Security-Policy', /default-src 'self'/).expect(/Savia build/);
    await request(app).get('/categorias').set('Accept', 'text/html').expect(200).expect(/Savia build/);
    await request(app).get('/assets/app.js').expect(200).expect('Content-Type', /javascript/);
    await request(app).get('/assets/no-existe.js').set('Accept', 'text/html').expect(404);
    await request(app).get('/api/no-existe').set('Accept', 'text/html').expect(401).expect('Content-Type', /json/);
    await client.get('/api/no-existe').set('Accept', 'text/html').expect(404).expect('Content-Type', /json/);
    await request(app).post('/api/auth/login').set('Host', 'finanzas.test').set('Origin', 'http://finanzas.test').send({ username: 'michael', password: 'galaonli' }).expect(200);
  } finally {
    await unlink(join(folder, 'assets', 'app.js'));
    await unlink(join(folder, 'index.html'));
    await rmdir(join(folder, 'assets'));
    await rmdir(folder);
  }
});
