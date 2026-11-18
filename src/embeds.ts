// ===== 4. Discord 埋め込みの組み立て =====
// データ層のオブジェクトから EmbedBuilder を作る。色は震度・グレードで変える。
import { EmbedBuilder } from "discord.js";
import {
  depthLabel,
  scaleLabel,
  tsunamiGradeLabel,
  type EewInfo,
  type QuakeInfo,
  type TsunamiInfo,
} from "./sources/p2p.js";
import { weatherEmoji, weatherLabel, type WeatherReport } from "./sources/weather.js";

// ----- 4.1 地震 -----
export function quakeColor(maxScale: number): number {
  if (maxScale >= 55) return 0x7b1fa2; // 6弱以上: 紫
  if (maxScale >= 45) return 0xd32f2f; // 5弱以上: 赤
  if (maxScale >= 40) return 0xef6c00; // 4: 橙
  if (maxScale >= 30) return 0xf9a825; // 3: 黄
  if (maxScale >= 20) return 0x43a047; // 2: 緑
  return 0x546e7a; // 1以下: 灰青
}

function shortPref(pref: string): string {
  // AEGIS と同じ規則: 末尾の 県/府/都 を1文字だけ落とす
  return pref.endsWith("県") || pref.endsWith("府") || pref.endsWith("都") ? pref.slice(0, -1) : pref;
}

export function quakeEmbed(q: QuakeInfo, isUpdate = false): EmbedBuilder {
  const lines: string[] = [];
  lines.push(`**最大震度 ${scaleLabel(q.maxScale)}** / ${q.hypocenter}`);
  lines.push(
    `${q.magnitude === null ? "M不明" : `M${q.magnitude}`} / 深さ ${depthLabel(q.depthKm)} / ${q.time} 発生`,
  );
  lines.push(`津波: ${q.tsunamiLabel}`);
  if (q.topPoint) lines.push(`最大震度観測: ${q.topPoint}`);
  if (q.localScales.length > 0) {
    lines.push(
      "地元: " + q.localScales.map((l) => `${l.name} ${scaleLabel(l.scale)}`).join(" / "),
    );
  }
  if (q.prefScales.length > 1) {
    const top = q.prefScales.slice(0, 8);
    lines.push(
      "各地の震度: " + top.map((p) => `${shortPref(p.pref)} ${scaleLabel(p.scale)}`).join("、"),
    );
  }
  if (q.lat !== null && q.lon !== null && (q.lat !== 0 || q.lon !== 0)) {
    lines.push(`[震源マップ](https://www.openstreetmap.org/?mlat=${q.lat}&mlon=${q.lon}#map=8/${q.lat}/${q.lon})`);
  }
  return new EmbedBuilder()
    .setColor(quakeColor(q.maxScale))
    .setTitle(`地震情報${isUpdate ? "（続報）" : ""} 最大震度${scaleLabel(q.maxScale)} ${q.hypocenter}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "出典: P2P地震情報（気象庁）" })
    .setTimestamp(new Date());
}

// ----- 4.2 津波 -----
export function tsunamiEmbed(t: TsunamiInfo): EmbedBuilder {
  const label = tsunamiGradeLabel(t);
  const color = t.cancelled
    ? 0x43a047
    : t.grade === "MajorWarning"
      ? 0x7b1fa2
      : t.grade === "Warning"
        ? 0xd32f2f
        : t.grade === "Watch"
          ? 0xf9a825
          : 0x546e7a;
  const areaLines = t.areas.slice(0, 10).map((a) => {
    const parts = [a.name];
    if (a.maxHeightLabel) parts.push(`予想 ${a.maxHeightLabel}`);
    if (a.arrivalLabel) parts.push(`第1波到達予想 ${a.arrivalLabel}`);
    return parts.join("（") + (parts.length > 1 ? "）" : "");
  });
  const guide = t.cancelled
    ? "解除を確認。ただし公式発表で安全が確認できるまで海岸には近づかないでください。"
    : t.grade === "Watch"
      ? "海から上がり、海岸から離れてください。"
      : "ただちに高台・津波避難ビルへ避難してください。海岸・河口に絶対に近づかないでください。";
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(label)
    .setDescription(
      [`発表: ${t.time}`, areaLines.length > 0 ? `対象地域: ${areaLines.join("、")}` : "対象地域: 全国", "", guide].join("\n"),
    )
    .setFooter({ text: "出典: P2P地震情報（気象庁 津波情報）" })
    .setTimestamp(new Date());
}

// ----- 4.3 緊急地震速報 -----
export function eewEmbed(e: EewInfo, arrivalLines: string[]): EmbedBuilder {
  const lines: string[] = [];
  lines.push(`震源: ${e.hypocenter} / 推定最大震度 **${scaleLabel(e.estScale)}**`);
  lines.push(`${e.estMagnitude === null ? "M不明" : `推定M${e.estMagnitude}`} / 発表: ${e.time}`);
  if (e.prefs.length > 0) lines.push(`対象: ${e.prefs.join("、")}`);
  for (const l of arrivalLines) lines.push(l);
  if (!e.cancel) lines.push("", "強い揺れに備え、頭を守り安全な場所へ移動してください。");
  return new EmbedBuilder()
    .setColor(e.cancel ? 0x43a047 : 0xd32f2f)
    .setTitle(`緊急地震速報${e.cancel ? "（取消）" : ""} ${e.hypocenter}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "出典: P2P地震情報（緊急地震速報）" })
    .setTimestamp(new Date());
}

// ----- 4.4 天気 -----
function fmtNum(v: number | null): string {
  return v === null ? "?" : `${Math.round(v)}`;
}

export function weatherEmbed(r: WeatherReport): EmbedBuilder {
  const today = r.today;
  const lines: string[] = [];
  lines.push(
    `${r.currentEmoji} 現在: ${r.currentLabel} ${fmtNum(r.currentTemp)}℃ / 風 ${fmtNum(r.windKmh)}km/h`,
  );
  if (today) {
    lines.push(
      `今日: ${fmtNum(today.tempMin)}〜${fmtNum(today.tempMax)}℃ / 降水確率 最大${today.popMax === null ? "?" : `${Math.round(today.popMax)}%`}`,
    );
  }
  const embed = new EmbedBuilder()
    .setColor(0x1e88e5)
    .setTitle(`${r.placeName} の天気`)
    .setFooter({ text: "出典: Open-Meteo" })
    .setTimestamp(new Date());
  if (r.days.length > 0) {
    lines.push("", "**週間予報**");
    for (const d of r.days) {
      lines.push(
        `${d.label} ${weatherEmoji(d.code, d.popMax)} ${weatherLabel(d.code)} ${fmtNum(d.tempMin)}〜${fmtNum(d.tempMax)}℃ ☔${d.popMax === null ? "?" : `${Math.round(d.popMax)}%`}`,
      );
    }
  }
  embed.setDescription(lines.join("\n"));
  return embed;
}
