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
  // EEW: key -> 通知したかどうか (取消報は「通知済みの速報」に対してだけ送る)
  seenEews: Record<string, boolean>;
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
export class Store {
  private state: State;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.state = emptyState();
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        if (parsed && typeof parsed === "object") {
          this.state = { ...emptyState(), ...parsed };
        }
      } catch {
        // 壊れた状態ファイルで監視を止めない: 空の状態で起動する
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
