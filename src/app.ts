import express, { type ErrorRequestHandler, type Request, type Response, type RequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import cors from 'cors';
import helmetDefault, { type HelmetOptions } from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { MongoNetworkError, MongoServerSelectionError } from 'mongodb';
import { ZodError } from 'zod';
import type { AuthService } from './auth.js';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { dataSchema, emptyData, transactionSchema, type FinanceState } from './schema.js';
import type { FinanceStore } from './store.js';
import { categorySchema, type CategoryStore } from './categories.js';

// La importación estática permite a Vercel incluir Helmet en la función.
// Normalizamos el tipo publicado por Helmet sin cambiar su export en ejecución.
const helmet = helmetDefault as unknown as (options?: Readonly<HelmetOptions>) => RequestHandler;

type Stores = { store: FinanceStore; categoryStore: CategoryStore };
type Options = { config: Config; auth: AuthService; storesForUser: (userId: string) => Promise<Stores>; ping: () => Promise<void>; publicDir?: string };

export function createApp({ config, auth, storesForUser, ping, publicDir = fileURLToPath(new URL('../public/', import.meta.url)) }: Options) {
  const app = express();
  app.disable('x-powered-by');
  if (config.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null } } }));
  app.use((req, _res, next) => {
    const origin = req.get('Origin');
    const ownOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== config.FRONTEND_URL && origin !== ownOrigin) return next(new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origen no autorizado.'));
    next();
  });
  app.use(cors({ origin: true, credentials: true, allowedHeaders: ['Content-Type', 'If-Match'], exposedHeaders: ['ETag'] }));
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get('/api/health', async (_req, res) => { await ping(); res.json({ status: 'ok', environment: config.NODE_ENV, database: 'connected', authRequired: true }); });
  app.use('/api', async (req, res, next) => { res.locals.identity = await auth.authenticate(req, res); next(); });
  app.get('/api/auth/session', (_req, res) => { res.json({ authenticated: Boolean(res.locals.identity), authRequired: true, user: res.locals.identity?.user ?? null }); });
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Demasiados intentos. Vuelve a intentarlo en 15 minutos.' } } });
  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const user = await auth.login(req.body);
    if (res.locals.identity) await auth.repository.deleteSession(res.locals.identity.sid);
    await auth.start(res, user);
    res.json({ authenticated: true, user });
  });
  app.post('/api/auth/register', loginLimiter, async (req, res) => {
    const user = await auth.register(req.body);
    await storesForUser(user.id);
    await auth.start(res, user);
    res.status(201).json({ authenticated: true, user });
  });
  app.post('/api/auth/logout', async (_req, res) => {
    if (res.locals.identity) await auth.repository.deleteSession(res.locals.identity.sid);
    auth.clear(res);
    res.status(204).end();
  });
  app.use('/api', async (_req, res, next) => {
    if (!res.locals.identity) throw new ApiError(401, 'AUTH_REQUIRED', 'Inicia sesión para acceder a tus finanzas.');
    Object.assign(res.locals, await storesForUser(res.locals.identity.user.id));
    next();
  });
  const financeStore = (res: Response) => res.locals.store as FinanceStore;
  const categories = (res: Response) => res.locals.categoryStore as CategoryStore;

  const sendState = async (res: Response, state: FinanceState, status = 200) => res.status(status).set('ETag', `"${state.revision}"`).json({ ...state, categories: await categories(res).read() });
  const readCurrent = async (req: Request, res: Response) => {
    const match = req.get('If-Match');
    if (!match || !/^"\d+"$/.test(match) || !Number.isSafeInteger(Number(match.slice(1, -1)))) throw new ApiError(428, 'REVISION_REQUIRED', 'Envía la revisión actual en If-Match (ejemplo: "0").');
    const current = await financeStore(res).read();
    if (`"${current.revision}"` !== match) throw new ApiError(409, 'REVISION_CONFLICT', 'Los datos cambiaron en otra ventana. Actualiza antes de volver a guardar.');
    return current;
  };
  app.get('/api/categories', async (_req, res) => { res.json(await categories(res).read()); });
  app.post('/api/categories', async (req, res) => {
    const category = categorySchema.parse(req.body);
    await categories(res).create(category);
    res.status(201).json(await categories(res).read());
  });
  app.put('/api/categories/:id', async (req, res) => {
    const category = categorySchema.parse(req.body);
    if (category.id !== req.params.id) throw new ApiError(400, 'ID_MISMATCH', 'El identificador no coincide.');
    const match = req.get('If-Match');
    if (!match || !/^"\d+"$/.test(match) || !Number.isSafeInteger(Number(match.slice(1, -1)))) throw new ApiError(428, 'REVISION_REQUIRED', 'Envía la revisión actual.');
    await categories(res).update(category, Number(match.slice(1, -1)));
    res.json(await categories(res).read());
  });
  const validateCategories = async (res: Response, transactions: FinanceState['transactions'], extra: unknown[] = []) => {
    const catalog = [...await categories(res).read(), ...extra.map(c => categorySchema.parse(c))];
    if (transactions.some(t => !catalog.some(c => c.id === t.category && c.type === t.type))) throw new ApiError(400, 'INVALID_CATEGORY', 'Selecciona una categoría existente para el tipo de movimiento.');
  };
  app.get('/api/data', async (_req, res) => { await sendState(res, await financeStore(res).read()); });
  app.put('/api/data', async (req, res) => {
    const data = dataSchema.parse(req.body);
    const current = await readCurrent(req, res);
    await validateCategories(res, data.transactions, data.categories);
    const catalog = await categories(res).read();
    for (const category of data.categories ?? []) {
      if (!catalog.some(c => c.id === category.id)) await categories(res).create(category);
    }
    const { categories: _categories, ...movements } = data;
    await sendState(res, await financeStore(res).replace(current.revision, movements));
  });
  app.delete('/api/data', async (req, res) => {
    const current = await readCurrent(req, res);
    await sendState(res, await financeStore(res).replace(current.revision, emptyData()));
  });
  app.get('/api/transactions', async (req, res) => {
    const current = await financeStore(res).read();
    const month = req.query.month;
    if (month !== undefined && (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) throw new ApiError(400, 'INVALID_MONTH', 'El mes debe tener formato YYYY-MM.');
    res.set('ETag', `"${current.revision}"`).json({ transactions: current.transactions.filter(t => !month || t.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date)), revision: current.revision });
  });
  app.post('/api/transactions', async (req, res) => {
    const transaction = transactionSchema.parse(req.body);
    await validateCategories(res, [transaction]);
    const current = await readCurrent(req, res);
    if (current.transactions.some(t => t.id === transaction.id)) throw new ApiError(409, 'DUPLICATE_ID', 'Este movimiento ya existe.');
    await sendState(res, await financeStore(res).replace(current.revision, { version: 1, demo: current.demo, transactions: [...current.transactions, transaction] }), 201);
  });
  app.put('/api/transactions/:id', async (req, res) => {
    const transaction = transactionSchema.parse(req.body);
    await validateCategories(res, [transaction]);
    if (transaction.id !== req.params.id) throw new ApiError(400, 'ID_MISMATCH', 'El identificador no coincide con el movimiento.');
    const current = await readCurrent(req, res);
    if (!current.transactions.some(t => t.id === transaction.id)) throw new ApiError(404, 'NOT_FOUND', 'El movimiento ya no existe.');
    await sendState(res, await financeStore(res).replace(current.revision, { version: 1, demo: current.demo, transactions: current.transactions.map(t => t.id === transaction.id ? transaction : t) }));
  });
  app.delete('/api/transactions/:id', async (req, res) => {
    const current = await readCurrent(req, res);
    if (!current.transactions.some(t => t.id === req.params.id)) throw new ApiError(404, 'NOT_FOUND', 'El movimiento ya no existe.');
    await sendState(res, await financeStore(res).replace(current.revision, { version: 1, demo: current.demo, transactions: current.transactions.filter(t => t.id !== req.params.id) }));
  });
  // Las rutas API conservan respuestas JSON; nunca deben devolver el HTML del frontend.
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'ROUTE_NOT_FOUND', 'La ruta solicitada no existe.')));
  app.use(express.static(publicDir));
  // Permite recargar una ruta de la SPA sin interceptar assets inexistentes.
  app.get(/.*/, (req, res, next) => {
    if (!req.get('Accept')?.includes('text/html') || extname(req.path)) return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(join(publicDir, 'index.html'), error => {
      if (error && 'status' in error && error.status === 404) return next();
      if (error) next(error);
    });
  });
  app.use((_req, _res, next) => next(new ApiError(404, 'ROUTE_NOT_FOUND', 'La ruta solicitada no existe.')));
  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof ApiError) { res.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof ZodError) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Revisa los datos enviados.', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) } }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: { code: 'INVALID_JSON', message: 'El cuerpo no contiene JSON válido.' } }); return; }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') { res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'El archivo supera el límite de 10 MB.' } }); return; }
    const unavailable = error instanceof MongoNetworkError || error instanceof MongoServerSelectionError;
    // No exponer errores del driver ni credenciales de conexión en la respuesta.
    res.status(unavailable ? 503 : 500).json({ error: { code: unavailable ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', message: unavailable ? 'MongoDB no está disponible. Vuelve a intentarlo.' : 'No se pudo completar la operación.' } });
    console.error('Error de API:', error instanceof Error ? error.name : 'UnknownError');
  };
  app.use(handleError);
  return app;
}
