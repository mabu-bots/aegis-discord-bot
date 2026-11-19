// ===== 6. 監視ループと通知の振り分け =====
// ポーリングで得た情報を「どのチャンネルへ何を送るか」に変換する。
// 振り分けの判断は純粋関数 (planNotifications) に切り出してテスト可能にしてある。
import {
  eewArrivalLines,
  parseP2pTime,
  type EewInfo,
  type QuakeInfo,
  type TsunamiInfo,
} from "./sources/p2p.js";
import type { Store, Subscription } from "./store.js";

export type Alert = QuakeInfo | TsunamiInfo | EewInfo;

export interface PlannedMessage {
  subscription: Subscription;
  alert: Alert;
  // 地震の続報 (震度が上がった再通知) かどうか
  isUpdate: boolean;
  // EEW の到達予想行 (EEW のときだけ)
  arrivalLines: string[];
}

// ----- 6.1 振り分けの判断 -----
// seen の更新は「計画を立てた時点」で行う。送信に失敗した分は Monitor が
// 購読単位で次 tick に再試行する (6.2)。priming 前は seen だけを更新して何も送らない。
const STALE_MS = 15 * 60 * 1000;

// 発生から 15 分以上経った情報かどうか (長時間停止後の再開時の誤報防止)。
// 時刻がパースできない場合は従来どおり素通りさせる (fail-open)。
function isStale(timeText: string, now: Date): boolean {
  const occurred = parseP2pTime(timeText);
  return occurred !== null && now.getTime() - occurred.getTime() > STALE_MS;
}
export function planNotifications(
  store: Store,
  alerts: { quakes: QuakeInfo[]; tsunamis: TsunamiInfo[]; eews: EewInfo[] },
  now: Date = new Date(),
): PlannedMessage[] {
  const state = store.data;
  const subs = state.subscriptions;
  const planned: PlannedMessage[] = [];
  const priming = !state.primed;

  for (const q of alerts.quakes) {
    if (!q.id) continue;
    const prev = state.seenQuakes[q.id];
    state.seenQuakes[q.id] = Math.max(prev ?? 0, q.maxScale);
    if (priming || prev === q.maxScale) continue;
    // 初見でも発生から 15 分以上経った地震は通知しない
    if (prev === undefined && isStale(q.time, now)) continue;
    const isUpdate = prev !== undefined;
    // 初報は「未通知だった場合」だけ、続報は「震度が上がった場合」だけ送る
    if (isUpdate && (prev ?? 0) >= q.maxScale) continue;
    for (const sub of subs) {
      if (q.maxScale >= sub.minScale) planned.push({ subscription: sub, alert: q, isUpdate, arrivalLines: [] });
    }
  }

  for (const t of alerts.tsunamis) {
    if (!t.id) continue;
    if (state.seenTsunamis.includes(t.id)) continue;
    state.seenTsunamis.push(t.id);
    if (priming) continue;
    // 地震と同型の staleness ガード: 発生から 15 分以上経った初見は通知しない
    if (isStale(t.time, now)) continue;
    // 津波はグレードを問わず全購読チャンネルへ (解除も含む)
    for (const sub of subs) planned.push({ subscription: sub, alert: t, isUpdate: false, arrivalLines: [] });
  }

  for (const e of alerts.eews) {
    const prevNotified = state.seenEews[e.key];
    if (e.cancel) {
      // 取消は、元の速報を通知済みの場合にだけ送る
      if (state.seenEews[e.baseKey] !== undefined && prevNotified === undefined) {
        state.seenEews[e.key] = 1;
        if (!priming) {
          for (const sub of subs) {
            if (sub.eew) planned.push({ subscription: sub, alert: e, isUpdate: false, arrivalLines: [] });
          }
        }
      } else if (prevNotified === undefined) {
        state.seenEews[e.key] = 0;
      }
      continue;
    }
    // EEW は推定震度4以上 (または震度不明) を通知対象にする
    const eligible = e.estScale >= 40 || e.estScale <= 0;
    if (!eligible) {
      // 通知対象外は seen に残さない: 続報で上方修正されたら通知できるようにする
      continue;
    }
    // 地震と同型の staleness ガード: 発生から 15 分以上経った速報は通知しない
    if (isStale(e.originTime, now)) {
      state.seenEews[e.key] = Math.max(prevNotified ?? 0, e.estScale);
      continue;
    }
    // 通知済みの最大推定震度以下なら再通知しない。上方修正された続報だけ再通知する
    if (prevNotified !== undefined && e.estScale <= prevNotified) continue;
    const isUpdate = prevNotified !== undefined;
    state.seenEews[e.key] = Math.max(prevNotified ?? 0, e.estScale);
    if (priming) continue;
    const arrivalLines = eewArrivalLines(e, undefined, now);
    for (const sub of subs) {
      if (sub.eew) planned.push({ subscription: sub, alert: e, isUpdate, arrivalLines });
    }
  }

  if (priming) state.primed = true;
  store.save();
  return planned;
}

// ----- 6.2 監視ループ -----
export interface MonitorDeps {
  store: Store;
  fetchAll: () => Promise<{ quakes: QuakeInfo[]; tsunamis: TsunamiInfo[]; eews: EewInfo[] }>;
  send: (plan: PlannedMessage) => Promise<void>;
  log: (msg: string) => void;
  // 現在時刻の供給元 (テスト用。省略時は実時刻)
  now?: () => Date;
}

// 送信失敗した計画のリトライ上限 (回)。恒常的に届かないチャンネル
// (削除済み等) を無限に再試行しないための上限で、上限到達時はログを残して破棄する。
const MAX_SEND_RETRIES = 3;

// リトライ管理用のキー: 警報の同一性 + 宛先チャンネルで購読単位に識別する
function planKey(plan: PlannedMessage): string {
  const a = plan.alert;
  const identity =
    a.kind === "quake"
      ? `quake:${a.id}:${a.maxScale}`
      : a.kind === "tsunami"
        ? `tsunami:${a.id}`
        : `eew:${a.key}:${a.estScale}`;
  return `${identity}:${plan.subscription.channelId}`;
}

export class Monitor {
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;
  // 送信に失敗した計画 (購読単位)。次 tick で再試行する
  private retryQueue: PlannedMessage[] = [];
  private retryAttempts = new Map<string, number>();

  constructor(
    private deps: MonitorDeps,
    private pollSeconds: number,
  ) {}

  start(): void {
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // 1 回分の監視処理を行い、次回までの遅延 (ミリ秒) を返す。テストからも呼べるよう公開する
  async tickOnce(): Promise<number> {
    let delayMs = this.pollSeconds * 1000;
    try {
      const alerts = await this.deps.fetchAll();
      const plans = [
        ...this.retryQueue,
        ...planNotifications(this.deps.store, alerts, this.deps.now?.() ?? new Date()),
      ];
      this.retryQueue = [];
      for (const plan of plans) {
        try {
          await this.deps.send(plan);
          this.retryAttempts.delete(planKey(plan));
        } catch (err) {
          this.deps.log(`通知の送信に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
          // seen は計画時点で更新済みのため、失敗した購読分だけを次 tick で再試行する
          const key = planKey(plan);
          const attempts = (this.retryAttempts.get(key) ?? 0) + 1;
          if (attempts <= MAX_SEND_RETRIES) {
            this.retryAttempts.set(key, attempts);
            this.retryQueue.push(plan);
          } else {
            this.retryAttempts.delete(key);
            this.deps.log(`通知のリトライ上限 (${MAX_SEND_RETRIES} 回) に達したため破棄します: ${key}`);
          }
        }
      }
      this.failures = 0;
    } catch (err) {
      this.failures += 1;
      // AEGIS と同じ指数バックオフ (上限 300 秒)
      delayMs = Math.min(300, this.pollSeconds * 2 ** Math.min(this.failures, 4)) * 1000;
      this.deps.log(
        `情報の取得に失敗しました (${this.failures}回目、次回は ${Math.round(delayMs / 1000)} 秒後): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return delayMs;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const delayMs = await this.tickOnce();
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), delayMs);
  }
}
