// ===== テスト: 通知の振り分けとストア =====
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Monitor, planNotifications } from "../src/monitor.js";
import type { EewInfo, QuakeInfo, TsunamiInfo } from "../src/sources/p2p.js";
import { Store } from "../src/store.js";

function quake(partial: Partial<QuakeInfo>): QuakeInfo {
  return {
    kind: "quake",
    id: "q1",
    time: "2026/11/19 06:00:00",
    hypocenter: "テスト沖",
    magnitude: 5.0,
    depthKm: 30,
    maxScale: 40,
    tsunamiKind: "None",
    tsunamiLabel: "津波の心配なし",
    lat: 35.0,
    lon: 140.0,
    topPoint: null,
    prefScales: [],
    localScales: [],
    ...partial,
  };
}

function eew(partial: Partial<EewInfo>): EewInfo {
  return {
    kind: "eew",
    key: "eew-2026/11/19 06:00:00-テスト沖",
    baseKey: "eew-2026/11/19 06:00:00-テスト沖",
    time: "2026/11/19 06:00:05",
    cancel: false,
    hypocenter: "テスト沖",
    estScale: 45,
    estMagnitude: 6.0,
    prefs: ["埼玉県"],
    originTime: "2026/11/19 06:00:00",
    lat: 35.5,
    lon: 140.1,
    depthKm: 40,
    areaArrivals: [],
    ...partial,
  };
}

const NOW = new Date("2026-11-19T06:01:00+09:00");
const noAlerts = { quakes: [], tsunamis: [], eews: [] };

function storeWithSub(minScale = 30, eewEnabled = true): Store {
  const dir = mkdtempSync(join(tmpdir(), "aegis-bot-test-"));
  const store = new Store(join(dir, "state.json"));
  store.upsertSubscription({
    guildId: "g1",
    channelId: "c1",
    minScale,
    eew: eewEnabled,
    strongMention: false,
  });
  // priming を済ませた状態にする
  planNotifications(store, noAlerts, NOW);
  return store;
}

test("priming: 初回は何も送らず seen だけが記録される", () => {
  const dir = mkdtempSync(join(tmpdir(), "aegis-bot-test-"));
  const store = new Store(join(dir, "state.json"));
  const plans = planNotifications(store, { quakes: [quake({})], tsunamis: [], eews: [] }, NOW);
  assert.equal(plans.length, 0);
  assert.equal(store.data.primed, true);
  assert.equal(store.data.seenQuakes["q1"], 40);
  rmSync(dir, { recursive: true, force: true });
});

test("地震: 閾値以上で通知し、同じ内容は再通知しない", () => {
  const store = storeWithSub(30);
  const first = planNotifications(store, { quakes: [quake({})], tsunamis: [], eews: [] }, NOW);
  assert.equal(first.length, 1);
  assert.equal(first[0].isUpdate, false);
  const again = planNotifications(store, { quakes: [quake({})], tsunamis: [], eews: [] }, NOW);
  assert.equal(again.length, 0);
});

test("地震: 閾値未満は通知しない / 続報で震度が上がれば再通知する", () => {
  const store = storeWithSub(30);
  const small = planNotifications(
    store,
    { quakes: [quake({ id: "q2", maxScale: 20 })], tsunamis: [], eews: [] },
    NOW,
  );
  assert.equal(small.length, 0);
  const grown = planNotifications(
    store,
    { quakes: [quake({ id: "q2", maxScale: 45 })], tsunamis: [], eews: [] },
    NOW,
  );
  assert.equal(grown.length, 1);
  assert.equal(grown[0].isUpdate, true);
});

test("地震: 発生から15分以上経った初見の地震は通知しない", () => {
  const store = storeWithSub(30);
  const later = new Date("2026-11-19T06:20:00+09:00");
  const plans = planNotifications(store, { quakes: [quake({ id: "q3" })], tsunamis: [], eews: [] }, later);
  assert.equal(plans.length, 0);
});

test("津波: 閾値に関係なく通知し、重複は送らない", () => {
  const store = storeWithSub(45);
  const t: TsunamiInfo = {
    kind: "tsunami",
    id: "t1",
    time: "2026/11/19 06:00:00",
    cancelled: false,
    grade: "Watch",
    areas: [],
  };
  const first = planNotifications(store, { quakes: [], tsunamis: [t], eews: [] }, NOW);
  assert.equal(first.length, 1);
  const again = planNotifications(store, { quakes: [], tsunamis: [t], eews: [] }, NOW);
  assert.equal(again.length, 0);
});

test("EEW: 推定震度4以上で通知、取消は通知済みのときだけ届く", () => {
  const store = storeWithSub(30, true);
  const first = planNotifications(store, { quakes: [], tsunamis: [], eews: [eew({})] }, NOW);
  assert.equal(first.length, 1);
  const cancel = eew({
    key: "eew-2026/11/19 06:00:00-テスト沖-cancel",
    cancel: true,
  });
  const cancelPlans = planNotifications(store, { quakes: [], tsunamis: [], eews: [cancel] }, NOW);
  assert.equal(cancelPlans.length, 1);
});

test("EEW: 未通知の速報への取消は届かない / eew 無効の購読には届かない", () => {
  const store = storeWithSub(30, false);
  const plans = planNotifications(store, { quakes: [], tsunamis: [], eews: [eew({})] }, NOW);
  assert.equal(plans.length, 0);
  const cancel = eew({ key: "eew-2026/11/19 06:00:00-テスト沖-cancel", cancel: true });
  const cancelPlans = planNotifications(store, { quakes: [], tsunamis: [], eews: [cancel] }, NOW);
  assert.equal(cancelPlans.length, 0);
});

test("EEW: 推定震度3以下は通知しない", () => {
  const store = storeWithSub(30, true);
  const plans = planNotifications(
    store,
    { quakes: [], tsunamis: [], eews: [eew({ estScale: 30 })] },
    NOW,
  );
  assert.equal(plans.length, 0);
});

test("EEW: 第1報が対象外でも、上方修正された続報は通知する (H-1)", () => {
  const store = storeWithSub(30, true);
  const small = planNotifications(
    store,
    { quakes: [], tsunamis: [], eews: [eew({ estScale: 30 })] },
    NOW,
  );
  assert.equal(small.length, 0);
  const grown = planNotifications(
    store,
    { quakes: [], tsunamis: [], eews: [eew({ estScale: 45 })] },
    NOW,
  );
  assert.equal(grown.length, 1);
  assert.equal(grown[0].isUpdate, false);
});

test("EEW: 通知済みより推定震度が上がった続報だけ再通知する (H-1)", () => {
  const store = storeWithSub(30, true);
  const first = planNotifications(store, { quakes: [], tsunamis: [], eews: [eew({ estScale: 45 })] }, NOW);
  assert.equal(first.length, 1);
  const same = planNotifications(store, { quakes: [], tsunamis: [], eews: [eew({ estScale: 45 })] }, NOW);
  assert.equal(same.length, 0);
  const lower = planNotifications(store, { quakes: [], tsunamis: [], eews: [eew({ estScale: 40 })] }, NOW);
  assert.equal(lower.length, 0);
  const grown = planNotifications(store, { quakes: [], tsunamis: [], eews: [eew({ estScale: 50 })] }, NOW);
  assert.equal(grown.length, 1);
  assert.equal(grown[0].isUpdate, true);
});

test("EEW: 発生から15分以上経った初見の速報は通知しない", () => {
  const store = storeWithSub(30, true);
  const stale = eew({ originTime: "2026/11/19 05:40:00", time: "2026/11/19 05:40:05" });
  const plans = planNotifications(store, { quakes: [], tsunamis: [], eews: [stale] }, NOW);
  assert.equal(plans.length, 0);
});

test("津波: 発生から15分以上経った初見の情報は通知しない", () => {
  const store = storeWithSub(30);
  const t: TsunamiInfo = {
    kind: "tsunami",
    id: "t-stale",
    time: "2026/11/19 05:40:00",
    cancelled: false,
    grade: "Warning",
    areas: [],
  };
  const plans = planNotifications(store, { quakes: [], tsunamis: [t], eews: [] }, NOW);
  assert.equal(plans.length, 0);
});

function primedStoreWithTwoSubs(): Store {
  const dir = mkdtempSync(join(tmpdir(), "aegis-bot-test-"));
  const store = new Store(join(dir, "state.json"));
  store.upsertSubscription({ guildId: "g1", channelId: "c1", minScale: 30, eew: true, strongMention: false });
  store.upsertSubscription({ guildId: "g1", channelId: "c2", minScale: 30, eew: true, strongMention: false });
  planNotifications(store, noAlerts, NOW);
  return store;
}

test("Monitor: 送信に失敗した購読分だけ次 tick で再試行する (H-2)", async () => {
  const store = primedStoreWithTwoSubs();
  let fetchCount = 0;
  const sentTo: string[] = [];
  let c2Failed = false;
  const monitor = new Monitor(
    {
      store,
      fetchAll: async () => {
        fetchCount += 1;
        return fetchCount === 1 ? { quakes: [quake({})], tsunamis: [], eews: [] } : noAlerts;
      },
      send: async (plan) => {
        if (plan.subscription.channelId === "c2" && !c2Failed) {
          c2Failed = true;
          throw new Error("送信失敗 (テスト)");
        }
        sentTo.push(plan.subscription.channelId);
      },
      log: () => undefined,
      now: () => NOW,
    },
    30,
  );
  await monitor.tickOnce();
  assert.deepEqual(sentTo, ["c1"]);
  await monitor.tickOnce();
  assert.deepEqual(sentTo, ["c1", "c2"]);
  await monitor.tickOnce();
  assert.deepEqual(sentTo, ["c1", "c2"]);
});

test("Monitor: 届かない通知はリトライ上限で破棄される (H-2)", async () => {
  const store = primedStoreWithTwoSubs();
  let fetchCount = 0;
  let sendCalls = 0;
  const monitor = new Monitor(
    {
      store,
      fetchAll: async () => {
        fetchCount += 1;
        return fetchCount === 1 ? { quakes: [quake({})], tsunamis: [], eews: [] } : noAlerts;
      },
      send: async () => {
        sendCalls += 1;
        throw new Error("常に失敗 (テスト)");
      },
      log: () => undefined,
      now: () => NOW,
    },
    30,
  );
  // 初回 + リトライ 3 回 = 購読 2 件 × 4 回で打ち止めになる
  for (let i = 0; i < 6; i++) await monitor.tickOnce();
  assert.equal(sendCalls, 8);
});

test("Store: 購読の追加・削除と永続化", () => {
  const dir = mkdtempSync(join(tmpdir(), "aegis-bot-test-"));
  const path = join(dir, "state.json");
  const store = new Store(path);
  store.upsertSubscription({ guildId: "g", channelId: "c", minScale: 30, eew: true, strongMention: false });
  const saved = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal(saved.subscriptions.length, 1);
  const reopened = new Store(path);
  assert.equal(reopened.subscriptionsForGuild("g").length, 1);
  assert.equal(reopened.removeSubscription("g", "c"), true);
  assert.equal(reopened.removeSubscription("g", "c"), false);
  rmSync(dir, { recursive: true, force: true });
});
