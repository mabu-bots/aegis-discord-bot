// ===== テスト: P2P地震情報のパース =====
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  depthLabel,
  eewArrivalLines,
  parseEews,
  parseQuakes,
  parseTsunamis,
  scaleLabel,
  scaleSeverity,
  tsunamiGradeLabel,
} from "../src/sources/p2p.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8"));
}

test("scaleLabel: 震度階級と不明センチネル", () => {
  assert.equal(scaleLabel(45), "5弱");
  assert.equal(scaleLabel(55), "6弱");
  assert.equal(scaleLabel(30), "3");
  assert.equal(scaleLabel(-1), "不明");
  assert.equal(scaleLabel(0), "不明");
});

test("scaleSeverity: 震度と M の高い方で判定", () => {
  assert.equal(scaleSeverity(45, 3.0), 4);
  assert.equal(scaleSeverity(20, 6.5), 4);
  assert.equal(scaleSeverity(40, null), 3);
  assert.equal(scaleSeverity(30, null), 2);
  assert.equal(scaleSeverity(10, null), 0);
});

test("parseQuakes: 実データ (551) の整形", () => {
  const quakes = parseQuakes(fixture("p2p-551.json"));
  assert.ok(quakes.length >= 1);
  const q = quakes[0];
  assert.equal(q.kind, "quake");
  assert.ok(q.id.length > 0);
  assert.ok(q.hypocenter.length > 0);
  assert.equal(q.tsunamiLabel, "津波の心配なし");
  assert.ok(q.prefScales.length >= 1);
  // 震度の降順になっている
  for (let i = 1; i < q.prefScales.length; i++) {
    assert.ok(q.prefScales[i - 1].scale >= q.prefScales[i].scale);
  }
});

test("parseQuakes: 不正な入力では空配列", () => {
  assert.deepEqual(parseQuakes(null), []);
  assert.deepEqual(parseQuakes({}), []);
  assert.deepEqual(parseQuakes([{}]), []);
});

test("depthLabel: -1 は「ごく浅い」", () => {
  assert.equal(depthLabel(-1), "ごく浅い");
  assert.equal(depthLabel(10), "約10km");
  assert.equal(depthLabel(null), "深さ不明");
});

test("parseTsunamis: 合成データのグレードと地域", () => {
  const list = parseTsunamis(fixture("p2p-552-synthetic.json"));
  assert.equal(list.length, 1);
  const t = list[0];
  assert.equal(t.grade, "Warning");
  assert.equal(t.cancelled, false);
  assert.equal(tsunamiGradeLabel(t), "津波警報");
  assert.equal(t.areas.length, 2);
  assert.equal(t.areas[0].maxHeightLabel, "3m");
  assert.equal(t.areas[0].arrivalLabel, "06:20");
});

test("parseTsunamis: 解除のラベル", () => {
  const list = parseTsunamis([
    { id: "x", time: "2026/11/19 07:00:00", cancelled: true, areas: [] },
  ]);
  assert.equal(tsunamiGradeLabel(list[0]), "津波警報・注意報 解除");
});

test("parseEews: プレースホルダを除外し、対象県と到達時刻を拾う", () => {
  const list = parseEews(fixture("p2p-554-synthetic.json"));
  assert.equal(list.length, 1);
  const e = list[0];
  assert.equal(e.hypocenter, "千葉県東方沖");
  assert.equal(e.estScale, 50);
  assert.deepEqual(e.prefs, ["埼玉県", "群馬県", "千葉県"]);
  assert.equal(e.key, "eew-2026/11/19 06:00:00-千葉県東方沖");
  assert.equal(e.areaArrivals.length, 3);
});

test("parseEews: 取消報は -cancel キーになる", () => {
  const data = fixture("p2p-554-synthetic.json") as Record<string, any>[];
  const cancelItem = { ...data[0], isCancel: true, id: "synthetic-eew-002" };
  const list = parseEews([cancelItem]);
  assert.equal(list[0].cancel, true);
  assert.ok(list[0].key.endsWith("-cancel"));
  assert.equal(list[0].baseKey, "eew-2026/11/19 06:00:00-千葉県東方沖");
});

test("eewArrivalLines: area の到達時刻を使い、残り秒数を出す", () => {
  const [e] = parseEews(fixture("p2p-554-synthetic.json"));
  // 発生 06:00:00、埼玉の到達 06:00:40。now=06:00:10 なら「あと約30秒」
  const now = new Date("2026-11-19T06:00:10+09:00");
  const lines = eewArrivalLines(e, undefined, now);
  const saitama = lines.find((l) => l.startsWith("大宮"));
  assert.ok(saitama, "大宮の行がある");
  assert.ok(saitama.includes("あと約30秒"));
  const gunma = lines.find((l) => l.startsWith("高崎"));
  assert.ok(gunma && gunma.includes("あと約42秒"));
});
