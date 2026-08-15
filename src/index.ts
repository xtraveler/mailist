import { getSetting } from "./db";
import { handleQueueBatch, type MailJob } from "./queue";
import { app, processDueCampaigns } from "./routes";
import { ensureSchema } from "./schema";

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    await ensureSchema(env.DB);
    await handleQueueBatch(batch as MessageBatch<MailJob>, env);
  },
  async scheduled(_event, env) {
    await ensureSchema(env.DB);
    const origin =
      (await getSetting(env.DB, "public_origin")) || "https://mailist.workers.dev";
    await processDueCampaigns(env, origin);
  },
} satisfies ExportedHandler<Env>;
