const SESSION_STORAGE_KEY = 'gbt_session_token';

let activeToken: string | null = readStoredToken();
let unauthorizedHandler: (() => void) | null = null;

export function readStoredToken(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setApiToken(token: string | null): void {
  activeToken = token;
  try {
    if (typeof window === 'undefined') return;
    if (token) {
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage access errors in restricted frames
  }
}

export function getApiToken(): string | null {
  return activeToken;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

function resolveApiPath(input: RequestInfo | URL): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const parsed = new URL(rawUrl, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined)
  );
  if (activeToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${activeToken}`);
  }

  const response = await window.fetch(input, {
    ...init,
    headers,
    credentials: init?.credentials ?? 'include',
  });

  if (response.status === 401) {
    const path = resolveApiPath(input);
    const isPublicAuthRoute =
      path === '/api/auth/login' ||
      path === '/api/auth/logout' ||
      path === '/api/auth/session';

    if (!isPublicAuthRoute && unauthorizedHandler) {
      unauthorizedHandler();
    }
  }

  return response;
}
