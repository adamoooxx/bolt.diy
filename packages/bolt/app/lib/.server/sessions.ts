import { createCookieSessionStorage, redirect } from '@remix-run/cloudflare';
import { decodeJwt } from 'jose';
import { CLIENT_ID, CLIENT_ORIGIN } from '~/lib/constants';
import { request as doRequest } from '~/lib/fetch';
import { logger } from '~/utils/logger';
import type { Identity } from '~/lib/analytics';
import { decrypt, encrypt } from '~/lib/crypto';

const DEV_SESSION_SECRET = import.meta.env.DEV ? 'LZQMrERo3Ewn/AbpSYJ9aw==' : undefined;
const DEV_PAYLOAD_SECRET = import.meta.env.DEV ? '2zAyrhjcdFeXk0YEDzilMXbdrGAiR+8ACIUgFNfjLaI=' : undefined;

const TOKEN_KEY = 't';
const EXPIRES_KEY = 'e';
const USER_ID_KEY = 'u';
const SEGMENT_KEY = 's';

interface SessionData {
  [TOKEN_KEY]: string;
  [EXPIRES_KEY]: number;
  [USER_ID_KEY]?: string;
  [SEGMENT_KEY]?: string;
}

export async function isAuthenticated(request: Request, env: Env) {
  const { session, sessionStorage } = await getSession(request, env);

  const sessionData: SessionData | null = await decryptSessionData(env, session.get('d'));

  const header = async (cookie: Promise<string>) => ({ headers: { 'Set-Cookie': await cookie } });
  const destroy = () => header(sessionStorage.destroySession(session));

  if (sessionData?.[TOKEN_KEY] == null) {
    return { authenticated: false as const, response: await destroy() };
  }

  const expiresAt = sessionData[EXPIRES_KEY] ?? 0;

  if (Date.now() < expiresAt) {
    return { authenticated: true as const };
  }

  logger.debug('Renewing token');

  let data: Awaited<ReturnType<typeof refreshToken>> | null = null;

  try {
    data = await refreshToken(sessionData[TOKEN_KEY]);
  } catch (error) {
    // we can ignore the error here because it's handled below
    logger.error(error);
  }

  if (data != null) {
    const expiresAt = cookieExpiration(data.expires_in, data.created_at);

    const newSessionData = { ...sessionData, [EXPIRES_KEY]: expiresAt };
    const encryptedData = await encryptSessionData(env, newSessionData);

    session.set('d', encryptedData);

    return { authenticated: true as const, response: await header(sessionStorage.commitSession(session)) };
  } else {
    return { authenticated: false as const, response: await destroy() };
  }
}

export async function createUserSession(
  request: Request,
  env: Env,
  tokens: { refresh: string; expires_in: number; created_at: number },
  identity?: Identity,
): Promise<ResponseInit> {
  const { session, sessionStorage } = await getSession(request, env);

  const expiresAt = cookieExpiration(tokens.expires_in, tokens.created_at);

  const sessionData: SessionData = {
    [TOKEN_KEY]: tokens.refresh,
    [EXPIRES_KEY]: expiresAt,
    [USER_ID_KEY]: identity?.userId ?? undefined,
    [SEGMENT_KEY]: identity?.segmentWriteKey ?? undefined,
  };

  const encryptedData = await encryptSessionData(env, sessionData);
  session.set('d', encryptedData);

  return {
    headers: {
      'Set-Cookie': await sessionStorage.commitSession(session, {
        maxAge: 3600 * 24 * 30, // 1 month
      }),
    },
  };
}

function getSessionStorage(cloudflareEnv: Env) {
  return createCookieSessionStorage<{ d: string }>({
    cookie: {
      name: '__session',
      httpOnly: true,
      path: '/',
      secrets: [DEV_SESSION_SECRET || cloudflareEnv.SESSION_SECRET],
      secure: import.meta.env.PROD,
    },
  });
}

export async function logout(request: Request, env: Env) {
  const { session, sessionStorage } = await getSession(request, env);

  const sessionData = await decryptSessionData(env, session.get('d'));

  if (sessionData) {
    revokeToken(sessionData[TOKEN_KEY]);
  }

  return redirect('/login', {
    headers: {
      'Set-Cookie': await sessionStorage.destroySession(session),
    },
  });
}

export function validateAccessToken(access: string) {
  const jwtPayload = decodeJwt(access);

  return jwtPayload.bolt === true;
}

export async function getSessionData(request: Request, env: Env) {
  const { session } = await getSession(request, env);

  const decrypted = await decryptSessionData(env, session.get('d'));

  return {
    userId: decrypted?.[USER_ID_KEY],
    segmentWriteKey: decrypted?.[SEGMENT_KEY],
  };
}

async function getSession(request: Request, env: Env) {
  const sessionStorage = getSessionStorage(env);
  const cookie = request.headers.get('Cookie');

  return { session: await sessionStorage.getSession(cookie), sessionStorage };
}

async function refreshToken(refresh: string): Promise<{ expires_in: number; created_at: number }> {
  const response = await doRequest(`${CLIENT_ORIGIN}/oauth/token`, {
    method: 'POST',
    body: urlParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refresh }),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(`Unable to refresh token\n${response.status} ${JSON.stringify(body)}`);
  }

  const { access_token: access } = body;

  if (!validateAccessToken(access)) {
    throw new Error('User is no longer authorized for Bolt');
  }

  return body;
}

function cookieExpiration(expireIn: number, createdAt: number) {
  return (expireIn + createdAt - 10 * 60) * 1000;
}

async function revokeToken(refresh?: string) {
  if (refresh == null) {
    return;
  }

  try {
    const response = await doRequest(`${CLIENT_ORIGIN}/oauth/revoke`, {
      method: 'POST',
      body: urlParams({
        token: refresh,
        token_type_hint: 'refresh_token',
        client_id: CLIENT_ID,
      }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      throw new Error(`Unable to revoke token: ${response.status}`);
    }
  } catch (error) {
    logger.debug(error);
    return;
  }
}

function urlParams(data: Record<string, string>) {
  const encoded = new URLSearchParams();

  for (const [key, value] of Object.entries(data)) {
    encoded.append(key, value);
  }

  return encoded;
}

async function decryptSessionData(env: Env, encryptedData?: string) {
  const decryptedData = encryptedData ? await decrypt(payloadSecret(env), encryptedData) : undefined;
  const sessionData: SessionData | null = JSON.parse(decryptedData ?? 'null');

  return sessionData;
}

async function encryptSessionData(env: Env, sessionData: SessionData) {
  return await encrypt(payloadSecret(env), JSON.stringify(sessionData));
}

function payloadSecret(env: Env) {
  return DEV_PAYLOAD_SECRET || env.PAYLOAD_SECRET;
}