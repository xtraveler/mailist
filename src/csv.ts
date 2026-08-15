export type CsvRow = {
  email: string;
  name: string;
  group: string;
};

const EMAIL_KEYS = new Set(["email", "mail", "e-mail", "メール", "メールアドレス"]);
const NAME_KEYS = new Set(["name", "名前", "氏名", "お名前"]);
const GROUP_KEYS = new Set(["group", "グループ", "list", "リスト", "tag", "タグ"]);

export function parseSubscriberCsv(text: string): CsvRow[] {
  const lines = splitRecords(text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
  if (lines.length === 0) return [];

  const header = lines[0] ?? [];
  const mapped = detectColumns(header);
  const start = mapped ? 1 : 0;
  const rows: CsvRow[] = [];

  for (const cells of lines.slice(start)) {
    const email = (mapped ? cells[mapped.email] : cells[0])?.trim().toLowerCase() ?? "";
    if (!email || !email.includes("@")) continue;
    rows.push({
      email,
      name: (mapped && mapped.name >= 0 ? cells[mapped.name] : cells[1])?.trim() ?? "",
      group: (mapped && mapped.group >= 0 ? cells[mapped.group] : cells[2])?.trim() ?? "",
    });
  }
  return rows;
}

function detectColumns(header: string[]): { email: number; name: number; group: number } | null {
  const normalized = header.map((cell) => cell.trim().toLowerCase());
  const email = normalized.findIndex((cell) => EMAIL_KEYS.has(cell));
  if (email < 0) return null;
  return {
    email,
    name: normalized.findIndex((cell) => NAME_KEYS.has(cell)),
    group: normalized.findIndex((cell) => GROUP_KEYS.has(cell)),
  };
}

function splitRecords(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === "," || char === "\t") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}
