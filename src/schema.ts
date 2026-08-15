import { nowIso, randomId } from "./crypto";

export async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS lists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS subscribers (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL COLLATE NOCASE,
        name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        unsubscribe_token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email)
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS list_subscribers (
        list_id TEXT NOT NULL,
        subscriber_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (list_id, subscriber_id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        preview_text TEXT,
        html TEXT NOT NULL,
        text TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        scheduled_at TEXT,
        sent_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS send_logs (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        subscriber_id TEXT NOT NULL,
        email TEXT NOT NULL,
        resend_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_send_logs_resend ON send_logs(resend_id)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_send_logs_campaign ON send_logs(campaign_id)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_send_logs_status ON send_logs(status)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_list_subscribers_list ON list_subscribers(list_id, subscriber_id)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_subscribers_status_created ON subscribers(status, created_at, id)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_send_logs_campaign_status ON send_logs(campaign_id, status, updated_at)
    `),
  ]);

  await addColumnIfMissing(db, "campaigns", "recipient_total", "INTEGER");
  try {
    await db
      .prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_send_logs_campaign_subscriber ON send_logs(campaign_id, subscriber_id)",
      )
      .run();
  } catch (error) {
    console.warn("unique_index_skipped", { error: String(error) });
  }

  const existing = await db.prepare("SELECT id FROM lists LIMIT 1").first<{ id: string }>();
  if (!existing) {
    const createdAt = nowIso();
    await db
      .prepare(
        "INSERT INTO lists (id, name, slug, description, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        randomId(),
        "ニュースレター",
        "newsletter",
        "サイトからのお知らせと新着情報",
        createdAt,
      )
      .run();
  }
}

async function addColumnIfMissing(
  db: D1Database,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if ((results ?? []).some((row) => row.name === column)) return;
  await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
}
