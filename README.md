# Mailist

Cloudflare Workers 上で動く、Resend API 連携のメール配信システムです。購読フォーム、リスト管理、キャンペーン配信、到達・開封の記録までを一箇所にまとめています。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Mitologieinc/Mailist)

## ワンタップでデプロイ

上のボタンを押すと、Cloudflare がリポジトリをフォークし、D1 と Queue を自動作成して Worker を公開します。セットアップ画面で次のシークレットを入れてください。

| シークレット | 必須 | 内容 |
|---|---|---|
| `RESEND_API_KEY` | 必須 | [Resend の API キー](https://resend.com/api-keys)（`re_` で始まる） |
| `ADMIN_PASSWORD` | 必須 | `/admin` に入るパスワード |
| `SESSION_SECRET` | 任意 | 未設定なら管理パスワードから導出。推奨: `openssl rand -hex 32` |
| `RESEND_WEBHOOK_SECRET` | 任意 | Resend Webhook の Signing Secret（`whsec_`） |

CLI から出す場合:

```bash
npm install
npx wrangler login
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```

デプロイ後の URL は `https://mailist.<あなたのサブドメイン>.workers.dev` です。

## 使い方

1. **グループ** で送り先を分ける（VIP、既存顧客、セミナーなど）
2. **購読者** から CSV を取り込む。列は `email,name,group`
3. グループの「一斉送信」か、配信画面でグループを選んで送る

[サンプル CSV](public/sample-subscribers.csv) をそのまま使えます。`group` 列があれば、その名前のグループを自動作成して振り分けます。

## できること

- 公開購読ページと RFC 8058 のワンクリック配信停止
- グループ分け（VIP / 既存顧客など）と、グループ単位の一斉送信
- CSV 取り込み（`email,name,group`）。グループ列があれば自動で振り分け
- HTML キャンペーンの下書き、予約配信、テスト送信
- **1万通規模のマーケ配信**: 購読者を 100 件ずつ Queue に載せ、Resend batch（100通/1リクエスト）で送信
- Resend の 10req/s 制限に合わせた並列度（同時 2）と 429 時の自動リトライ
- 同じ画面で到達率・開封率・クリック率を計測（Resend Webhook）
- 配信停止リンクと事業者住所フッター（CAN-SPAM 向け）
- `POST /api/subscribe` で外部サイトから購読登録

本文では `{{name}}` `{{email}}` `{{unsubscribe_url}}` `{{list_name}}` `{{preview_text}}` が使えます。

## 初回の Resend 設定

1. [Resend](https://resend.com) で API キーを発行する
2. 本番送信するならドメインを検証し、管理画面の「設定」で差出人アドレスを合わせる
3. 開発中は `onboarding@resend.dev` から、自分のメール宛に送れます
4. 到達イベントを取る場合は Resend の Webhook 先を `https://<あなたのWorker>/webhooks/resend` にし、イベントに `email.sent` `email.delivered` `email.opened` `email.clicked` `email.bounced` `email.complained` `email.failed` を選ぶ

## ローカル開発

```bash
cp .dev.vars.example .dev.vars
# .dev.vars に RESEND_API_KEY と ADMIN_PASSWORD を書く
npm install
npm run dev
```

http://localhost:8787 が購読ページ、`/admin` が管理画面です。

## 1万通のマーケ配信

管理画面で配信を押すと、HTTP リクエスト内では件数確認だけ行い、実送信は Queue が担います。

1. 購読者を 100 人ずつページングして `send_logs` に書く
2. 100 通を 1 回の Resend batch API で送る（1リクエスト = 最大 100通）
3. 同時実行は 2 本に抑え、デフォルトの **10リクエスト/秒** を超えない
4. 429 が返ったら `Retry-After` だけ待って再送する
5. 画面は 3 秒ごとに進捗を更新する

目安: 10,000通 ≒ batch 100回。Resend 側のレート内なら数十秒〜数分でキュー消化できます。日次・月次の送信枠は [Resend のプラン](https://resend.com/settings/billing) 側の制限です。

配信前に「設定」へ事業者住所を入れておくと、フッターに住所と配信停止リンクが付きます。バウンス・苦情のアドレスは自動で配信対象から外れます。

## 構成

- **Workers** — Hono の SSR 管理画面と API
- **D1** — 購読者・リスト・キャンペーン・配信ログ
- **Queues** — Resend へのバッチ送信
- **Cron** — 5 分ごとに予約配信を処理
- **Resend** — 実際のメール配送
