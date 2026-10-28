import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import { rateLimit } from 'express-rate-limit';
import { MongoNetworkError, MongoServerSelectionError } from 'mongodb';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { dataSchema, emptyData, transactionSchema, type FinanceState } from './schema.js';
import type { FinanceStore } from './store.js';

declare module 'express-session' { interface SessionData { authenticated?: boolean } }
type Options = { config: Config; store: FinanceStore; ping: () => Promise<void>; sessionStore?: session.Store };

export function createApp({ config, store, ping, sessionStore }: Options) {
  const app = express();
  app.disable('x-powered-by');
  if (config.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use(helmet());
  app.use((req, _res, next) => {
    const origin = req.get('Origin');
    if (origin && origin !== config.FRONTEND_URL) return next(new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origen no autorizado.'));
    next();
  });
  app.use(cors({ origin: config.FRONTEND_URL, credentials: true, allowedHeaders: ['Content-Type', 'If-Match'], exposedHeaders: ['ETag'] }));
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const authRequired = Boolean(config.APP_PASSWORD);
  if (authRequired) {
    app.use(session({
      name: 'savia.sid', secret: config.SESSION_SECRET, store: sessionStore,
      resave: false, saveUninitialized: false,
      cookie: { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
    }));
  }

  app.get('/api/health', async (_req, res) => { await ping(); res.json({ status: 'ok', environment: config.NODE_ENV, database: 'connected', authRequired }); });
  app.get('/api/auth/session', (req, res) => { res.json({ authenticated: !authRequired || Boolean(req.session?.authenticated), authRequired }); });

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Demasiados intentos. Vuelve a intentarlo en 15 minutos.' } } });
  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    if (!authRequired) { res.json({ authenticated: true }); return; }
    const password: unknown = req.body?.password;
    if (typeof password !== 'string' || password.length > 1024 || !timingSafeEqual(createHash('sha256').update(password).digest(), createHash('sha256').update(config.APP_PASSWORD).digest())) throw new ApiError(401, 'INVALID_PASSWORD', 'La contraseña no es correcta.');
    await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.authenticated = true;
    await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    res.json({ authenticated: true });
  });
  app.post('/api/auth/logout', async (req, res) => {
    if (req.session) await new Promise<void>((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
    res.clearCookie('savia.sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production' });
    res.status(204).end();
  });

  app.use('/api', (req, _res, next) => {
    if (authRequired && !req.session?.authenticated) return next(new ApiError(401, 'AUTH_REQUIRED', 'Inicia sesión para acceder a tus finanzas.'));
    next();
  });

  const sendState = (res: Response, state: FinanceState, status = 200) => res.status(status).set('ETag', `"${state.revision}"`).json(state);
  const readCurrent = async (req: Request) => {
    const match = req.get('If-Match');
    if (!match || !/^"\d+"$/.test(match) || !Number.isSafeInteger(Number(match.slice(1, -1)))) throw new ApiError(428, 'REVISION_REQUIRED', 'Envía la revisión actual en If-Match (ejemplo: "0").');
    const current = await store.read();
    if (`"${current.revision}"` !== match) throw new ApiError(409, 'REVISION_CONFLICT', 'Los datos cambiaron en otra ventana. Actualiza antes de volver a guardar.');
    return current;
  };
  app.get('/api/data', async (_req, res) => { sendState(res, await store.read()); });
  app.put('/api/data', async (req, res) => {
    const data = dataSchema.parse(req.body);
    const current = await readCurrent(req);
    sendState(res, await store.replace(current.revision, data));
  });
  app.delete('/api/data', async (req, res) => {
    const current = await readCurrent(req);
    sendState(res, await store.replace(current.revision, emptyData()));
  });
  app.get('/api/transactions', async (req, res) => {
    const current = await store.read();
    const month = req.query.month;
    if (month !== undefined && (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) throw new ApiError(400, 'INVALID_MONTH', 'El mes debe tener formato YYYY-MM.');
    res.set('ETag', `"${current.revision}"`).json({ transactions: current.transactions.filter(t => !month || t.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date)), revision: current.revision });
  });
  app.post('/api/transactions', async (req, res) => {
    const transaction = transactionSchema.parse(req.body);
    const current = await readCurrent(req);
    if (current.transactions.some(t => t.id === transaction.id)) throw new ApiError(409, 'DUPLICATE_ID', 'Este movimiento ya existe.');
    sendState(res, await store.replace(current.revision, { version: 1, demo: current.demo, transactions: [...current.transactions, transaction] }), 201);
  });
  app.put('/api/transactions/:id', async (req, res) => {
    const transaction = transactionSchema.parse(req.body);
    if (transaction.id !== req.params.id) throw new ApiError(400, 'ID_MISMATCH', 'El identificador no coincide con el movimiento.');
    const current = await readCurrent(req);
    if (!current.transactions.some(t => t.id === transaction.id)) throw new ApiError(404, 'NOT_FOUND', 'El movimiento ya no existe.');
    sendState(res, await store.replace(current.revision, { version: 1, demo: current.demo, transactions: current.transactions.map(t => t.id === transaction.id ? transaction : t) }));
  });
  app.delete('/api/transactions/:id', async (req, res) => {
    const current = await readCurrent(req);
    if (!current.transactions.some(t => t.id === req.params.id)) throw new ApiError(404, 'NOT_FOUND', 'El movimiento ya no existe.');
    sendState(res, await store.replace(current.revision, { version: 1, demo: current.demo, transactions: current.transactions.filter(t => t.id !== req.params.id) }));
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
