import type { NextFunction, Request, Response } from 'express';
import type { AuthService } from '../../auth/service.ts';
import type { AuthUser } from '../../shared/types/index.ts';

export const SESSION_COOKIE_NAME = 'gbt_session';
const API_SECRET_TOKEN = process.env.TERMINAL_API_TOKEN || '';

export interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
  authToken?: string;
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

export function extractSessionToken(req: Pick<Request, 'headers'>): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] || null;
}

export function sessionAuthMiddleware(authService: AuthService) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    // MT5 bridge uses its own bearer token middleware when configured
    if (req.path === '/mt5/bridge/ingest') {
      next();
      return;
    }

    const token = extractSessionToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication required. Please sign in.' });
      return;
    }

    const user = authService.verifySession(token);
    if (!user) {
      res.status(401).json({ error: 'Session invalid or expired. Please sign in again.' });
      return;
    }

    req.authUser = user;
    req.authToken = token;
    next();
  };
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // If no token is configured in env, allow open access unless called anonymously on non-EA endpoints
  if (!API_SECRET_TOKEN) {
    next();
    return;
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Bearer token required for sensitive endpoint' });
    return;
  }
  const token = authHeader.slice(7);
  if (token !== API_SECRET_TOKEN) {
    res.status(403).json({ error: 'Forbidden: Invalid API token' });
    return;
  }
  next();
}

const recentRequests = new Map<string, { count: number; resetTime: number }>();

export function rateLimitMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

export function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
}

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: message });
}
