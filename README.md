# Finanzas API

API personal con Node.js, Express, TypeScript y MongoDB. Conexión por defecto: `mongodb://localhost:27017/finanzas`.

## Desarrollo local

Requisitos: Node.js 20.19 o superior y MongoDB en ejecución.

```sh
cd finanzas_api
npm install
# Solo si aún no existe .env:
cp .env.example .env
npm run dev
```

La API escucha en `http://127.0.0.1:3001/api`. `GET /api/health` comprueba la conexión con MongoDB. Si la base no está disponible al iniciar, el proceso termina con un error; no simula persistencia en memoria.

En otra terminal:

```sh
cd finanzas
npm install
npm run dev
```

Abre `http://localhost:5173`. Vite reenvía `/api` hacia `http://127.0.0.1:3001`.

## Variables de entorno

El `.env` de **finanzas_api** se lee tanto en desarrollo como al ejecutar la versión compilada. Las variables ya definidas en el sistema tienen prioridad.

```dotenv
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/finanzas
PORT=3001
HOST=127.0.0.1
FRONTEND_URL=http://localhost:5173
APP_PASSWORD=
SESSION_SECRET=
```

- `NODE_ENV`: `development` o `production`. No cambia la base automáticamente; siempre se usa `MONGODB_URI`.
- `MONGODB_URI`: URI con nombre de base. Puedes sustituirla por una URI de Atlas `mongodb+srv://.../finanzas`.
- `HOST` / `PORT`: dirección de escucha. Sin contraseña solo se permite una dirección local. Para exponer la API configura contraseña y, si corresponde, `HOST=0.0.0.0`.
- `FRONTEND_URL`: origen exacto del frontend (protocolo, dominio y puerto), sin rutas.
- `APP_PASSWORD`: contraseña única de acceso personal; opcional en desarrollo local y obligatoria en producción (mínimo 12 caracteres).
- `SESSION_SECRET`: secreto aleatorio de al menos 32 caracteres si se activa contraseña. Para generarlo: `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`.

Las credenciales pertenecen solo al backend. `.env` y sus variantes se ignoran en Git, y `.env.example` es la plantilla pública.

## Producción

```sh
npm run build
npm start
```

Configura `NODE_ENV=production`, `MONGODB_URI`, `APP_PASSWORD`, `SESSION_SECRET` y `FRONTEND_URL`. Usa HTTPS detrás de un proxy de confianza. Las sesiones duran 8 horas, se guardan en MongoDB y usan cookies `HttpOnly`, `SameSite=Lax`, `Secure` en producción. La API confía en un salto de proxy para reconocer HTTPS.

Se recomienda servir frontend y API bajo el mismo origen: el proxy inverso debe reenviar `/api` sin quitar el prefijo, y enviar `X-Forwarded-Proto`. Mantén `VITE_API_URL=/api`. El proxy de Vite solo está activo con `npm run dev` o `npm run preview`; el hosting estático necesita su propio proxy.

Si usas `VITE_API_URL=https://api.tudominio.cl/api`, usa dominios del mismo sitio y HTTPS para las cookies de sesión. Los dominios de sitios diferentes requieren ajustar explícitamente cookies y protección CSRF.

## Endpoints

- `GET /api/health`: estado de API/MongoDB y entorno.
- `GET /api/auth/session`: estado de autenticación.
- `POST /api/auth/login`: JSON `{ "password": "..." }`.
- `POST /api/auth/logout`: cierre de sesión.
- `GET /api/data`: estado completo y `revision`.
- `PUT /api/data`: importa un respaldo `{ version: 1, demo: false, transactions: [...] }` reemplazando el estado.
- `DELETE /api/data`: elimina todos los movimientos.
- `GET /api/transactions?month=2026-10`: movimientos con filtro de mes opcional.
- `POST /api/transactions`: crea un movimiento.
- `PUT /api/transactions/:id`: edita un movimiento completo.
- `DELETE /api/transactions/:id`: elimina un movimiento.

Ejemplo de movimiento:

```json
{
  "id": "identificador-unico",
  "type": "expense",
  "description": "Supermercado",
  "amount": 25000,
  "category": "comida",
  "date": "2026-10-28"
}
```

Tipos: `income` / `expense`. Categorías: `transporte`, `comida`, `fijos`, `cuotas`, `credito`, `bencina`, `salidas`, `repuestos`. Los ingresos usan `ingreso`. Montos positivos enteros en CLP. IDs únicos de hasta 100 caracteres (letras, números, `_`, `-`).

Todas las escrituras requieren `If-Match: "N"` con la revisión de `GET /api/data`. Si otra pestaña cambió los registros, la API responde `409`; el frontend actualiza y solicita revisar antes de guardar otra vez.

La colección `finances` guarda un documento personal con movimientos y revisión. Esto permite importaciones y borrados atómicos en MongoDB local sin exigir replica set. Es una aplicación de un usuario, sin cuentas múltiples. Límite: 40.000 movimientos y 8 MB por perfil; solicitudes JSON de hasta 10 MB. No se insertan datos de ejemplo automáticamente.

## Pruebas

```sh
npm test
npm run build
MONGODB_TEST_URI=mongodb://localhost:27017 npm run test:integration
```

La integración crea una base temporal `savia_test_<uuid>` y elimina únicamente esa base. Nunca usa ni borra `finanzas`.

Referencias: [conexiones de MongoDB](https://www.mongodb.com/docs/drivers/node/v6.x/connect/connection-options/), [errores en Express 5](https://expressjs.com/en/5x/guide/error-handling/).
