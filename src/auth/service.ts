import crypto from 'node:crypto';
import type { AuthSession, AuthUser } from '../shared/types/index.ts';
import type { PlatformSqliteStore } from '../storage/platform-db.ts';

export const DEFAULT_ADMIN_EMAIL = (process.env.TERMINAL_DEFAULT_USER || 'maswaeecom@gmail.com')
  .trim()
  .toLowerCase();
export const DEFAULT_ADMIN_PASSWORD = process.env.TERMINAL_DEFAULT_PASSWORD || 'Admin@12345';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashPassword(password: string, saltHex?: string): string {
  const salt = saltHex ?? crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, originalHex] = parts;
  if (!salt || !originalHex) return false;
  const derivedBuf = crypto.scryptSync(password, salt, 64);
  const originalBuf = Buffer.from(originalHex, 'hex');
  if (derivedBuf.length !== originalBuf.length) return false;
  return crypto.timingSafeEqual(derivedBuf, originalBuf);
}

export class AuthService {
  private readonly store: PlatformSqliteStore;

  constructor(store: PlatformSqliteStore) {
    this.store = store;
    this.ensureDefaultAdminUser();
  }

  private ensureDefaultAdminUser(): void {
    const existing = this.store.getUserByEmail(DEFAULT_ADMIN_EMAIL);
    if (!existing) {
      this.store.createUser({
        id: `usr:${crypto.randomUUID()}`,
        email: DEFAULT_ADMIN_EMAIL,
        role: 'admin',
        passwordHash: hashPassword(DEFAULT_ADMIN_PASSWORD),
        createdAt: Date.now(),
        lastLoginAt: null,
      });
    }
  }

  public login(
    emailOrUsername: string,
    password: string
  ): { user: AuthUser; token: string; expiresAt: number } | null {
    const normalizedEmail = emailOrUsername.trim().toLowerCase();
    if (!normalizedEmail || !password) return null;

    const record = this.store.getUserByEmail(normalizedEmail);
    const now = Date.now();

    if (!record || !verifyPassword(password, record.passwordHash)) {
      this.store.logAudit({
        id: `audit:auth:${now}:${crypto.randomBytes(3).toString('hex')}`,
        category: 'AUTH',
        action: 'LOGIN_FAILED',
        actor: normalizedEmail || 'anonymous',
        details: `Failed login attempt for ${normalizedEmail}`,
        severity: 'warning',
        timestamp: now,
      });
      return null;
    }

    this.store.deleteExpiredSessions(now);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = now + SESSION_TTL_MS;

    const session: AuthSession = {
      token,
      userId: record.id,
      email: record.email,
      role: record.role,
      createdAt: now,
      expiresAt,
    };

    this.store.createSession(session);
    this.store.updateUserLastLogin(record.id, now);
    this.store.logAudit({
      id: `audit:auth:${now}:${crypto.randomBytes(3).toString('hex')}`,
      category: 'AUTH',
      action: 'LOGIN_SUCCESS',
      actor: record.email,
      details: `Authenticated session created for ${record.email}`,
      severity: 'info',
      timestamp: now,
    });

    return {
      user: {
        id: record.id,
        email: record.email,
        role: record.role,
        createdAt: record.createdAt,
        lastLoginAt: now,
      },
      token,
      expiresAt,
    };
  }

  public verifySession(token: string | null | undefined): AuthUser | null {
    if (!token || typeof token !== 'string') return null;
    const session = this.store.getSessionByToken(token.trim());
    if (!session) return null;

    if (session.expiresAt <= Date.now()) {
      this.store.deleteSession(session.token);
      return null;
    }

    const user = this.store.getUserByEmail(session.email);
    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    };
  }

  public logout(token: string | null | undefined): boolean {
    if (!token || typeof token !== 'string') return false;
    const trimmed = token.trim();
    const session = this.store.getSessionByToken(trimmed);
    const deleted = this.store.deleteSession(trimmed);
    if (deleted) {
      const now = Date.now();
      this.store.logAudit({
        id: `audit:auth:${now}:${crypto.randomBytes(3).toString('hex')}`,
        category: 'AUTH',
        action: 'LOGOUT',
        actor: session?.email ?? 'session',
        details: `Session revoked for ${session?.email ?? 'user'}`,
        severity: 'info',
        timestamp: now,
      });
    }
    return deleted;
  }
}
