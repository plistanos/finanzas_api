import { AuthService, type Account, type AuthRepository, type LoginSession } from '../src/auth.js';
export const secret = 'test-secret-with-at-least-32-characters';
export class MemoryAuthRepository implements AuthRepository {
  users = new Map<string, Account>();
  sessions = new Map<string, LoginSession>();
  async byName(username: string) { return [...this.users.values()].find(u => u.username === username) ?? null; }
  async byId(id: string) { return this.users.get(id) ?? null; }
  async insert(user: Account) { if (await this.byName(user.username)) throw new Error('duplicate'); this.users.set(user.id, user); }
  async putSession(session: LoginSession) { this.sessions.set(session.id, session); }
  async getSession(id: string) { return this.sessions.get(id) ?? null; }
  async renewSession(id: string, expiresAt: Date) { const session = this.sessions.get(id); if (!session || session.expiresAt.getTime() <= Date.now()) return false; session.expiresAt = expiresAt; return true; }
  async deleteSession(id: string) { this.sessions.delete(id); }
}
export async function testAuth() {
  const auth = new AuthService(new MemoryAuthRepository(), secret);
  await auth.seed('michael', 'galaonli');
  return auth;
}
