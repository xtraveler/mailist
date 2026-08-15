export type FunnelStats = {
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  failed: number;
};

export type RateCard = {
  label: string;
  percent: number;
  detail: string;
};

export function percent(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

export function formatPercent(value: number): string {
  return `${value.toLocaleString("ja-JP", { minimumFractionDigits: value % 1 ? 1 : 0, maximumFractionDigits: 1 })}%`;
}

export function rateCards(stats: FunnelStats): RateCard[] {
  const accepted = stats.sent;
  const reached = stats.delivered;
  return [
    {
      label: "到達率",
      percent: percent(reached, accepted),
      detail: `${fmt(reached)} / ${fmt(accepted)} 通が届いた`,
    },
    {
      label: "開封率",
      percent: percent(stats.opened, reached),
      detail: `${fmt(stats.opened)} / ${fmt(reached)} 通が開封`,
    },
    {
      label: "クリック率",
      percent: percent(stats.clicked, reached),
      detail: `${fmt(stats.clicked)} / ${fmt(reached)} 通がクリック`,
    },
    {
      label: "不達率",
      percent: percent(stats.bounced + stats.failed, accepted + stats.failed),
      detail: `バウンス ${fmt(stats.bounced)} · 失敗 ${fmt(stats.failed)}`,
    },
  ];
}

function fmt(value: number): string {
  return Number(value || 0).toLocaleString("ja-JP");
}
