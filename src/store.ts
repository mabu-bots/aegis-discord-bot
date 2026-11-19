// ===== 3. 状態ストア (JSON ファイル) =====
// 通知先チャンネルの登録と、通知済みイベントの記録を保持する。
// 書き込みは tmp ファイル + rename で原子的（atomic）に行う。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ----- 3.1 型 -----
export interface Subscription {
  guildId: string;
  channelId: string;
  // 通知する最小震度 (P2P scale)。既定 30 = 震度3
  minScale: number;
  // 緊急地震速報を受け取るか
  eew: boolean;
  // 震度5弱以上で @everyone を付けるか
  strongMention: boolean;
}

export interface State {
  subscriptions: Subscription[];
  // 地震: id -> 通知済みの最大震度 (続報で震度が上がったら再通知するため)
  seenQuakes: Record<string, number>;
  // 津波: 通知済み id
  seenTsunamis: string[];
  // EEW: key -> 通知済みの最大推定震度 (続報で推定震度が上がったら再通知するため)。
  // 取消報のキー (末尾 "-cancel") には 1 = 通知済み / 0 = 未通知のまま見た、を記録する。
  // 旧形式 (boolean) の値は読み込み時の型検証で破棄される (古い EEW は
  // monitor 側の staleness ガードで再通知されない)。
  seenEews: Record<string, number>;
  // 初回起動時の priming (既存情報を一斉通知しない) が済んだか
  primed: boolean;
}

export function emptyState(): State {
  return { subscriptions: [], seenQuakes: {}, seenTsunamis: [], seenEews: {}, primed: false };
}

const SEEN_QUAKES_CAP = 300;
const SEEN_TSUNAMIS_CAP = 100;
const SEEN_EEWS_CAP = 300;

// ----- 3.2 読み書き -----
// 読み込んだ JSON をフィールドごとに型検証し、正しい要素だけを採用する。
// 型の崩れた要素は黙って混ぜずに落とす (壊れた値で通知判定が狂うのを防ぐ)。
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validSubscriptions(v: unknown): Subscription[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (s): s is Subscription =>
      isRecord(s) &&
      typeof s.guildId === "string" &&
      typeof s.channelId === "string" &&
      typeof s.minScale === "number" &&
      Number.isFinite(s.minScale) &&
      typeof s.eew === "boolean" &&
      typeof s.strongMention === "boolean",
  );
}

function validNumberRecord(v: unknown): Record<string, number> {
  if (!isRecord(v)) return {};
  return Object.fromEntries(
    Object.entries(v).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
}

function validStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string");
}

export function validateState(parsed: unknown): State {
  const state = emptyState();
  if (!isRecord(parsed)) return state;
  state.subscriptions = validSubscriptions(parsed.subscriptions);
  state.seenQuakes = validNumberRecord(parsed.seenQuakes);
  state.seenTsunamis = validStringArray(parsed.seenTsunamis);
  state.seenEews = validNumberRecord(parsed.seenEews);
  state.primed = parsed.primed === true;
  return state;
}

export class Store {
  private state: State;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.state = emptyState();
    if (existsSync(path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
        if (!isRecord(parsed)) throw new Error("状態ファイルの形式が不正です");
        this.state = validateState(parsed);
      } catch (err) {
        // 壊れた状態ファイルで監視を止めない: 空の状態で起動する。
        // ただし無言で上書きすると復旧不能になるため、別名へ退避してログを残す。
        const backupPath = `${path}.corrupt-${Date.now()}`;
        try {
          renameSync(path, backupPath);
          console.error(
            `状態ファイルが破損しているため ${backupPath} へ退避し、空の状態で起動します: ${err instanceof Error ? err.message : String(err)}`,
          );
        } catch {
          console.error(
            `状態ファイルの読み込みに失敗し、退避もできませんでした。空の状態で起動します: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.state = emptyState();
      }
    }
  }

  get data(): State {
    return this.state;
  }

  save(): void {
    this.trim();
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
    renameSync(tmp, this.path);
  }

  // 古い seen 記録を間引く (挿入順 = 時系列順として末尾を残す)
  private trim(): void {
    const q = Object.entries(this.state.seenQuakes);
    if (q.length > SEEN_QUAKES_CAP) {
      this.state.seenQuakes = Object.fromEntries(q.slice(q.length - SEEN_QUAKES_CAP));
    }
    if (this.state.seenTsunamis.length > SEEN_TSUNAMIS_CAP) {
      this.state.seenTsunamis = this.state.seenTsunamis.slice(-SEEN_TSUNAMIS_CAP);
    }
    const e = Object.entries(this.state.seenEews);
    if (e.length > SEEN_EEWS_CAP) {
      this.state.seenEews = Object.fromEntries(e.slice(e.length - SEEN_EEWS_CAP));
    }
  }

  // ----- 3.3 購読の操作 -----
  upsertSubscription(sub: Subscription): void {
    const i = this.state.subscriptions.findIndex(
      (s) => s.guildId === sub.guildId && s.channelId === sub.channelId,
    );
    if (i >= 0) this.state.subscriptions[i] = sub;
    else this.state.subscriptions.push(sub);
    this.save();
  }

  removeSubscription(guildId: string, channelId: string): boolean {
    const before = this.state.subscriptions.length;
    this.state.subscriptions = this.state.subscriptions.filter(
      (s) => !(s.guildId === guildId && s.channelId === channelId),
    );
    const removed = this.state.subscriptions.length !== before;
    if (removed) this.save();
    return removed;
  }

  subscriptionsForGuild(guildId: string): Subscription[] {
    return this.state.subscriptions.filter((s) => s.guildId === guildId);
  }
}
