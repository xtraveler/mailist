import { getSetting, listSettings } from "./db";

export type AppSettings = {
  siteTitle: string;
  siteTagline: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  postalAddress: string;
};

export async function loadSettings(env: Env): Promise<AppSettings> {
  const stored = await listSettings(env.DB);
  return {
    siteTitle: stored.site_title || env.APP_NAME || "Mailist",
    siteTagline: stored.site_tagline || "大切な人に、届くメールを。",
    fromName: stored.from_name || env.FROM_NAME || "Mailist",
    fromEmail: stored.from_email || env.FROM_EMAIL || "onboarding@resend.dev",
    replyTo: stored.reply_to || "",
    postalAddress: stored.postal_address || "",
  };
}

export async function settingOr(env: Env, key: string, fallback: string): Promise<string> {
  return (await getSetting(env.DB, key)) || fallback;
}
