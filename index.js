import express from 'express';

const app = express();
app.disable('x-powered-by');

// Vercel ejecuta JavaScript compilado: no depende de resolver .js a fuentes .ts.
// La importación queda dentro del manejador para poder diagnosticar fallos de carga.
let runtime;
app.use(async (req, res, next) => {
  try {
    runtime ??= import('./dist/runtime.js').catch(error => {
      runtime = undefined;
      throw error;
    });
    const { getApplication } = await runtime;
    const application = await getApplication();
    application(req, res, next);
  } catch (error) {
    const code = typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : undefined;
    console.error('API_STARTUP_FAILED', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code,
      // Los nombres de campos ayudan a detectar variables faltantes sin revelar valores.
      fields: Array.isArray(error?.issues) ? error.issues.map(issue => issue.path?.join('.')) : undefined,
      module: code === 'ERR_MODULE_NOT_FOUND' ? error.message : undefined,
    });
    res.set('Cache-Control', 'no-store').status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'No se pudo iniciar la API. Revisa sus logs, configuración y conexión a MongoDB.' } });
  }
});

export default app;
