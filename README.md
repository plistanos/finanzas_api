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
JWT_SECRET=un-secreto-aleatorio-de-al-menos-32-caracteres
INITIAL_USERNAME=michael
INITIAL_PASSWORD=tu-clave-inicial
```

- `NODE_ENV`: `development` o `production`. No cambia la base automáticamente; siempre se usa `MONGODB_URI`.
- `MONGODB_URI`: URI con nombre de base. Puedes sustituirla por una URI de Atlas `mongodb+srv://.../finanzas`.
- `HOST` / `PORT`: dirección de escucha. Todas las cuentas requieren login; para exponer la API usa HTTPS y, si corresponde, `HOST=0.0.0.0`.
- `FRONTEND_URL`: origen exacto del frontend (protocolo, dominio y puerto), sin rutas.
- `JWT_SECRET`: secreto aleatorio de al menos 32 caracteres, estable entre reinicios. Genera uno con `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`.
- `INITIAL_USERNAME` / `INITIAL_PASSWORD`: crean la primera cuenta y le asignan los movimientos y categorías históricos. La contraseña requiere al menos 8 caracteres y solo se usa la primera vez; puedes retirar esta variable tras la creación. Reiniciar no cambia la contraseña ni reasigna datos.

Las credenciales pertenecen solo al backend. `.env` y sus variantes se ignoran en Git, y `.env.example` es la plantilla pública.

## Producción

```sh
npm run build
npm start
```

Configura `NODE_ENV=production`, `MONGODB_URI`, `JWT_SECRET` y `FRONTEND_URL`. Usa HTTPS detrás de un proxy de confianza. Las sesiones usan JWT firmado HS256 con emisor, audiencia y vencimiento validados. Duran 30 días y se renuevan al usar la app después de un día; se guardan en cookies persistentes. Las sesiones revocables se registran en `auth_sessions` de MongoDB con cookies `HttpOnly`, `SameSite=Lax`, `Secure` en producción. La API confía en un salto de proxy para reconocer HTTPS.

Se recomienda servir frontend y API bajo el mismo origen: el proxy inverso debe reenviar `/api` sin quitar el prefijo, y enviar `X-Forwarded-Proto`. Mantén `VITE_API_URL=/api`. El proxy de Vite solo está activo con `npm run dev` o `npm run preview`; el hosting estático necesita su propio proxy.

Si usas `VITE_API_URL=https://api.tudominio.cl/api`, usa dominios del mismo sitio y HTTPS para las cookies de sesión. Los dominios de sitios diferentes requieren ajustar explícitamente cookies y protección CSRF.

## Endpoints

- `GET /api/health`: estado de API/MongoDB y entorno.
- `GET /api/auth/session`: estado de autenticación.
- `POST /api/auth/login`: JSON `{ "username": "...", "password": "..." }`.
- `POST /api/auth/register`: crea una cuenta independiente con el mismo formato y abre su sesión.
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

Las escrituras de movimientos y respaldos requieren `If-Match: "N"` con la revisión de `GET /api/data`. Si otra pestaña cambió los registros, la API responde `409`; el frontend actualiza y solicita revisar antes de guardar otra vez.

La colección `finances` guarda un documento por cuenta con movimientos y revisión; su `_id` es el ID de usuario. La primera cuenta conserva el ID `personal` y los movimientos históricos. Esto permite importaciones y borrados atómicos en MongoDB local sin exigir replica set. Las contraseñas se guardan con scrypt y salt aleatorio en `users`. Los datos y categorías se filtran por la identidad del JWT validado; no se acepta un usuario elegido en la solicitud. Cerrar sesión revoca el token en el servidor. Límite: 40.000 movimientos y 8 MB por perfil; solicitudes JSON de hasta 10 MB. No se insertan datos de ejemplo automáticamente.

## Pruebas

```sh
npm test
npm run build
MONGODB_TEST_URI=mongodb://localhost:27017 npm run test:integration
```

La integración crea una base temporal `test_<uuid>` y elimina únicamente esa base. Nunca usa ni borra `finanzas`.

Referencias: [conexiones de MongoDB](https://www.mongodb.com/docs/drivers/node/v6.x/connect/connection-options/), [errores en Express 5](https://expressjs.com/en/5x/guide/error-handling/).

## Categorías

La colección `categories` guarda un documento por categoría y cuenta, con `userId` e índice único `(userId, id)`: `id`, `name`, `color` hexadecimal, `type` y `revision`. Al iniciar, la API agrega las ocho categorías de gasto originales y `ingreso` si faltan, sin sobrescribir sus nombres o colores editados. Los movimientos conservan el identificador de categoría al renombrarla.

- `GET /api/categories`: lista el catálogo.
- `POST /api/categories`: crea una categoría de gasto con `{ id, name, color, type: "expense" }`.
- `PUT /api/categories/:id`: cambia nombre y color; requiere `If-Match: "N"` con la revisión de esa categoría. El ID y el tipo permanecen estables.

`GET /api/data` incluye el catálogo. Los respaldos exportados incluyen categorías; la importación incorpora las que faltan y conserva la configuración de las que ya existen. El borrado de movimientos conserva las categorías. Las referencias a categorías inexistentes o de tipo incompatible se rechazan.

## Servir el frontend desde public

La API sirve la página desde `public/`, tanto con `npm run dev` como con `npm start`. Esta carpeta queda junto a `src/` y `dist/`, no dentro de `dist/`.

Después de compilar el frontend, copia **el contenido** de su `dist/` a `finanzas_api/public/`. Desde la carpeta del frontend, en PowerShell:

```powershell
npm run build
Copy-Item -Path .\dist\* -Destination ..\finanzas_api\public -Recurse -Force
```

Mantén `VITE_API_URL=/api` al compilar. Luego, desde `finanzas_api`:

```powershell
npm run build
npm start
```

Abre `http://127.0.0.1:3001/` en desarrollo local. En producción abre tu dominio HTTPS. La página y la API comparten servidor, y el login admite este mismo origen además de `FRONTEND_URL` para desarrollo separado. Las rutas de la SPA devuelven `index.html`; las rutas `/api` siguen devolviendo JSON y mantienen la autenticación. Los archivos generados en `public/` se ignoran en Git.
