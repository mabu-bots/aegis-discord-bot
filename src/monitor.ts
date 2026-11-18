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
// seen の更新は「計画を立てた時点」で行う (送信失敗で同じ警報を繰り返さないため、
// 送信側の失敗はログに残す方針)。priming 前は seen だけを更新して何も送らない。
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
    // 初見でも発生から 15 分以上経った地震は通知しない (長時間停止後の再開時の誤報防止)
    if (prev === undefined) {
      const occurred = parseP2pTime(q.time);
      if (occurred && now.getTime() - occurred.getTime() > 15 * 60 * 1000) continue;
    }
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
    // 津波はグレードを問わず全購読チャンネルへ (解除も含む)
    for (const sub of subs) planned.push({ subscription: sub, alert: t, isUpdate: false, arrivalLines: [] });
  }

  for (const e of alerts.eews) {
    const prevNotified = state.seenEews[e.key];
    if (e.cancel) {
      // 取消は、元の速報を通知済みの場合にだけ送る
      if (state.seenEews[e.baseKey] === true && prevNotified === undefined) {
        state.seenEews[e.key] = true;
        if (!priming) {
          for (const sub of subs) {
            if (sub.eew) planned.push({ subscription: sub, alert: e, isUpdate: false, arrivalLines: [] });
          }
        }
      } else if (prevNotified === undefined) {
        state.seenEews[e.key] = false;
      }
      continue;
    }
    if (prevNotified !== undefined) continue;
    // EEW は推定震度4以上 (または震度不明) を通知対象にする
    const eligible = e.estScale >= 40 || e.estScale <= 0;
    state.seenEews[e.key] = eligible;
    if (priming || !eligible) continue;
    const arrivalLines = eewArrivalLines(e, undefined, now);
    for (const sub of subs) {
      if (sub.eew) planned.push({ subscription: sub, alert: e, isUpdate: false, arrivalLines });
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
}

export class Monitor {
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;

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

  private async tick(): Promise<void> {
    if (this.stopped) return;
    let delayMs = this.pollSeconds * 1000;
    try {
      const alerts = await this.deps.fetchAll();
      const plans = planNotifications(this.deps.store, alerts);
      for (const plan of plans) {
        try {
          await this.deps.send(plan);
        } catch (err) {
          this.deps.log(`通知の送信に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
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
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), delayMs);
  }
}
