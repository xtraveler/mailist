import { fromBase64Url, hmacBytes, timingSafeEqualBytes, timingSafeEqualString, toBase64Url } from "./crypto";

const COOKIE = "mailist_session";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionSecret(env: Env): string {
  return env.SESSION_SECRET?.trim() || `mailist:${env.ADMIN_PASSWORD ?? ""}`;
}

export async function verifyAdminPassword(env: Env, password: string): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  return timingSafeEqualString(password, env.ADMIN_PASSWORD);
}

export async function createSessionCookie(env: Env, request: Request): Promise<string> {
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ exp: Date.now() + WEEK_MS, v: 1 })),
  );
  const signature = toBase64Url(await hmacBytes(sessionSecret(env), payload));
  const secure = new URL(request.url).protocol === "https:";
  return `${COOKIE}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${WEEK_MS / 1000}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function hasValidSession(env: Env, request: Request): Promise<boolean> {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)mailist_session=([^;]+)/);
  if (!match?.[1]) return false;
  const [payload, signature] = match[1].split(".");
  if (!payload || !signature) return false;

  const expected = await hmacBytes(sessionSecret(env), payload);
  const given = fromBase64Url(signature);
  if (!timingSafeEqualBytes(expected, given)) return false;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { exp?: number };
    return typeof parsed.exp === "number" && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

export function redirect(location: string, headers?: HeadersInit): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...headers } });
}
