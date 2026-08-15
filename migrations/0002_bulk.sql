ALTER TABLE campaigns ADD COLUMN recipient_total INTEGER;

CREATE INDEX IF NOT EXISTS idx_list_subscribers_list ON list_subscribers(list_id, subscriber_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_status_created ON subscribers(status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_send_logs_campaign_status ON send_logs(campaign_id, status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_send_logs_campaign_subscriber ON send_logs(campaign_id, subscriber_id);
