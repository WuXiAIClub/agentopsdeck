import { timingSafeEqual } from 'node:crypto';
import { sessionTokenFromRequest } from './passkeys.js';
import { synchronousAuthorizationCall } from './synchronous-authorization.js';

export const ACCESS_COOKIE_NAME = 'agentopsdeck_access';

export function createAccessKeyGuard(accessKey: string | undefined, sessions = new Set<string>()) {
  return function isAuthorizedRequest(request: Request) {
    const sessionToken = sessionTokenFromRequest(request);
    // This is still a synchronous compatibility port, not an awaited SQL
    // authority. A future async implementation must migrate its callers too.
    if (sessionToken && synchronousAuthorizationCall(sessions.has, [sessionToken], undefined, sessions)) return true;
    if (!accessKey) return true;
    const supplied = accessKeyFromRequest(request);
    if (!supplied) return false;
    return safeEqual(supplied, accessKey);
  };
}

/** Key-login provenance is narrower than administrator access. In particular,
 * open mode and a current Passkey session cannot authorize WeChat binding. */
export function createAdministratorKeyGuard(accessKey: string | undefined,
  sessions?: { isAccessKeySession(token: string): boolean }) {
  return (request: Request): boolean => {
    if (!accessKey) return false;
    const supplied = accessKeyFromRequest(request);
    if (supplied) return safeEqual(supplied, accessKey);
    const token = sessionTokenFromRequest(request);
    return !!token && !!sessions
      && synchronousAuthorizationCall(sessions.isAccessKeySession, [token], undefined, sessions);
  };
}

export function accessKeyFromRequest(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  if (bearer) return bearer;
  const headerKey = request.headers.get('x-agentopsdeck-key')?.trim();
  if (headerKey) return headerKey;
  return cookieValue(request.headers.get('cookie'), ACCESS_COOKIE_NAME)?.trim();
}

export function isValidAccessKey(supplied: string | undefined, expected: string | undefined) {
  if (!expected) return true;
  if (!supplied) return false;
  return safeEqual(supplied, expected);
}

export function accessCookieHeader(value: string, request: Request, maxAgeSeconds = 60 * 60 * 24 * 7) {
  const secure = requestIsSecure(request);
  return [
    `${ACCESS_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : undefined,
  ].filter(Boolean).join('; ');
}

export function clearAccessCookieHeader() {
  return `${ACCESS_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function cookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey !== name) continue;
    try { return decodeURIComponent(rawValue.join('=')); }
    catch { return undefined; }
  }
  return undefined;
}

function requestIsSecure(request: Request) {
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return forwardedProto === 'https' || new URL(request.url).protocol === 'https:';
}

export function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
