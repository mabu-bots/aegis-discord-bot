// ===== テスト: 天気のパース =====
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dayLabel, parseForecast, parseGeocoding, weatherEmoji, weatherLabel } from "../src/sources/weather.js";

function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8"));
}

test("weatherLabel / weatherEmoji: WMO コード変換と降水確率の優先", () => {
  assert.equal(weatherLabel(0), "快晴");
  assert.equal(weatherLabel(61), "雨");
  assert.equal(weatherLabel(null), "不明");
  assert.equal(weatherEmoji(0), "☀");
  // 晴れでも降水確率 80% 以上なら雨アイコンを優先する (AEGIS の規則)
  assert.equal(weatherEmoji(0, 85), "🌧");
  assert.equal(weatherEmoji(0, 60), "🌦");
  assert.equal(weatherEmoji(0, 30), "☀");
});

test("dayLabel: 曜日付きの日付", () => {
  // 2026-11-19 は木曜日
  assert.equal(dayLabel("2026-11-19"), "11/19(木)");
});

test("parseForecast: 実データ (高崎) の整形", () => {
  const r = parseForecast(fixture("open-meteo-takasaki.json"), "高崎");
  assert.equal(r.placeName, "高崎");
  assert.ok(r.days.length >= 1 && r.days.length <= 7);
  assert.ok(r.today);
  assert.equal(r.today.date, r.days[0].date);
  assert.ok(r.currentLabel.length > 0);
});

test("parseForecast: 空データでも例外にしない", () => {
  const r = parseForecast({}, "不明");
  assert.equal(r.days.length, 0);
  assert.equal(r.today, null);
  assert.equal(r.currentLabel, "不明");
});

test("parseGeocoding: 表示名に行政区画を付ける", () => {
  const places = parseGeocoding({
    results: [
      { name: "高崎市", latitude: 36.32, longitude: 139.0, admin1: "群馬県", country_code: "JP" },
      { name: "壊れた候補", country_code: "JP" },
    ],
  });
  assert.equal(places.length, 1);
  assert.equal(places[0].displayName, "高崎市（群馬県）");
});
