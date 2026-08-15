import { html, raw } from "hono/html";
import type { CampaignListRow, CampaignRow, DashboardStats, ListRow, SubscriberRow } from "./db";
import { formatPercent, rateCards, type FunnelStats } from "./metrics";
import type { AppSettings } from "./settings";

type PageOptions = {
  title: string;
  settings: AppSettings;
  admin?: boolean;
  notice?: string;
  error?: string;
  refreshSeconds?: number;
};

export function layout(opts: PageOptions, body: ReturnType<typeof html>) {
  return html`<!doctype html>
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${opts.title} · ${opts.settings.siteTitle}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+JP:wght@400;500;600&family=Shippori+Mincho:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/styles.css" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        ${opts.refreshSeconds ? html`<meta http-equiv="refresh" content="${String(opts.refreshSeconds)}" />` : ""}
      </head>
      <body class="${opts.admin ? "is-admin" : "is-public"}">
        ${opts.admin ? adminHeader(opts.settings.siteTitle) : publicHeader(opts.settings.siteTitle)}
        <main class="shell">
          ${opts.notice ? html`<p class="banner banner-ok">${opts.notice}</p>` : ""}
          ${opts.error ? html`<p class="banner banner-ng">${opts.error}</p>` : ""}
          ${body}
        </main>
      </body>
    </html>`;
}

function publicHeader(title: string) {
  return html`<header class="top">
    <a class="mark" href="/">${title}</a>
    <a class="ghost" href="/admin">管理</a>
  </header>`;
}

function adminHeader(title: string) {
  return html`<header class="top">
    <a class="mark" href="/admin">${title}</a>
    <nav class="nav">
      <a href="/admin">概要</a>
      <a href="/admin/lists">グループ</a>
      <a href="/admin/subscribers">購読者</a>
      <a href="/admin/campaigns">一斉送信</a>
      <a href="/admin/settings">設定</a>
      <form method="post" action="/admin/logout">
        <button class="linkish" type="submit">退出</button>
      </form>
    </nav>
  </header>`;
}

export function landingPage(
  settings: AppSettings,
  list: ListRow | null,
  notice?: string,
  error?: string,
) {
  return layout(
    { title: "購読", settings, notice, error },
    html`<section class="hero">
      <p class="kicker">Mailist</p>
      <h1>${settings.siteTitle}</h1>
      <p class="lede">${settings.siteTagline}</p>
      <form class="card subscribe" method="post" action="/subscribe">
        <input type="hidden" name="list_id" value="${list?.id ?? ""}" />
        <label>
          メールアドレス
          <input type="email" name="email" required autocomplete="email" placeholder="you@example.com" />
        </label>
        <label>
          お名前 <span class="opt">任意</span>
          <input type="text" name="name" autocomplete="name" placeholder="山田 太郎" />
        </label>
        <button type="submit">購読する</button>
        <p class="fine">${list?.name ?? "ニュースレター"} を配信します。いつでも停止できます。</p>
      </form>
    </section>`,
  );
}

export function simplePage(settings: AppSettings, title: string, message: string) {
  return layout(
    { title, settings },
    html`<section class="hero narrow">
      <h1>${title}</h1>
      <p class="lede">${message}</p>
    </section>`,
  );
}

export function unsubscribePage(settings: AppSettings, email: string, token: string, done: boolean) {
  return layout(
    { title: "配信停止", settings },
    html`<section class="hero narrow">
      <h1>${done ? "配信を停止しました" : "配信を停止しますか？"}</h1>
      <p class="lede">${email} 宛てのメールを止めます。</p>
      ${done
        ? html`<p class="fine">また読みたくなったら、トップから再購読できます。</p>`
        : html`<form method="post" action="/unsubscribe">
            <input type="hidden" name="token" value="${token}" />
            <button type="submit">配信を停止する</button>
          </form>`}
    </section>`,
  );
}

export function setupPage() {
  const settings: AppSettings = {
    siteTitle: "Mailist",
    siteTagline: "",
    fromName: "Mailist",
    fromEmail: "",
    replyTo: "",
    postalAddress: "",
  };
  return layout(
    { title: "セットアップ", settings },
    html`<section class="hero narrow">
      <p class="kicker">あと一歩</p>
      <h1>シークレットを設定してください</h1>
      <p class="lede">デプロイは完了しています。Resend の API キーと管理パスワードを Worker Secrets に入れると使い始められます。</p>
      <pre class="code">npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ADMIN_PASSWORD</pre>
    </section>`,
  );
}

export function loginPage(settings: AppSettings, error?: string) {
  return layout(
    { title: "ログイン", settings, error },
    html`<section class="hero narrow">
      <h1>管理画面</h1>
      <form class="card" method="post" action="/admin/login">
        <label>
          パスワード
          <input type="password" name="password" required autocomplete="current-password" />
        </label>
        <button type="submit">入る</button>
      </form>
    </section>`,
  );
}

export function dashboardPage(settings: AppSettings, stats: DashboardStats) {
  return layout(
    { title: "概要", settings, admin: true },
    html`<section>
      <div class="page-head">
        <h1>今日の紙面</h1>
        <a class="button" href="/admin/campaigns/new">一斉送信</a>
      </div>
      <ol class="steps">
        <li>
          <a href="/admin/lists"><strong>1. グループ</strong></a>
          <span>VIP / 既存顧客など、送り先を分ける</span>
        </li>
        <li>
          <a href="/admin/subscribers"><strong>2. CSV取り込み</strong></a>
          <span>メール・名前・グループ列で一括登録</span>
        </li>
        <li>
          <a href="/admin/campaigns/new"><strong>3. 一斉送信</strong></a>
          <span>グループを選んで一気に配信</span>
        </li>
      </ol>
      ${rateGrid(dashboardFunnel(stats))}
      <div class="stats">
        ${stat("購読者", stats.subscribers)}
        ${stat("配信中", stats.active)}
        ${stat("キャンペーン", stats.campaigns)}
        ${stat("送信", stats.sent)}
        ${stat("到達", stats.delivered)}
        ${stat("開封", stats.opened)}
        ${stat("クリック", stats.clicked)}
        ${stat("バウンス", stats.bounced)}
      </div>
    </section>`,
  );
}

function stat(label: string, value: number) {
  return html`<article class="stat">
    <p>${label}</p>
    <strong>${Number(value || 0).toLocaleString("ja-JP")}</strong>
  </article>`;
}

function rateGrid(stats: FunnelStats) {
  return html`<div class="rates">
    ${rateCards(stats).map(
      (card) => html`<article class="rate">
        <p>${card.label}</p>
        <strong>${formatPercent(card.percent)}</strong>
        <span>${card.detail}</span>
      </article>`,
    )}
  </div>`;
}

function dashboardFunnel(stats: DashboardStats): FunnelStats {
  return {
    total: stats.sent,
    queued: 0,
    sent: stats.sent,
    delivered: stats.delivered,
    opened: stats.opened,
    clicked: stats.clicked,
    bounced: stats.bounced,
    complained: 0,
    failed: 0,
  };
}

export function listsPage(
  settings: AppSettings,
  lists: Array<ListRow & { subscribers: number }>,
  notice?: string,
  error?: string,
) {
  return layout(
    { title: "グループ", settings, admin: true, notice, error },
    html`<section>
      <div class="page-head">
        <h1>グループ</h1>
        <a class="ghost" href="/admin/subscribers">CSV を取り込む</a>
      </div>
      <div class="split">
        <form class="card" method="post" action="/admin/lists">
          <h2>新しいグループ</h2>
          <label>名前 <input name="name" required placeholder="VIP / 既存顧客 / セミナー" /></label>
          <label>説明 <input name="description" placeholder="このグループの用途" /></label>
          <button type="submit">作成</button>
        </form>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>グループ</th><th>人数</th><th></th></tr>
            </thead>
            <tbody>
              ${lists.map(
                (list) => html`<tr>
                  <td>
                    <strong>${list.name}</strong>
                    <div class="muted">${list.description ?? ""}</div>
                  </td>
                  <td>${String(list.subscribers)}</td>
                  <td class="row-actions">
                    <a href="${`/admin/subscribers?group=${list.id}`}">メンバー</a>
                    <form method="post" action="${`/admin/lists/${list.id}/compose`}">
                      <button class="linkish" type="submit">一斉送信</button>
                    </form>
                    <form method="post" action="${`/admin/lists/${list.id}/delete`}">
                      <button class="linkish danger" type="submit">削除</button>
                    </form>
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>`,
  );
}

export function subscribersPage(
  settings: AppSettings,
  lists: ListRow[],
  subscribers: Array<SubscriberRow & { lists: string }>,
  query: string,
  groupId: string,
  notice?: string,
  error?: string,
) {
  const current = lists.find((list) => list.id === groupId);
  return layout(
    { title: "購読者", settings, admin: true, notice, error },
    html`<section>
      <div class="page-head">
        <h1>${current ? current.name : "購読者"}</h1>
        <form class="search" method="get" action="/admin/subscribers">
          <select name="group">
            <option value="">すべてのグループ</option>
            ${lists.map(
              (list) =>
                html`<option value="${list.id}" ${list.id === groupId ? "selected" : ""}>${list.name}</option>`,
            )}
          </select>
          <input name="q" value="${query}" placeholder="メール / 名前" />
          <button class="ghost" type="submit">絞り込み</button>
        </form>
      </div>
      <div class="split">
        <div class="stack">
          <form class="card" method="post" action="/admin/subscribers/import" enctype="multipart/form-data">
            <h2>CSV で取り込む</h2>
            <label>入れるグループ
              <select name="list_id">
                ${lists.map(
                  (list) =>
                    html`<option value="${list.id}" ${list.id === groupId ? "selected" : ""}>${list.name}</option>`,
                )}
              </select>
            </label>
            <label>または新しいグループ <input name="new_group" placeholder="例: 2026春キャンペーン" /></label>
            <label class="check">
              <input type="checkbox" name="split_by_csv" value="1" checked />
              CSV のグループ列で振り分ける
            </label>
            <label>CSV <input type="file" name="file" accept=".csv,text/csv" required /></label>
            <p class="fine">列: <code>email,name,group</code> 。<a href="/sample-subscribers.csv">サンプルを見る</a></p>
            <button type="submit">取り込む</button>
          </form>
          <form class="card" method="post" action="/admin/subscribers">
            <h2>1件追加</h2>
            <label>メール <input type="email" name="email" required /></label>
            <label>名前 <input name="name" /></label>
            <label>グループ
              <select name="list_id">
                ${lists.map(
                  (list) =>
                    html`<option value="${list.id}" ${list.id === groupId ? "selected" : ""}>${list.name}</option>`,
                )}
              </select>
            </label>
            <button type="submit">追加</button>
          </form>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>購読者</th><th>状態</th><th>グループ</th><th></th></tr>
            </thead>
            <tbody>
              ${subscribers.map(
                (row) => html`<tr>
                  <td>
                    <strong>${row.email}</strong>
                    <div class="muted">${row.name ?? ""}</div>
                  </td>
                  <td><span class="pill ${row.status}">${row.status}</span></td>
                  <td>${row.lists}</td>
                  <td class="row-actions">
                    ${groupId
                      ? html`<form method="post" action="${`/admin/subscribers/${row.id}/ungroup`}">
                          <input type="hidden" name="list_id" value="${groupId}" />
                          <button class="linkish" type="submit">外す</button>
                        </form>`
                      : ""}
                    <form method="post" action="${`/admin/subscribers/${row.id}/delete`}">
                      <button class="linkish danger" type="submit">削除</button>
                    </form>
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>`,
  );
}

export function campaignsPage(
  settings: AppSettings,
  campaigns: CampaignListRow[],
  notice?: string,
) {
  return layout(
    { title: "一斉送信", settings, admin: true, notice },
    html`<section>
      <div class="page-head">
        <h1>一斉送信</h1>
        <a class="button" href="/admin/campaigns/new">新しい配信</a>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>件名</th>
              <th>グループ</th>
              <th>状態</th>
              <th>宛先</th>
              <th>到達率</th>
              <th>開封率</th>
              <th>クリック率</th>
            </tr>
          </thead>
          <tbody>
            ${campaigns.map((row) => {
              const cards = rateCards(row);
              return html`<tr>
                <td><a href="${`/admin/campaigns/${row.id}`}">${row.subject}</a></td>
                <td>${row.list_name}</td>
                <td><span class="pill ${row.status}">${row.status}</span></td>
                <td>${Number(row.recipients || 0).toLocaleString("ja-JP")}</td>
                <td>${row.sent ? formatPercent(cards[0]!.percent) : "—"}</td>
                <td>${row.delivered ? formatPercent(cards[1]!.percent) : "—"}</td>
                <td>${row.delivered ? formatPercent(cards[2]!.percent) : "—"}</td>
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
    </section>`,
  );
}

export function campaignEditorPage(
  settings: AppSettings,
  lists: Array<ListRow & { subscribers?: number }>,
  campaign: CampaignRow | null,
  stats?: Awaited<ReturnType<typeof import("./db").getCampaignStats>>,
  recipientCount = 0,
  notice?: string,
  error?: string,
) {
  const locked = campaign ? !["draft", "scheduled", "failed"].includes(campaign.status) : false;
  const scheduledLocal = campaign?.scheduled_at ? toLocalInput(campaign.scheduled_at) : "";
  const sending = campaign?.status === "sending";
  const watching = sending || isRecent(campaign?.sent_at, 24);
  const done = stats && campaign?.recipient_total ? Math.min(100, Math.round(((stats.sent + stats.failed) / campaign.recipient_total) * 100)) : 0;
  return layout(
    {
      title: campaign ? campaign.subject : "新しい配信",
      settings,
      admin: true,
      notice,
      error,
      refreshSeconds: watching ? (sending ? 3 : 8) : undefined,
    },
    html`<section>
      <div class="page-head">
        <h1>${campaign ? "配信を編集" : "新しい配信"}</h1>
      </div>
      ${stats && stats.total > 0
        ? html`<div class="metrics-block">
            ${rateGrid(stats)}
            <p class="fine">開封率は到達した通数に対する割合です。画像ブロック環境では実際より低く出ます。</p>
          </div>`
        : ""}
      <form class="editor" method="post" action="${campaign ? `/admin/campaigns/${campaign.id}` : "/admin/campaigns"}">
        <div class="card">
          <label>件名 <input name="subject" required value="${campaign?.subject ?? ""}" ${locked ? "readonly" : ""} /></label>
          <label>プレビュー文 <input name="preview_text" value="${campaign?.preview_text ?? ""}" ${locked ? "readonly" : ""} /></label>
          <label>送るグループ
            <select name="list_id" ${locked ? "disabled" : ""}>
              ${lists.map(
                (list) =>
                  html`<option value="${list.id}" ${campaign?.list_id === list.id ? "selected" : ""}>${`${list.name}（${Number(list.subscribers ?? 0).toLocaleString("ja-JP")}人）`}</option>`,
              )}
            </select>
          </label>
          <label>予約日時 <span class="opt">任意</span>
            <input type="datetime-local" name="scheduled_at" value="${scheduledLocal}" ${locked ? "readonly" : ""} />
          </label>
          <label>HTML
            <textarea name="html" rows="16" required ${locked ? "readonly" : ""}>${campaign?.html ?? defaultHtml()}</textarea>
          </label>
          <label>テキスト
            <textarea name="text" rows="6" ${locked ? "readonly" : ""}>${campaign?.text ?? ""}</textarea>
          </label>
          <p class="fine">使える変数: {{name}} {{email}} {{unsubscribe_url}} {{list_name}} {{preview_text}}</p>
          ${locked ? "" : html`<button type="submit">保存</button>`}
        </div>
      </form>
      ${campaign
        ? html`<div class="actions">
            ${["draft", "scheduled", "failed"].includes(campaign.status)
              ? html`<form
                  method="post"
                  action="${`/admin/campaigns/${campaign.id}/send`}"
                  data-confirm="${`${recipientCount.toLocaleString("ja-JP")}人のグループへ一斉送信します。よろしいですか？`}"
                  onsubmit="return confirm(this.dataset.confirm)"
                >
                  <button type="submit">${recipientCount.toLocaleString("ja-JP")}人に一斉送信</button>
                </form>`
              : ""}
            <form class="inline" method="post" action="${`/admin/campaigns/${campaign.id}/test`}">
              <input type="email" name="to" required placeholder="テスト送信先" />
              <button class="ghost" type="submit">テスト送信</button>
            </form>
          </div>`
        : ""}
      ${sending || stats
        ? html`<div class="progress-card">
            <p>${sending ? "配信中です。1万通規模でも Queue 経由で 100通ずつ Resend に送っています。" : "配信結果"}</p>
            <div class="bar"><span style="${`width:${done}%`}"></span></div>
            <p class="fine">${(stats?.sent ?? 0).toLocaleString("ja-JP")} / ${(campaign?.recipient_total ?? stats?.total ?? 0).toLocaleString("ja-JP")} 通 · 待機 ${(stats?.queued ?? 0).toLocaleString("ja-JP")}</p>
          </div>`
        : ""}
      ${stats
        ? html`<div class="stats compact">
            ${stat("宛先", stats.total)}
            ${stat("待機", stats.queued)}
            ${stat("送信", stats.sent)}
            ${stat("到達", stats.delivered)}
            ${stat("開封", stats.opened)}
            ${stat("クリック", stats.clicked)}
            ${stat("失敗", stats.failed + stats.bounced)}
          </div>`
        : ""}
    </section>`,
  );
}

export function settingsPage(settings: AppSettings, notice?: string, webhookUrl?: string) {
  return layout(
    { title: "設定", settings, admin: true, notice },
    html`<section class="hero narrow">
      <h1>設定</h1>
      <form class="card" method="post" action="/admin/settings">
        <label>サイト名 <input name="site_title" value="${settings.siteTitle}" required /></label>
        <label>キャッチコピー <input name="site_tagline" value="${settings.siteTagline}" /></label>
        <label>差出人名 <input name="from_name" value="${settings.fromName}" required /></label>
        <label>差出人メール <input type="email" name="from_email" value="${settings.fromEmail}" required /></label>
        <label>Reply-To <span class="opt">任意</span> <input type="email" name="reply_to" value="${settings.replyTo}" /></label>
        <label>事業者住所 <span class="opt">マーケ配信向け</span> <input name="postal_address" value="${settings.postalAddress}" placeholder="東京都…" /></label>
        <p class="fine">Resend で検証済みのドメインから送ってください。開発中は <code>onboarding@resend.dev</code> が使えます。住所は配信停止リンクと一緒にフッターへ入ります。</p>
        <button type="submit">保存</button>
      </form>
      ${webhookUrl
        ? html`<div class="card" style="margin-top:20px">
            <h2>開封・クリック計測</h2>
            <p class="fine">Resend の Webhooks にこの URL を登録し、email.delivered / email.opened / email.clicked / email.bounced を有効にしてください。Signing Secret は <code>RESEND_WEBHOOK_SECRET</code> に入れます。</p>
            <pre class="code">${webhookUrl}</pre>
          </div>`
        : ""}
    </section>`,
  );
}

function defaultHtml() {
  return `<h1>{{name}} さんへ</h1>
<p>{{preview_text}}</p>
<p>本文をここに書きます。</p>`;
}

function isRecent(iso: string | null | undefined, hours: number): boolean {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  return Number.isFinite(time) && Date.now() - time < hours * 60 * 60 * 1000;
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export { raw };
