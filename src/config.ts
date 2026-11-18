// ===== 5. 設定 (.env) =====
export interface Config {
  token: string;
  clientId: string;
  guildId: string | null;
  // ポーリング間隔 (秒)。P2P API への配慮として最小 10 秒
  pollSeconds: number;
  // 状態ファイルのパス
  statePath: string;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`環境変数 ${name} が設定されていません (.env を確認してください)`);
  return v;
}

export function loadConfig(): Config {
  const pollRaw = Number(process.env.POLL_SECONDS ?? "30");
  const pollSeconds = Number.isFinite(pollRaw) ? Math.max(10, Math.floor(pollRaw)) : 30;
  const guildId = process.env.GUILD_ID?.trim();
  return {
    token: required("DISCORD_TOKEN"),
    clientId: required("CLIENT_ID"),
    guildId: guildId ? guildId : null,
    pollSeconds,
    statePath: process.env.STATE_PATH?.trim() || "data/state.json",
  };
}
