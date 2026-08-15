import {
  countActiveSubscribers,
  createSendLogs,
  deleteQueuedLogsChunk,
  finalizeCampaign,
  getActiveSubscribersPage,
  getCampaign,
  getList,
  getSendLogsByIds,
  leftoverQueuedLogs,
  markCampaignSending,
  importSubscriberBatch,
  type SendLogRow,
  type SubscriberRow,
  updateSendLogs,
} from "./db";
import { renderEmail, ResendRateLimitError, sendBatch } from "./resend";
import { loadSettings } from "./settings";

export type FanoutJob = {
  type: "fanout";
  campaignId: string;
  origin: string;
  afterCreatedAt?: string | null;
  afterId?: string | null;
};

export type CampaignBatchJob = {
  type: "campaign_batch";
  campaignId: string;
  logIds: string[];
  origin: string;
};

export type ImportBatchJob = {
  type: "import_batch";
  defaultListId: string;
  createMissingGroups: boolean;
  rows: Array<{ email: string; name?: string; group?: string }>;
};

export type MailJob = FanoutJob | CampaignBatchJob | ImportBatchJob;

export const RESEND_BATCH_SIZE = 100;
const FANOUT_PAGE = 100;
const DELETE_CHUNK = 400;

export async function enqueueCsvImport(
  env: Env,
  rows: Array<{ email: string; name?: string; group?: string }>,
  defaultListId: string,
  createMissingGroups: boolean,
): Promise<number> {
  const messages: MessageSendRequest<ImportBatchJob>[] = [];
  for (let i = 0; i < rows.length; i += RESEND_BATCH_SIZE) {
    messages.push({
      body: {
        type: "import_batch",
        defaultListId,
        createMissingGroups,
        rows: rows.slice(i, i + RESEND_BATCH_SIZE),
      },
    });
  }
  for (let i = 0; i < messages.length; i += 100) {
    await env.MAIL_QUEUE.sendBatch(messages.slice(i, i + 100));
  }
  return rows.length;
}

export async function startCampaignSend(
  env: Env,
  campaignId: string,
  origin: string,
): Promise<{ queued: number }> {
  const campaign = await getCampaign(env.DB, campaignId);
  if (!campaign) throw new Error("キャンペーンが見つかりません");

  const queued = await countActiveSubscribers(env.DB, campaign.list_id);
  if (queued === 0) throw new Error("配信対象の購読者がいません");

  await markCampaignSending(env.DB, campaignId, queued);
  await env.MAIL_QUEUE.send({
    type: "fanout",
    campaignId,
    origin,
  } satisfies FanoutJob);

  return { queued };
}

export async function handleQueueBatch(batch: MessageBatch<MailJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (message.body.type === "fanout") {
        await processFanout(env, message.body);
      } else if (message.body.type === "campaign_batch") {
        await processCampaignBatch(env, message.body);
      } else if (message.body.type === "import_batch") {
        await importSubscriberBatch(
          env.DB,
          message.body.rows,
          message.body.defaultListId,
          message.body.createMissingGroups,
        );
      }
      message.ack();
    } catch (error) {
      if (error instanceof ResendRateLimitError) {
        console.warn("resend_rate_limited", { retryAfter: error.retryAfterSeconds });
        message.retry({ delaySeconds: error.retryAfterSeconds });
        continue;
      }
      console.error("queue_failed", { error: String(error), attempts: message.attempts });
      message.retry({ delaySeconds: Math.min(60, 2 ** Math.min(message.attempts, 5)) });
    }
  }
}

export async function processFanout(env: Env, job: FanoutJob): Promise<void> {
  const campaign = await getCampaign(env.DB, job.campaignId);
  if (!campaign || campaign.status !== "sending") return;

  if (!job.afterId) {
    const deleted = await deleteQueuedLogsChunk(env.DB, job.campaignId, DELETE_CHUNK);
    if (deleted > 0) {
      await env.MAIL_QUEUE.send({
        type: "fanout",
        campaignId: job.campaignId,
        origin: job.origin,
      } satisfies FanoutJob);
      return;
    }
  }

  const cursor = job.afterId && job.afterCreatedAt ? { createdAt: job.afterCreatedAt, id: job.afterId } : null;
  const subscribers = await getActiveSubscribersPage(env.DB, campaign.list_id, cursor, FANOUT_PAGE);
  if (subscribers.length === 0) {
    await finalizeCampaign(env.DB, job.campaignId);
    return;
  }

  const logs = await createSendLogs(env.DB, job.campaignId, subscribers);
  const queued = logs.filter((log) => log.status === "queued");
  const sendJobs: MessageSendRequest<CampaignBatchJob>[] = [];
  for (let i = 0; i < queued.length; i += RESEND_BATCH_SIZE) {
    sendJobs.push({
      body: {
        type: "campaign_batch",
        campaignId: job.campaignId,
        logIds: queued.slice(i, i + RESEND_BATCH_SIZE).map((log) => log.id),
        origin: job.origin,
      },
    });
  }
  if (sendJobs.length > 0) await env.MAIL_QUEUE.sendBatch(sendJobs);

  if (subscribers.length === FANOUT_PAGE) {
    const last = subscribers[subscribers.length - 1]!;
    await env.MAIL_QUEUE.send({
      type: "fanout",
      campaignId: job.campaignId,
      origin: job.origin,
      afterCreatedAt: last.created_at,
      afterId: last.id,
    } satisfies FanoutJob);
  } else {
    await finalizeCampaign(env.DB, job.campaignId);
  }
}

export async function processCampaignBatch(env: Env, job: CampaignBatchJob): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY が未設定です");

  const campaign = await getCampaign(env.DB, job.campaignId);
  if (!campaign) return;
  const list = await getList(env.DB, campaign.list_id);
  const settings = await loadSettings(env);
  const logs = (await getSendLogsByIds(env.DB, job.logIds)).filter((log) => log.status === "queued");
  if (logs.length === 0) {
    await finalizeCampaign(env.DB, job.campaignId);
    return;
  }

  const subscribers = await loadSubscribers(env.DB, logs);
  const prepared = logs.flatMap((log) => {
    const subscriber = subscribers.get(log.subscriber_id);
    if (!subscriber) return [];
    return [
      {
        log,
        email: renderEmail({
          settings,
          origin: job.origin,
          subscriber,
          subject: campaign.subject,
          html: campaign.html,
          text: campaign.text,
          previewText: campaign.preview_text,
          listName: list?.name ?? "",
          campaignId: campaign.id,
          logId: log.id,
          postalAddress: settings.postalAddress,
        }),
      },
    ];
  });

  const results = await sendBatch(
    env.RESEND_API_KEY,
    prepared.map((item) => item.email),
    `mailist:${job.campaignId}:${job.logIds[0]}`,
  );

  await updateSendLogs(
    env.DB,
    prepared.map((item, index) => ({
      id: item.log.id,
      resend_id: results[index]?.id ?? null,
      status: results[index]?.error ? "failed" : "sent",
      error: results[index]?.error ?? null,
    })),
  );

  await finalizeCampaign(env.DB, job.campaignId);
}

export async function requeueStaleBatches(env: Env, origin: string): Promise<void> {
  const leftover = await leftoverQueuedLogs(env.DB, new Date(Date.now() - 10 * 60 * 1000).toISOString(), 500);
  const grouped = new Map<string, string[]>();
  for (const row of leftover) {
    const ids = grouped.get(row.campaign_id) ?? [];
    ids.push(row.id);
    grouped.set(row.campaign_id, ids);
  }
  for (const [campaignId, logIds] of grouped) {
    const messages: MessageSendRequest<CampaignBatchJob>[] = [];
    for (let i = 0; i < logIds.length; i += RESEND_BATCH_SIZE) {
      messages.push({
        body: {
          type: "campaign_batch",
          campaignId,
          logIds: logIds.slice(i, i + RESEND_BATCH_SIZE),
          origin,
        },
      });
    }
    for (let i = 0; i < messages.length; i += 100) {
      await env.MAIL_QUEUE.sendBatch(messages.slice(i, i + 100));
    }
  }
}

async function loadSubscribers(
  db: D1Database,
  logs: SendLogRow[],
): Promise<Map<string, SubscriberRow>> {
  if (logs.length === 0) return new Map();
  const ids = [...new Set(logs.map((log) => log.subscriber_id))];
  const placeholders = ids.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM subscribers WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<SubscriberRow>();
  return new Map((results ?? []).map((row) => [row.id, row]));
}
