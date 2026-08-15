import { nowIso, randomId } from "./crypto";
import { slugify } from "./slug";

export type SubscriberStatus = "active" | "unsubscribed" | "bounced" | "complained";
export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "failed";
export type SendStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "complained"
  | "failed";

export type ListRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
};

export type SubscriberRow = {
  id: string;
  email: string;
  name: string | null;
  status: SubscriberStatus;
  unsubscribe_token: string;
  created_at: string;
  updated_at: string;
};

export type CampaignRow = {
  id: string;
  list_id: string;
  subject: string;
  preview_text: string | null;
  html: string;
  text: string | null;
  status: CampaignStatus;
  scheduled_at: string | null;
  sent_at: string | null;
  recipient_total: number | null;
  created_at: string;
  updated_at: string;
};

export type SendLogRow = {
  id: string;
  campaign_id: string;
  subscriber_id: string;
  email: string;
  resend_id: string | null;
  status: SendStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type DashboardStats = {
  subscribers: number;
  active: number;
  campaigns: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
};

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{
    value: string;
  }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value)
    .run();
}

export async function listSettings(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{
    key: string;
    value: string;
  }>();
  return Object.fromEntries((results ?? []).map((row) => [row.key, row.value]));
}

export async function listLists(db: D1Database): Promise<(ListRow & { subscribers: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT lists.*, COUNT(list_subscribers.subscriber_id) AS subscribers
       FROM lists
       LEFT JOIN list_subscribers ON list_subscribers.list_id = lists.id
       GROUP BY lists.id
       ORDER BY lists.created_at ASC`,
    )
    .all<ListRow & { subscribers: number }>();
  return results ?? [];
}

export async function getList(db: D1Database, id: string): Promise<ListRow | null> {
  return db.prepare("SELECT * FROM lists WHERE id = ?").bind(id).first<ListRow>();
}

export async function getDefaultList(db: D1Database): Promise<ListRow | null> {
  return db.prepare("SELECT * FROM lists ORDER BY created_at ASC LIMIT 1").first<ListRow>();
}

export async function getListByName(db: D1Database, name: string): Promise<ListRow | null> {
  return db
    .prepare("SELECT * FROM lists WHERE name = ? COLLATE NOCASE OR slug = ?")
    .bind(name, slugify(name))
    .first<ListRow>();
}

export async function getListBySlug(db: D1Database, slug: string): Promise<ListRow | null> {
  return db.prepare("SELECT * FROM lists WHERE slug = ?").bind(slug).first<ListRow>();
}

export async function getOrCreateList(db: D1Database, name: string): Promise<ListRow> {
  const existing = await getListByName(db, name);
  if (existing) return existing;
  const base = slugify(name);
  let slug = base;
  for (let i = 2; await getListBySlug(db, slug); i++) slug = `${base}-${i}`;
  return createList(db, { name, slug, description: "" });
}

export async function createList(
  db: D1Database,
  input: { name: string; slug: string; description?: string },
): Promise<ListRow> {
  const row: ListRow = {
    id: randomId(),
    name: input.name,
    slug: input.slug,
    description: input.description ?? null,
    created_at: nowIso(),
  };
  await db
    .prepare("INSERT INTO lists (id, name, slug, description, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, row.name, row.slug, row.description, row.created_at)
    .run();
  return row;
}

export async function deleteList(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM list_subscribers WHERE list_id = ?").bind(id),
    db.prepare("DELETE FROM lists WHERE id = ?").bind(id),
  ]);
}

export async function getDashboardStats(db: D1Database): Promise<DashboardStats> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM subscribers) AS subscribers,
        (SELECT COUNT(*) FROM subscribers WHERE status = 'active') AS active,
        (SELECT COUNT(*) FROM campaigns) AS campaigns,
        (SELECT COUNT(*) FROM send_logs WHERE status IN ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained')) AS sent,
        (SELECT COUNT(*) FROM send_logs WHERE status IN ('delivered', 'opened', 'clicked')) AS delivered,
        (SELECT COUNT(*) FROM send_logs WHERE status IN ('opened', 'clicked')) AS opened,
        (SELECT COUNT(*) FROM send_logs WHERE status = 'clicked') AS clicked,
        (SELECT COUNT(*) FROM send_logs WHERE status = 'bounced') AS bounced`,
    )
    .first<DashboardStats>();
  return (
    row ?? {
      subscribers: 0,
      active: 0,
      campaigns: 0,
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
    }
  );
}

export async function listSubscribers(
  db: D1Database,
  query?: string,
  listId?: string,
): Promise<(SubscriberRow & { lists: string })[]> {
  const like = query ? `%${query}%` : null;
  const clauses = [];
  const binds: Array<string> = [];
  if (like) {
    clauses.push("(subscribers.email LIKE ? OR subscribers.name LIKE ?)");
    binds.push(like, like);
  }
  if (listId) {
    clauses.push(
      "subscribers.id IN (SELECT subscriber_id FROM list_subscribers WHERE list_id = ?)",
    );
    binds.push(listId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await db
    .prepare(
      `SELECT subscribers.*,
        COALESCE(GROUP_CONCAT(lists.name, ', '), '') AS lists
       FROM subscribers
       LEFT JOIN list_subscribers ON list_subscribers.subscriber_id = subscribers.id
       LEFT JOIN lists ON lists.id = list_subscribers.list_id
       ${where}
       GROUP BY subscribers.id
       ORDER BY subscribers.created_at DESC
       LIMIT 500`,
    )
    .bind(...binds)
    .all<SubscriberRow & { lists: string }>();
  return results ?? [];
}

export async function removeFromList(db: D1Database, subscriberId: string, listId: string): Promise<void> {
  await db
    .prepare("DELETE FROM list_subscribers WHERE subscriber_id = ? AND list_id = ?")
    .bind(subscriberId, listId)
    .run();
}

export async function importSubscriberBatch(
  db: D1Database,
  rows: Array<{ email: string; name?: string; group?: string }>,
  defaultListId: string,
  createMissingGroups: boolean,
): Promise<number> {
  if (rows.length === 0) return 0;
  const listCache = new Map<string, string>();
  const resolveList = async (group?: string) => {
    const name = group?.trim();
    if (!name) return defaultListId;
    const key = name.toLowerCase();
    const cached = listCache.get(key);
    if (cached) return cached;
    const existing = await getListByName(db, name);
    if (existing) {
      listCache.set(key, existing.id);
      return existing.id;
    }
    if (!createMissingGroups) return defaultListId;
    const created = await getOrCreateList(db, name);
    listCache.set(key, created.id);
    return created.id;
  };

  const emails = [...new Set(rows.map((row) => row.email.trim().toLowerCase()).filter(Boolean))];
  const existing = new Map<string, SubscriberRow>();
  for (let i = 0; i < emails.length; i += 90) {
    const chunk = emails.slice(i, i + 90);
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT * FROM subscribers WHERE email IN (${placeholders})`)
      .bind(...chunk)
      .all<SubscriberRow>();
    for (const row of results ?? []) existing.set(row.email, row);
  }

  const timestamp = nowIso();
  const inserts: SubscriberRow[] = [];
  const memberships: Array<{ listId: string; subscriberId: string }> = [];
  const nameUpdates: Array<{ id: string; name: string }> = [];

  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!email) continue;
    const listId = await resolveList(row.group);
    let subscriber = existing.get(email);
    if (!subscriber) {
      subscriber = {
        id: randomId(),
        email,
        name: row.name?.trim() || null,
        status: "active",
        unsubscribe_token: randomId(),
        created_at: timestamp,
        updated_at: timestamp,
      };
      existing.set(email, subscriber);
      inserts.push(subscriber);
    } else if (row.name?.trim() && row.name.trim() !== subscriber.name) {
      nameUpdates.push({ id: subscriber.id, name: row.name.trim() });
    }
    memberships.push({ listId, subscriberId: subscriber.id });
  }

  const statements = [];
  for (let i = 0; i < inserts.length; i += 10) {
    const chunk = inserts.slice(i, i + 10);
    const sql = `INSERT OR IGNORE INTO subscribers
      (id, email, name, status, unsubscribe_token, created_at, updated_at)
      VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}`;
    statements.push(
      db.prepare(sql).bind(
        ...chunk.flatMap((row) => [
          row.id,
          row.email,
          row.name,
          row.status,
          row.unsubscribe_token,
          row.created_at,
          row.updated_at,
        ]),
      ),
    );
  }
  for (const update of nameUpdates) {
    statements.push(
      db.prepare("UPDATE subscribers SET name = ?, updated_at = ? WHERE id = ?").bind(update.name, timestamp, update.id),
    );
  }
  for (let i = 0; i < memberships.length; i += 20) {
    const chunk = memberships.slice(i, i + 20);
    const sql = `INSERT OR IGNORE INTO list_subscribers (list_id, subscriber_id, created_at)
      VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`;
    statements.push(
      db.prepare(sql).bind(...chunk.flatMap((row) => [row.listId, row.subscriberId, timestamp])),
    );
  }
  if (statements.length) await db.batch(statements);
  return rows.length;
}

export async function getSubscriberByEmail(
  db: D1Database,
  email: string,
): Promise<SubscriberRow | null> {
  return db.prepare("SELECT * FROM subscribers WHERE email = ?").bind(email).first<SubscriberRow>();
}

export async function getSubscriberByToken(
  db: D1Database,
  token: string,
): Promise<SubscriberRow | null> {
  return db
    .prepare("SELECT * FROM subscribers WHERE unsubscribe_token = ?")
    .bind(token)
    .first<SubscriberRow>();
}

export async function upsertSubscriber(
  db: D1Database,
  input: { email: string; name?: string; listId: string },
): Promise<{ subscriber: SubscriberRow; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const existing = await getSubscriberByEmail(db, email);
  const timestamp = nowIso();

  if (existing) {
    const nextName = input.name?.trim() || existing.name;
    const nextStatus = existing.status === "unsubscribed" ? "active" : existing.status;
    await db
      .prepare("UPDATE subscribers SET name = ?, status = ?, updated_at = ? WHERE id = ?")
      .bind(nextName, nextStatus, timestamp, existing.id)
      .run();
    await db
      .prepare(
        "INSERT OR IGNORE INTO list_subscribers (list_id, subscriber_id, created_at) VALUES (?, ?, ?)",
      )
      .bind(input.listId, existing.id, timestamp)
      .run();
    return {
      subscriber: { ...existing, name: nextName, status: nextStatus, updated_at: timestamp },
      created: false,
    };
  }

  const subscriber: SubscriberRow = {
    id: randomId(),
    email,
    name: input.name?.trim() || null,
    status: "active",
    unsubscribe_token: randomId(),
    created_at: timestamp,
    updated_at: timestamp,
  };
  await db.batch([
    db
      .prepare(
        "INSERT INTO subscribers (id, email, name, status, unsubscribe_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        subscriber.id,
        subscriber.email,
        subscriber.name,
        subscriber.status,
        subscriber.unsubscribe_token,
        subscriber.created_at,
        subscriber.updated_at,
      ),
    db
      .prepare(
        "INSERT INTO list_subscribers (list_id, subscriber_id, created_at) VALUES (?, ?, ?)",
      )
      .bind(input.listId, subscriber.id, timestamp),
  ]);
  return { subscriber, created: true };
}

export async function deleteSubscriber(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM list_subscribers WHERE subscriber_id = ?").bind(id),
    db.prepare("DELETE FROM subscribers WHERE id = ?").bind(id),
  ]);
}

export async function unsubscribeByToken(db: D1Database, token: string): Promise<SubscriberRow | null> {
  const subscriber = await getSubscriberByToken(db, token);
  if (!subscriber) return null;
  const timestamp = nowIso();
  await db
    .prepare("UPDATE subscribers SET status = 'unsubscribed', updated_at = ? WHERE id = ?")
    .bind(timestamp, subscriber.id)
    .run();
  return { ...subscriber, status: "unsubscribed", updated_at: timestamp };
}

export type CampaignListRow = CampaignRow & {
  list_name: string;
  recipients: number;
  queued: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  failed: number;
  total: number;
};

export async function listCampaigns(db: D1Database): Promise<CampaignListRow[]> {
  const { results } = await db
    .prepare(
      `SELECT campaigns.*, lists.name AS list_name,
        COUNT(send_logs.id) AS total,
        COUNT(send_logs.id) AS recipients,
        SUM(CASE WHEN send_logs.status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN send_logs.status IN ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained') THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN send_logs.status IN ('delivered', 'opened', 'clicked') THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN send_logs.status IN ('opened', 'clicked') THEN 1 ELSE 0 END) AS opened,
        SUM(CASE WHEN send_logs.status = 'clicked' THEN 1 ELSE 0 END) AS clicked,
        SUM(CASE WHEN send_logs.status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
        SUM(CASE WHEN send_logs.status = 'complained' THEN 1 ELSE 0 END) AS complained,
        SUM(CASE WHEN send_logs.status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM campaigns
       JOIN lists ON lists.id = campaigns.list_id
       LEFT JOIN send_logs ON send_logs.campaign_id = campaigns.id
       GROUP BY campaigns.id
       ORDER BY campaigns.created_at DESC
       LIMIT 100`,
    )
    .all<CampaignListRow>();
  return results ?? [];
}

export async function getCampaign(db: D1Database, id: string): Promise<CampaignRow | null> {
  return db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<CampaignRow>();
}

export async function createCampaign(
  db: D1Database,
  input: {
    list_id: string;
    subject: string;
    preview_text?: string;
    html: string;
    text?: string;
    scheduled_at?: string | null;
  },
): Promise<CampaignRow> {
  const timestamp = nowIso();
  const row: CampaignRow = {
    id: randomId(),
    list_id: input.list_id,
    subject: input.subject,
    preview_text: input.preview_text ?? null,
    html: input.html,
    text: input.text ?? null,
    status: input.scheduled_at ? "scheduled" : "draft",
    scheduled_at: input.scheduled_at ?? null,
    sent_at: null,
    recipient_total: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await db
    .prepare(
      `INSERT INTO campaigns
        (id, list_id, subject, preview_text, html, text, status, scheduled_at, sent_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.list_id,
      row.subject,
      row.preview_text,
      row.html,
      row.text,
      row.status,
      row.scheduled_at,
      row.sent_at,
      row.created_at,
      row.updated_at,
    )
    .run();
  return row;
}

export async function updateCampaign(
  db: D1Database,
  id: string,
  input: {
    list_id: string;
    subject: string;
    preview_text?: string;
    html: string;
    text?: string;
    scheduled_at?: string | null;
    status?: CampaignStatus;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE campaigns
       SET list_id = ?, subject = ?, preview_text = ?, html = ?, text = ?,
           scheduled_at = ?, status = COALESCE(?, status), updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.list_id,
      input.subject,
      input.preview_text ?? null,
      input.html,
      input.text ?? null,
      input.scheduled_at ?? null,
      input.status ?? null,
      nowIso(),
      id,
    )
    .run();
}

export async function countActiveSubscribers(db: D1Database, listId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM subscribers
       JOIN list_subscribers ON list_subscribers.subscriber_id = subscribers.id
       WHERE list_subscribers.list_id = ? AND subscribers.status = 'active'`,
    )
    .bind(listId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function getActiveSubscribersPage(
  db: D1Database,
  listId: string,
  cursor: { createdAt: string; id: string } | null,
  limit: number,
): Promise<SubscriberRow[]> {
  const statement = cursor
    ? db
        .prepare(
          `SELECT subscribers.*
           FROM subscribers
           JOIN list_subscribers ON list_subscribers.subscriber_id = subscribers.id
           WHERE list_subscribers.list_id = ?
             AND subscribers.status = 'active'
             AND (subscribers.created_at > ? OR (subscribers.created_at = ? AND subscribers.id > ?))
           ORDER BY subscribers.created_at ASC, subscribers.id ASC
           LIMIT ?`,
        )
        .bind(listId, cursor.createdAt, cursor.createdAt, cursor.id, limit)
    : db
        .prepare(
          `SELECT subscribers.*
           FROM subscribers
           JOIN list_subscribers ON list_subscribers.subscriber_id = subscribers.id
           WHERE list_subscribers.list_id = ? AND subscribers.status = 'active'
           ORDER BY subscribers.created_at ASC, subscribers.id ASC
           LIMIT ?`,
        )
        .bind(listId, limit);
  const { results } = await statement.all<SubscriberRow>();
  return results ?? [];
}

export async function createSendLogs(
  db: D1Database,
  campaignId: string,
  subscribers: SubscriberRow[],
): Promise<SendLogRow[]> {
  if (subscribers.length === 0) return [];
  const timestamp = nowIso();
  const logs: SendLogRow[] = subscribers.map((subscriber) => ({
    id: randomId(),
    campaign_id: campaignId,
    subscriber_id: subscriber.id,
    email: subscriber.email,
    resend_id: null,
    status: "queued",
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
  }));

  const rowSql =
    "(?, ?, ?, ?, ?, ?, ?, ?, ?)";
  const statements = [];
  for (let i = 0; i < logs.length; i += 10) {
    const chunk = logs.slice(i, i + 10);
    const sql = `INSERT OR IGNORE INTO send_logs
      (id, campaign_id, subscriber_id, email, resend_id, status, error, created_at, updated_at)
      VALUES ${chunk.map(() => rowSql).join(", ")}`;
    const binds = chunk.flatMap((log) => [
      log.id,
      log.campaign_id,
      log.subscriber_id,
      log.email,
      log.resend_id,
      log.status,
      log.error,
      log.created_at,
      log.updated_at,
    ]);
    statements.push(db.prepare(sql).bind(...binds));
  }
  await db.batch(statements);

  const found: SendLogRow[] = [];
  const ids = subscribers.map((row) => row.id);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(
        `SELECT * FROM send_logs WHERE campaign_id = ? AND subscriber_id IN (${placeholders})`,
      )
      .bind(campaignId, ...chunk)
      .all<SendLogRow>();
    found.push(...(results ?? []));
  }
  return found;
}

export async function deleteQueuedLogsChunk(
  db: D1Database,
  campaignId: string,
  limit: number,
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM send_logs
       WHERE id IN (
         SELECT id FROM send_logs
         WHERE campaign_id = ? AND status IN ('queued', 'failed')
         LIMIT ?
       )`,
    )
    .bind(campaignId, limit)
    .run();
  return result.meta.changes ?? 0;
}

export async function leftoverQueuedLogs(
  db: D1Database,
  olderThanIso: string,
  limit: number,
): Promise<Array<{ campaign_id: string; id: string }>> {
  const { results } = await db
    .prepare(
      `SELECT campaign_id, id FROM send_logs
       WHERE status = 'queued'
         AND updated_at <= ?
         AND campaign_id IN (SELECT id FROM campaigns WHERE status = 'sending')
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .bind(olderThanIso, limit)
    .all<{ campaign_id: string; id: string }>();
  return results ?? [];
}

export async function getSendLogsByIds(db: D1Database, ids: string[]): Promise<SendLogRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM send_logs WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<SendLogRow>();
  return results ?? [];
}

export async function updateSendLog(
  db: D1Database,
  id: string,
  patch: { resend_id?: string | null; status: SendStatus; error?: string | null },
): Promise<void> {
  await db
    .prepare(
      "UPDATE send_logs SET resend_id = COALESCE(?, resend_id), status = ?, error = ?, updated_at = ? WHERE id = ?",
    )
    .bind(patch.resend_id ?? null, patch.status, patch.error ?? null, nowIso(), id)
    .run();
}

export async function updateSendLogByResendId(
  db: D1Database,
  resendId: string,
  status: SendStatus,
): Promise<SendLogRow | null> {
  const log = await db
    .prepare("SELECT * FROM send_logs WHERE resend_id = ?")
    .bind(resendId)
    .first<SendLogRow>();
  if (!log) return null;
  if (!shouldAdvanceStatus(log.status, status)) return log;
  await db
    .prepare("UPDATE send_logs SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, nowIso(), log.id)
    .run();
  return { ...log, status };
}

const STATUS_RANK: Record<SendStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
  failed: 10,
  bounced: 10,
  complained: 10,
};

function shouldAdvanceStatus(current: SendStatus, next: SendStatus): boolean {
  if (current === next) return false;
  if (STATUS_RANK[next] >= 10) return true;
  if (STATUS_RANK[current] >= 10) return false;
  return STATUS_RANK[next] > STATUS_RANK[current];
}

export async function markSubscriberStatus(
  db: D1Database,
  subscriberId: string,
  status: SubscriberStatus,
): Promise<void> {
  await db
    .prepare("UPDATE subscribers SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, nowIso(), subscriberId)
    .run();
}

export async function getCampaignStats(db: D1Database, campaignId: string) {
  const row = await db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status IN ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained') THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status IN ('delivered', 'opened', 'clicked') THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status IN ('opened', 'clicked') THEN 1 ELSE 0 END) AS opened,
        SUM(CASE WHEN status = 'clicked' THEN 1 ELSE 0 END) AS clicked,
        SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
        SUM(CASE WHEN status = 'complained' THEN 1 ELSE 0 END) AS complained,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM send_logs
       WHERE campaign_id = ?`,
    )
    .bind(campaignId)
    .first<{
      total: number;
      queued: number;
      sent: number;
      delivered: number;
      opened: number;
      clicked: number;
      bounced: number;
      complained: number;
      failed: number;
    }>();
  return (
    row ?? {
      total: 0,
      queued: 0,
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
      failed: 0,
    }
  );
}

export async function dueScheduledCampaigns(db: D1Database): Promise<CampaignRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?",
    )
    .bind(nowIso())
    .all<CampaignRow>();
  return results ?? [];
}

export async function markCampaignSending(
  db: D1Database,
  id: string,
  recipientTotal: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE campaigns SET status = 'sending', recipient_total = ?, updated_at = ? WHERE id = ?",
    )
    .bind(recipientTotal, nowIso(), id)
    .run();
}

export async function updateSendLogs(
  db: D1Database,
  updates: Array<{ id: string; resend_id?: string | null; status: SendStatus; error?: string | null }>,
): Promise<void> {
  if (updates.length === 0) return;
  const timestamp = nowIso();
  await db.batch(
    updates.map((patch) =>
      db
        .prepare(
          "UPDATE send_logs SET resend_id = COALESCE(?, resend_id), status = ?, error = ?, updated_at = ? WHERE id = ?",
        )
        .bind(patch.resend_id ?? null, patch.status, patch.error ?? null, timestamp, patch.id),
    ),
  );
}

export async function finalizeCampaign(db: D1Database, id: string): Promise<void> {
  const remaining = await db
    .prepare("SELECT COUNT(*) AS count FROM send_logs WHERE campaign_id = ? AND status = 'queued'")
    .bind(id)
    .first<{ count: number }>();
  if ((remaining?.count ?? 0) > 0) return;

  const failed = await db
    .prepare("SELECT COUNT(*) AS count FROM send_logs WHERE campaign_id = ? AND status = 'failed'")
    .bind(id)
    .first<{ count: number }>();
  const total = await db
    .prepare("SELECT COUNT(*) AS count FROM send_logs WHERE campaign_id = ?")
    .bind(id)
    .first<{ count: number }>();

  const status: CampaignStatus =
    (total?.count ?? 0) > 0 && (failed?.count ?? 0) === (total?.count ?? 0) ? "failed" : "sent";

  await db
    .prepare("UPDATE campaigns SET status = ?, sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?")
    .bind(status, nowIso(), nowIso(), id)
    .run();
}
