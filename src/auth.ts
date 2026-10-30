import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from 'mongodb';
import { jwtVerify, SignJWT } from 'jose';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from './errors.js';

const scrypt = promisify(scryptCallback);
const lifetime = 30 * 24 * 60 * 60;
const cookieName = 'savia.auth';
export const credentialsSchema = z.object({ username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/), password: z.string().min(8).max(128) }).strict();
export type User = { id: string; username: string };
export type Account = User & { passwordHash: string };
export type LoginSession = { id: string; userId: string; expiresAt: Date };
export interface AuthRepository {
  byName(username: string): Promise<Account | null>;
  byId(id: string): Promise<Account | null>;
  insert(user: Account): Promise<void>;
  putSession(session: LoginSession): Promise<void>;
  getSession(id: string): Promise<LoginSession | null>;
  renewSession(id: string, expiresAt: Date): Promise<boolean>;
  deleteSession(id: string): Promise<void>;
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
async function verifyPassword(password: string, stored: string) {
  const [salt, hex] = stored.split(':');
  const hash = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(hex, 'hex');
  return expected.length === hash.length && timingSafeEqual(expected, hash);
}
export class MongoAuthRepository implements AuthRepository {
  constructor(private db: Db) {}
  private users() { return this.db.collection<Account & { _id: string }>('users'); }
  private sessions() { return this.db.collection<LoginSession & { _id: string }>('auth_sessions'); }
  async initialize() {
    await this.users().createIndex({ username: 1 }, { unique: true });
    await this.sessions().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }
  async byName(username: string) { return this.users().findOne({ username }); }
  async byId(id: string) { return this.users().findOne({ _id: id }); }
  async insert(user: Account) {
    try { await this.users().insertOne({ _id: user.id, ...user }); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 11000) throw new ApiError(409, 'USERNAME_TAKEN', 'El nombre de usuario ya está ocupado.'); throw error; }
  }
  async putSession(session: LoginSession) { await this.sessions().insertOne({ _id: session.id, ...session }); }
  async getSession(id: string) { return this.sessions().findOne({ _id: id }); }
  async renewSession(id: string, expiresAt: Date) { return (await this.sessions().updateOne({ _id: id, expiresAt: { $gt: new Date() } }, { $set: { expiresAt } })).matchedCount === 1; }
  async deleteSession(id: string) { await this.sessions().deleteOne({ _id: id }); }
}
export class AuthService {
  private key: Uint8Array;
  private dummyHash: Promise<string>;
  constructor(public repository: AuthRepository, secret: string, private secure = false) {
    if (secret.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres.');
    this.key = new TextEncoder().encode(secret);
    this.dummyHash = hashPassword(randomBytes(32).toString('hex'));
  }
  async seed(username: string, password: string) {
    const existing = await this.repository.byId('personal');
    if (existing) return existing;
    const credentials = credentialsSchema.parse({ username, password });
    const user = { id: 'personal', username: credentials.username, passwordHash: await hashPassword(credentials.password) };
    try { await this.repository.insert(user); } catch (error) { const saved = await this.repository.byId('personal'); if (saved) return saved; throw error; }
    return user;
  }
  async register(input: unknown) {
    const { username, password } = credentialsSchema.parse(input);
    const user = { id: randomUUID(), username, passwordHash: await hashPassword(password) };
    await this.repository.insert(user);
    return { id: user.id, username: user.username };
  }
  async login(input: unknown) {
    const credentials = credentialsSchema.safeParse(input);
    if (!credentials.success) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos.');
    const user = await this.repository.byName(credentials.data.username);
    const valid = await verifyPassword(credentials.data.password, user?.passwordHash ?? await this.dummyHash);
    if (!user || !valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos.');
    return { id: user.id, username: user.username };
  }
  private async issue(res: Response, userId: string, sid: string) {
    const token = await new SignJWT({ sid }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(userId).setIssuer('savia-api').setAudience('savia-web').setIssuedAt().setExpirationTime(`${lifetime}s`).sign(this.key);
    res.cookie(cookieName, token, { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/api', maxAge: lifetime * 1000 });
  }
  async start(res: Response, user: User) {
    const sid = randomUUID();
    await this.repository.putSession({ id: sid, userId: user.id, expiresAt: new Date(Date.now() + lifetime * 1000) });
    await this.issue(res, user.id, sid);
  }
  async authenticate(req: Request, res: Response): Promise<{ user: User; sid: string } | null> {
    const token = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!token || token.length > 4096) return null;
    let payload;
    try { ({ payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'], issuer: 'savia-api', audience: 'savia-web', requiredClaims: ['sub', 'iat', 'exp'] })); }
    catch { this.clear(res); return null; }
    if (typeof payload.sid !== 'string' || typeof payload.sub !== 'string') return null;
    const session = await this.repository.getSession(payload.sid);
    if (!session || session.userId !== payload.sub || session.expiresAt.getTime() <= Date.now()) { this.clear(res); return null; }
    const user = await this.repository.byId(payload.sub);
    if (!user) { this.clear(res); return null; }
    if (Date.now() / 1000 - (payload.iat ?? 0) > 24 * 60 * 60) {
      if (!await this.repository.renewSession(session.id, new Date(Date.now() + lifetime * 1000))) return null;
      await this.issue(res, user.id, session.id);
    }
    return { user: { id: user.id, username: user.username }, sid: session.id };
  }
  clear(res: Response) { res.clearCookie(cookieName, { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/api' }); }
}
