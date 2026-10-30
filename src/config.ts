import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017/finanzas').refine(value => /^mongodb(?:\+srv)?:\/\//.test(value), 'MONGODB_URI debe comenzar con mongodb:// o mongodb+srv://'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().min(1).default('127.0.0.1'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173').transform(value => new URL(value).origin),
  INITIAL_USERNAME: z.string().default('michael'),
  INITIAL_PASSWORD: z.string().default(''),
  JWT_SECRET: z.string().min(32),
});

export type Config = z.infer<typeof environmentSchema>;
export const parseConfig = (env: Record<string, string | undefined>): Config => {
  let uri = env.MONGODB_URI;
  if (uri?.includes('<db_username>') || uri?.includes('<db_password>')) {
    if (!env.USER_MONGO || !env.PASSWORD_MONGO) {
      throw new Error('Configura USER_MONGO y PASSWORD_MONGO para completar MONGODB_URI.');
    }
    uri = uri.replace('<db_username>', encodeURIComponent(env.USER_MONGO))
      .replace('<db_password>', encodeURIComponent(env.PASSWORD_MONGO));
  }
  return environmentSchema.parse({ ...env, MONGODB_URI: uri });
};
export function loadConfig(): Config {
  dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
  return parseConfig(process.env);
}
