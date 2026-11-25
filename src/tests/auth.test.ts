import http from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService, hashPassword, verifyPassword } from '../auth/service.ts';
import { createApiRouter } from '../backend/routes/api.ts';
import { PlatformSqliteStore } from '../storage/platform-db.ts';

function buildMinimalServiceStub(store: PlatformSqliteStore, authService: AuthService) {
  return {
    platformStore: store,
    authService,
    marketData: {
      getAllProviderStatuses: () => [],
      getAllQuotes: () => [],
    },
    getOverview: () => ({
      quotes: [],
      providers: [],
      settings: {},
      alertRules: [],
      alertHistory: [],
      events: [],
    }),
  } as any;
}

async function startTestServer(app: express.Express): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind ephemeral port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('Authentication Service & HTTP Session Gate', () => {
  let store: PlatformSqliteStore;
  let authService: AuthService;
  let closeServer: (() => Promise<void>) | null = null;

  beforeEach(() => {
    store = new PlatformSqliteStore(':memory:');
    authService = new AuthService(store);
  });

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
  });

  it('hashes passwords with per-user random salt and verifies with timingSafeEqual', () => {
    const h1 = hashPassword('Admin@12345');
    const h2 = hashPassword('Admin@12345');
    expect(h1).not.toBe(h2);
    expect(verifyPassword('Admin@12345', h1)).toBe(true);
    expect(verifyPassword('Admin@12345', h2)).toBe(true);
    expect(verifyPassword('WrongPass', h1)).toBe(false);
  });

  it('seeds default admin maswaeecom@gmail.com / Admin@12345 and authenticates case-insensitively', () => {
    const res = authService.login('MASWAEECOM@GMAIL.COM', 'Admin@12345');
    expect(res).not.toBeNull();
    expect(res!.user.email).toBe('maswaeecom@gmail.com');
    expect(res!.user.role).toBe('admin');
    expect(res!.token.length).toBe(64);

    const verified = authService.verifySession(res!.token);
    expect(verified).not.toBeNull();
    expect(verified!.email).toBe('maswaeecom@gmail.com');
  });

  it('rejects wrong password or unknown user and logs failed audit entry', () => {
    expect(authService.login('maswaeecom@gmail.com', 'WrongPassword!')).toBeNull();
    expect(authService.login('unknown@example.com', 'Admin@12345')).toBeNull();

    const audits = store.getAuditLogs(10);
    expect(audits.some((a) => a.action === 'LOGIN_FAILED')).toBe(true);
  });

  it('revokes session on logout and rejects expired sessions', () => {
    const res = authService.login('maswaeecom@gmail.com', 'Admin@12345');
    expect(res).not.toBeNull();
    const token = res!.token;

    expect(authService.logout(token)).toBe(true);
    expect(authService.verifySession(token)).toBeNull();

    const expiredToken = 'expired-token-test';
    store.createSession({
      token: expiredToken,
      userId: res!.user.id,
      email: res!.user.email,
      role: 'admin',
      createdAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1_000,
    });
    expect(authService.verifySession(expiredToken)).toBeNull();
  });

  it('protects /api/* routes with 401 before login, accepts Bearer & Cookie after login, and blocks after logout', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(buildMinimalServiceStub(store, authService)));

    const server = await startTestServer(app);
    closeServer = server.close;

    // 1. Unauthenticated protected route -> 401
    const unauthOverview = await fetch(`${server.baseUrl}/api/overview`);
    expect(unauthOverview.status).toBe(401);

    // 2. Unauthenticated session check -> authenticated: false
    const preSession = await fetch(`${server.baseUrl}/api/auth/session`);
    expect(preSession.status).toBe(200);
    expect(await preSession.json()).toEqual({ authenticated: false, user: null });

    // 3. Invalid login -> 401
    const badLogin = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maswaeecom@gmail.com', password: 'bad' }),
    });
    expect(badLogin.status).toBe(401);

    // 4. Valid login -> 200 + token + Set-Cookie
    const goodLogin = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maswaeecom@gmail.com', password: 'Admin@12345' }),
    });
    expect(goodLogin.status).toBe(200);
    const setCookie = goodLogin.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('gbt_session=');
    const loginPayload = (await goodLogin.json()) as {
      ok: boolean;
      token: string;
      user: { email: string };
    };
    expect(loginPayload.ok).toBe(true);
    expect(loginPayload.user.email).toBe('maswaeecom@gmail.com');

    // 5. Protected route with Bearer token -> 200
    const authBearer = await fetch(`${server.baseUrl}/api/overview`, {
      headers: { Authorization: `Bearer ${loginPayload.token}` },
    });
    expect(authBearer.status).toBe(200);

    // 6. Protected route with Cookie header -> 200
    const cookiePair = setCookie.split(';')[0];
    const authCookie = await fetch(`${server.baseUrl}/api/overview`, {
      headers: { Cookie: cookiePair },
    });
    expect(authCookie.status).toBe(200);

    // 7. Logout revokes session -> subsequent /api/overview -> 401
    const logoutRes = await fetch(`${server.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${loginPayload.token}` },
    });
    expect(logoutRes.status).toBe(200);

    const postLogout = await fetch(`${server.baseUrl}/api/overview`, {
      headers: { Authorization: `Bearer ${loginPayload.token}` },
    });
    expect(postLogout.status).toBe(401);
  });
});
