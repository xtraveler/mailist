import { Hono } from "hono";
import { clearSessionCookie, createSessionCookie, hasValidSession, redirect, verifyAdminPassword } from "./auth";
import {
  countActiveSubscribers,
  createCampaign,
  createList,
  deleteList,
  deleteSubscriber,
  dueScheduledCampaigns,
  getCampaign,
  getCampaignStats,
  getDefaultList,
  getList,
  getListBySlug,
  getOrCreateList,
  getSubscriberByToken,
  listCampaigns,
  listLists,
  listSubscribers,
  setSetting,
  unsubscribeByToken,
  updateCampaign,
  upsertSubscriber,
  getDashboardStats,
  markSubscriberStatus,
  removeFromList,
  updateSendLogByResendId,
} from "./db";
import { parseSubscriberCsv } from "./csv";
import { enqueueCsvImport, requeueStaleBatches, startCampaignSend } from "./queue";
import { slugify } from "./slug";
import { renderEmail, sendEmail, verifyResendWebhook, webhookEventToStatus } from "./resend";
import { ensureSchema } from "./schema";
import { loadSettings } from "./settings";
import {
  campaignEditorPage,
  campaignsPage,
  dashboardPage,
  landingPage,
  listsPage,
  loginPage,
  settingsPage,
  setupPage,
  simplePage,
  subscribersPage,
  unsubscribePage,
} from "./ui";

type AppEnv = { Bindings: Env };

export const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  if (needsSetup(c.env) && !c.req.path.startsWith("/styles") && !c.req.path.startsWith("/favicon")) {
    return c.html(setupPage(), 503);
  }
  await ensureSchema(c.env.DB);
  const origin = new URL(c.req.url).origin;
  if (!origin.includes("localhost") && !origin.includes("127.0.0.1")) {
    await setSetting(c.env.DB, "public_origin", origin);
  }
  await next();
});

app.get("/", async (c) => {
  const settings = await loadSettings(c.env);
  const list = await getDefaultList(c.env.DB);
  const notice = c.req.query("ok") === "1" ? "購読を受け付けました。ありがとうございます。" : undefined;
  return c.html(landingPage(settings, list, notice));
});

app.post("/subscribe", async (c) => {
  const settings = await loadSettings(c.env);
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim();
  const name = String(form.name ?? "").trim();
  const list = (await getList(c.env.DB, String(form.list_id ?? ""))) ?? (await getDefaultList(c.env.DB));
  if (!isEmail(email) || !list) {
    return c.html(landingPage(settings, list, undefined, "メールアドレスを確認してください。"), 400);
  }
  await upsertSubscriber(c.env.DB, { email, name, listId: list.id });
  return redirect("/?ok=1");
});

app.post("/api/subscribe", async (c) => {
  const body = await c.req.json<{ email?: string; name?: string; list_id?: string }>().catch(
    (): { email?: string; name?: string; list_id?: string } => ({}),
  );
  const email = String(body.email ?? "").trim();
  const list = (body.list_id ? await getList(c.env.DB, body.list_id) : null) ?? (await getDefaultList(c.env.DB));
  if (!isEmail(email) || !list) {
    return c.json({ ok: false, error: "invalid_email" }, 400);
  }
  const result = await upsertSubscriber(c.env.DB, { email, name: body.name, listId: list.id });
  return c.json({ ok: true, created: result.created, id: result.subscriber.id });
});

app.get("/unsubscribe", async (c) => {
  const settings = await loadSettings(c.env);
  const token = c.req.query("token") ?? "";
  const subscriber = token ? await getSubscriberByToken(c.env.DB, token) : null;
  if (!subscriber) return c.html(simplePage(settings, "リンクが無効です", "配信停止用のリンクを確認してください。"), 404);
  return c.html(unsubscribePage(settings, subscriber.email, token, subscriber.status === "unsubscribed"));
});

app.post("/unsubscribe", async (c) => {
  const settings = await loadSettings(c.env);
  const contentType = c.req.header("content-type") ?? "";
  let token = c.req.query("token") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await c.req.parseBody();
    token = String(form.token ?? token);
  } else if (contentType.includes("text/plain") || c.req.header("list-unsubscribe") || c.req.raw.body) {
    const raw = await c.req.text();
    if (raw.includes("List-Unsubscribe=One-Click")) {
      token = token || new URL(c.req.url).searchParams.get("token") || "";
    }
  }
  const subscriber = token ? await unsubscribeByToken(c.env.DB, token) : null;
  if (!subscriber) return c.html(simplePage(settings, "リンクが無効です", "配信停止用のリンクを確認してください。"), 404);
  return c.html(unsubscribePage(settings, subscriber.email, token, true));
});

app.post("/webhooks/resend", async (c) => {
  const payload = await c.req.text();
  if (!c.env.RESEND_WEBHOOK_SECRET) {
    return c.json({ ok: false, error: "webhook_secret_missing" }, 503);
  }
  const valid = await verifyResendWebhook(c.env.RESEND_WEBHOOK_SECRET, payload, c.req.raw.headers);
  if (!valid) return c.json({ ok: false }, 400);

  const event = JSON.parse(payload) as {
    type?: string;
    data?: { email_id?: string; to?: string[] };
  };
  const status = webhookEventToStatus(event.type ?? "");
  const emailId = event.data?.email_id;
  if (!status || !emailId) return c.json({ ok: true, ignored: true });

  const log = await updateSendLogByResendId(c.env.DB, emailId, status);
  if (log && status === "bounced") await markSubscriberStatus(c.env.DB, log.subscriber_id, "bounced");
  if (log && status === "complained") await markSubscriberStatus(c.env.DB, log.subscriber_id, "complained");
  return c.json({ ok: true });
});

app.get("/admin/login", async (c) => {
  if (await hasValidSession(c.env, c.req.raw)) return redirect("/admin");
  return c.html(loginPage(await loadSettings(c.env)));
});

app.post("/admin/login", async (c) => {
  const form = await c.req.parseBody();
  if (!(await verifyAdminPassword(c.env, String(form.password ?? "")))) {
    return c.html(loginPage(await loadSettings(c.env), "パスワードが違います。"), 401);
  }
  return redirect("/admin", { "Set-Cookie": await createSessionCookie(c.env, c.req.raw) });
});

app.post("/admin/logout", async (c) => {
  return redirect("/", { "Set-Cookie": clearSessionCookie() });
});

app.use("/admin", adminGuard);
app.use("/admin/*", adminGuard);

app.get("/admin", async (c) => {
  return c.html(dashboardPage(await loadSettings(c.env), await getDashboardStats(c.env.DB)));
});

app.get("/admin/lists", async (c) => {
  return c.html(
    listsPage(await loadSettings(c.env), await listLists(c.env.DB), flash(c, "ok"), flash(c, "err")),
  );
});

app.post("/admin/lists", async (c) => {
  const form = await c.req.parseBody();
  const name = String(form.name ?? "").trim();
  if (!name) return redirect("/admin/lists?err=name");
  const base = slugify(name);
  let slug = base;
  for (let i = 2; await getListBySlug(c.env.DB, slug); i++) slug = `${base}-${i}`;
  try {
    await createList(c.env.DB, { name, slug, description: String(form.description ?? "") });
  } catch {
    return redirect("/admin/lists?err=exists");
  }
  return redirect("/admin/lists?ok=created");
});

app.post("/admin/lists/:id/delete", async (c) => {
  await deleteList(c.env.DB, c.req.param("id"));
  return redirect("/admin/lists?ok=deleted");
});

app.post("/admin/lists/:id/compose", async (c) => {
  const list = await getList(c.env.DB, c.req.param("id"));
  if (!list) return redirect("/admin/lists");
  const campaign = await createCampaign(c.env.DB, {
    list_id: list.id,
    subject: `${list.name} へのお知らせ`,
    preview_text: "",
    html: `<h1>{{name}} さんへ</h1>\n<p>{{list_name}} の皆さんへの一斉配信です。</p>\n<p>本文をここに書きます。</p>`,
    text: "",
  });
  return redirect(`/admin/campaigns/${campaign.id}`);
});

app.get("/admin/subscribers", async (c) => {
  const q = c.req.query("q") ?? "";
  const group = c.req.query("group") ?? "";
  return c.html(
    subscribersPage(
      await loadSettings(c.env),
      await listLists(c.env.DB),
      await listSubscribers(c.env.DB, q, group || undefined),
      q,
      group,
      flash(c, "ok"),
      flash(c, "err"),
    ),
  );
});

app.post("/admin/subscribers", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim();
  const list = await getList(c.env.DB, String(form.list_id ?? ""));
  if (!isEmail(email) || !list) return redirect("/admin/subscribers?err=invalid");
  await upsertSubscriber(c.env.DB, { email, name: String(form.name ?? ""), listId: list.id });
  return redirect("/admin/subscribers?ok=added");
});

app.post("/admin/subscribers/import", async (c) => {
  const form = await c.req.parseBody();
  const file = form.file;
  const newGroup = String(form.new_group ?? "").trim();
  const createMissing = String(form.split_by_csv ?? "") === "1";
  let list = newGroup
    ? await getOrCreateList(c.env.DB, newGroup)
    : await getList(c.env.DB, String(form.list_id ?? ""));
  if (!list) list = await getDefaultList(c.env.DB);
  if (!list || !(file instanceof File)) return redirect("/admin/subscribers?err=import");
  const rows = parseSubscriberCsv(await file.text()).filter((row) => isEmail(row.email));
  if (rows.length === 0) return redirect("/admin/subscribers?err=empty");
  if (rows.length > 20000) return redirect("/admin/subscribers?err=too_many");
  const count = await enqueueCsvImport(c.env, rows, list.id, createMissing);
  return redirect(`/admin/subscribers?group=${list.id}&ok=imported-${count}`);
});

app.post("/admin/subscribers/:id/ungroup", async (c) => {
  const form = await c.req.parseBody();
  const listId = String(form.list_id ?? "");
  if (listId) await removeFromList(c.env.DB, c.req.param("id"), listId);
  return redirect(`/admin/subscribers?group=${listId}&ok=removed`);
});

app.post("/admin/subscribers/:id/delete", async (c) => {
  await deleteSubscriber(c.env.DB, c.req.param("id"));
  return redirect("/admin/subscribers?ok=deleted");
});

app.get("/admin/campaigns", async (c) => {
  return c.html(campaignsPage(await loadSettings(c.env), await listCampaigns(c.env.DB), flash(c, "ok")));
});

app.get("/admin/campaigns/new", async (c) => {
  const lists = await listLists(c.env.DB);
  const first = lists[0];
  return c.html(
    campaignEditorPage(
      await loadSettings(c.env),
      lists,
      null,
      undefined,
      first ? await countActiveSubscribers(c.env.DB, first.id) : 0,
    ),
  );
});

app.post("/admin/campaigns", async (c) => {
  const input = await campaignFromForm(c);
  if (!input) return redirect("/admin/campaigns/new?err=invalid");
  const campaign = await createCampaign(c.env.DB, input);
  return redirect(`/admin/campaigns/${campaign.id}?ok=saved`);
});

app.get("/admin/campaigns/:id", async (c) => {
  const campaign = await getCampaign(c.env.DB, c.req.param("id"));
  if (!campaign) return redirect("/admin/campaigns");
  return c.html(
    campaignEditorPage(
      await loadSettings(c.env),
      await listLists(c.env.DB),
      campaign,
      await getCampaignStats(c.env.DB, campaign.id),
      await countActiveSubscribers(c.env.DB, campaign.list_id),
      flash(c, "ok"),
      flash(c, "err"),
    ),
  );
});

app.post("/admin/campaigns/:id", async (c) => {
  const campaign = await getCampaign(c.env.DB, c.req.param("id"));
  if (!campaign || !["draft", "scheduled", "failed"].includes(campaign.status)) {
    return redirect(`/admin/campaigns/${c.req.param("id")}`);
  }
  const input = await campaignFromForm(c);
  if (!input) return redirect(`/admin/campaigns/${campaign.id}?err=invalid`);
  await updateCampaign(c.env.DB, campaign.id, input);
  return redirect(`/admin/campaigns/${campaign.id}?ok=saved`);
});

app.post("/admin/campaigns/:id/send", async (c) => {
  try {
    const result = await startCampaignSend(c.env, c.req.param("id"), new URL(c.req.url).origin);
    return redirect(`/admin/campaigns/${c.req.param("id")}?ok=queued-${result.queued}`);
  } catch (error) {
    console.error("send_failed", { error: String(error) });
    return redirect(`/admin/campaigns/${c.req.param("id")}?err=send`);
  }
});

app.post("/admin/campaigns/:id/test", async (c) => {
  const campaign = await getCampaign(c.env.DB, c.req.param("id"));
  const form = await c.req.parseBody();
  const to = String(form.to ?? "").trim();
  if (!campaign || !isEmail(to) || !c.env.RESEND_API_KEY) {
    return redirect(`/admin/campaigns/${c.req.param("id")}?err=test`);
  }
  const settings = await loadSettings(c.env);
  const list = await getList(c.env.DB, campaign.list_id);
  const email = renderEmail({
    settings,
    origin: new URL(c.req.url).origin,
    subscriber: { email: to, name: "テスト", unsubscribe_token: "preview" },
    subject: `[TEST] ${campaign.subject}`,
    html: campaign.html,
    text: campaign.text,
    previewText: campaign.preview_text,
    listName: list?.name ?? "",
    campaignId: campaign.id,
    logId: "test",
  });
  const result = await sendEmail(c.env.RESEND_API_KEY, email);
  return redirect(`/admin/campaigns/${campaign.id}?${result.error ? "err=test" : "ok=test"}`);
});

app.get("/admin/settings", async (c) => {
  return c.html(
    settingsPage(await loadSettings(c.env), flash(c, "ok"), `${new URL(c.req.url).origin}/webhooks/resend`),
  );
});

app.post("/admin/settings", async (c) => {
  const form = await c.req.parseBody();
  await Promise.all([
    setSetting(c.env.DB, "site_title", String(form.site_title ?? "").trim()),
    setSetting(c.env.DB, "site_tagline", String(form.site_tagline ?? "").trim()),
    setSetting(c.env.DB, "from_name", String(form.from_name ?? "").trim()),
    setSetting(c.env.DB, "from_email", String(form.from_email ?? "").trim()),
    setSetting(c.env.DB, "reply_to", String(form.reply_to ?? "").trim()),
    setSetting(c.env.DB, "postal_address", String(form.postal_address ?? "").trim()),
  ]);
  return redirect("/admin/settings?ok=saved");
});

export async function processDueCampaigns(env: Env, origin: string): Promise<void> {
  const due = await dueScheduledCampaigns(env.DB);
  for (const campaign of due) {
    try {
      await startCampaignSend(env, campaign.id, origin);
    } catch (error) {
      console.error("scheduled_send_failed", { id: campaign.id, error: String(error) });
    }
  }

  await requeueStaleBatches(env, origin);
}

async function adminGuard(c: { env: Env; req: { raw: Request; path: string } }, next: () => Promise<void>) {
  if (c.req.path === "/admin/login") {
    await next();
    return;
  }
  if (!(await hasValidSession(c.env, c.req.raw))) {
    return redirect("/admin/login");
  }
  await next();
}

function needsSetup(env: Env): boolean {
  return !env.RESEND_API_KEY || !env.ADMIN_PASSWORD;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function flash(c: { req: { query: (key: string) => string | undefined } }, key: "ok" | "err"): string | undefined {
  const value = c.req.query(key);
  if (!value) return undefined;
  const messages: Record<string, string> = {
    created: "作成しました。",
    deleted: "削除しました。",
    added: "追加しました。",
    saved: "保存しました。",
    test: "テストメールを送りました。",
    invalid: "入力内容を確認してください。",
    exists: "同じ名前のグループがあります。",
    name: "グループ名を入力してください。",
    import: "CSV を読み取れませんでした。",
    empty: "有効なメールアドレスが見つかりませんでした。",
    too_many: "一度に取り込めるのは 20,000 件までです。",
    removed: "グループから外しました。",
    send: "配信を開始できませんでした。購読者または Resend 設定を確認してください。",
    test_fail: "テスト送信に失敗しました。",
  };
  if (value.startsWith("imported-")) {
    return `${Number(value.slice("imported-".length)).toLocaleString("ja-JP")} 件を取り込みキューに入れました。グループ分けは自動で進みます。`;
  }
  if (value.startsWith("queued-")) {
    return `${Number(value.slice("queued-".length)).toLocaleString("ja-JP")} 人への配信を開始しました。バックグラウンドで順次送信します。`;
  }
  return messages[value] ?? (key === "ok" ? "完了しました。" : "エラーが発生しました。");
}

async function campaignFromForm(c: { req: { parseBody: () => Promise<Record<string, string | File>> } }) {
  const form = await c.req.parseBody();
  const subject = String(form.subject ?? "").trim();
  const html = String(form.html ?? "").trim();
  const listId = String(form.list_id ?? "");
  if (!subject || !html || !listId) return null;
  const scheduledRaw = String(form.scheduled_at ?? "").trim();
  return {
    list_id: listId,
    subject,
    preview_text: String(form.preview_text ?? "").trim(),
    html,
    text: String(form.text ?? "").trim(),
    scheduled_at: scheduledRaw ? new Date(scheduledRaw).toISOString() : null,
    status: scheduledRaw ? ("scheduled" as const) : ("draft" as const),
  };
}

