import { fromBase64, timingSafeEqualBytes } from "./crypto";
import type { SubscriberRow } from "./db";
import type { AppSettings } from "./settings";

export type RenderedEmail = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string[];
  headers: Record<string, string>;
  tags: Array<{ name: string; value: string }>;
};

export type BatchSendResult = {
  id?: string;
  error?: string;
};

export class ResendRateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("Resend rate limited");
    this.name = "ResendRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function marketingFooter(address?: string): string {
  const postal = address?.trim()
    ? `<p style="margin:8px 0 0">${address.trim()}</p>`
    : "";
  return `
<div style="margin-top:48px;padding-top:16px;border-top:1px solid #ddd;font:13px/1.6 sans-serif;color:#666">
  このメールはご登録いただいた方へお送りしています。<br />
  配信停止は <a href="{{unsubscribe_url}}">こちら</a>
  ${postal}
</div>
`;
}

export function originFrom(requestUrl: string): string {
  return new URL(requestUrl).origin;
}

export function unsubscribeUrl(origin: string, token: string): string {
  return `${origin}/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replaceAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}

export function renderEmail(input: {
  settings: AppSettings;
  origin: string;
  subscriber: Pick<SubscriberRow, "email" | "name" | "unsubscribe_token">;
  subject: string;
  html: string;
  text?: string | null;
  previewText?: string | null;
  listName: string;
  campaignId: string;
  logId: string;
  postalAddress?: string;
}): RenderedEmail {
  const unsub = unsubscribeUrl(input.origin, input.subscriber.unsubscribe_token);
  const vars = {
    name: input.subscriber.name || input.subscriber.email.split("@")[0] || "",
    email: input.subscriber.email,
    unsubscribe_url: unsub,
    list_name: input.listName,
    preview_text: input.previewText ?? "",
  };
  const htmlSource = input.html.includes("{{unsubscribe_url}}")
    ? input.html
    : `${input.html}${marketingFooter(input.postalAddress)}`;
  const html = renderTemplate(htmlSource, vars);
  const textSource =
    input.text?.trim() ||
    html.replaceAll(/<style[\s\S]*?<\/style>/gi, " ").replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ").trim();
  const text = renderTemplate(
    textSource.includes("{{unsubscribe_url}}") ? textSource : `${textSource}\n\n配信停止: {{unsubscribe_url}}`,
    vars,
  );

  return {
    from: `${input.settings.fromName} <${input.settings.fromEmail}>`,
    to: [input.subscriber.email],
    subject: renderTemplate(input.subject, vars),
    html,
    text,
    reply_to: input.settings.replyTo ? [input.settings.replyTo] : undefined,
    headers: {
      "List-Unsubscribe": `<${unsub}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: [
      { name: "campaign_id", value: sanitizeTag(input.campaignId) },
      { name: "log_id", value: sanitizeTag(input.logId) },
    ],
  };
}

function sanitizeTag(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, "").slice(0, 256);
}

export async function sendEmail(apiKey: string, email: RenderedEmail): Promise<BatchSendResult> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(email),
  });
  if (response.status === 429) {
    return { error: "Resend rate limited" };
  }
  const body = (await response.json()) as { id?: string; message?: string; name?: string };
  if (!response.ok) {
    return { error: body.message || body.name || `Resend ${response.status}` };
  }
  return { id: body.id };
}

export async function sendBatch(
  apiKey: string,
  emails: RenderedEmail[],
  idempotencyKey: string,
): Promise<BatchSendResult[]> {
  if (emails.length === 0) return [];
  const response = await fetch("https://api.resend.com/emails/batch?batchValidation=permissive", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify(emails),
  });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") || response.headers.get("ratelimit-reset") || 2);
    throw new ResendRateLimitError(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 2);
  }
  const body = (await response.json()) as {
    data?: Array<{ id?: string }>;
    errors?: Array<{ index: number; message: string }>;
    message?: string;
    name?: string;
  };
  if (!response.ok) {
    const error = body.message || body.name || `Resend ${response.status}`;
    return emails.map(() => ({ error }));
  }
  const failed = new Map((body.errors ?? []).map((item) => [item.index, item.message]));
  return emails.map((_, index) => {
    if (failed.has(index)) return { error: failed.get(index) };
    return { id: body.data?.[index]?.id };
  });
}

export async function verifyResendWebhook(
  secret: string,
  payload: string,
  headers: Headers,
): Promise<boolean> {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatureHeader = headers.get("svix-signature");
  if (!id || !timestamp || !signatureHeader) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = fromBase64(rawSecret);
  const signed = `${id}.${timestamp}.${payload}`;
  const expected = await hmacSha256Raw(keyBytes, signed);
  const expectedB64 = btoa(String.fromCharCode(...expected));

  return signatureHeader.split(" ").some((part) => {
    const value = part.startsWith("v1,") ? part.slice(3) : part;
    try {
      return timingSafeEqualBytes(fromBase64(value), fromBase64(expectedB64));
    } catch {
      return false;
    }
  });
}

async function hmacSha256Raw(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)));
}

export function webhookEventToStatus(type: string): import("./db").SendStatus | null {
  switch (type) {
    case "email.sent":
      return "sent";
    case "email.delivered":
      return "delivered";
    case "email.opened":
      return "opened";
    case "email.clicked":
      return "clicked";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    case "email.failed":
    case "email.suppressed":
      return "failed";
    default:
      return null;
  }
}
