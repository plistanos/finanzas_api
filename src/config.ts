import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017/finanzas').refine(value => /^mongodb(?:\+srv)?:\/\//.test(value), 'MONGODB_URI debe comenzar con mongodb:// o mongodb+srv://'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().min(1).default('127.0.0.1'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173').transform(value => new URL(value).origin),
  APP_PASSWORD: z.string().default(''),
  SESSION_SECRET: z.string().default(''),
}).superRefine((config, ctx) => {
  if (config.NODE_ENV === 'production' && config.APP_PASSWORD.length < 12) ctx.addIssue({ code: 'custom', path: ['APP_PASSWORD'], message: 'En production configura APP_PASSWORD con al menos 12 caracteres.' });
  if (config.APP_PASSWORD && config.SESSION_SECRET.length < 32) ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'SESSION_SECRET debe tener al menos 32 caracteres cuando se activa el acceso con contraseña.' });
  if (!config.APP_PASSWORD && !['127.0.0.1', 'localhost', '::1'].includes(config.HOST)) ctx.addIssue({ code: 'custom', path: ['HOST'], message: 'Sin APP_PASSWORD, HOST debe ser una dirección local.' });
});

export type Config = z.infer<typeof environmentSchema>;
export const parseConfig = (env: Record<string, string | undefined>): Config => environmentSchema.parse(env);
export function loadConfig(): Config {
  dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
  return parseConfig(process.env);
}
