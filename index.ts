import express from 'express';
import { getApplication } from './src/runtime.js';

const app = express();
app.disable('x-powered-by');
app.use(async (req, res, next) => {
  try {
    const application = await getApplication();
    application(req, res, next);
  } catch (error) {
    console.error('No se pudo iniciar la API:', error instanceof Error ? error.name : 'UnknownError');
    res.set('Cache-Control', 'no-store').status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'No se pudo iniciar la API. Revisa su configuración y conexión a MongoDB.' } });
  }
});

export default app;
