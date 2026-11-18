// ===== 10. デモ (Discord 不要の動作確認) =====
// 実データを取得し、「いま通知対象の情報が来たら何が表示されるか」を
// 埋め込みの JSON として標準出力へ出す。トークンなしで確認できる。
import { eewEmbed, quakeEmbed, tsunamiEmbed, weatherEmbed } from "./embeds.js";
import { DEFAULT_PLACES, eewArrivalLines, fetchEews, fetchQuakes, fetchTsunamis } from "./sources/p2p.js";
import { fetchWeather } from "./sources/weather.js";

function show(title: string, embed: { toJSON(): unknown }): void {
  const j = embed.toJSON() as { title?: string; description?: string };
  console.log(`--- ${title} ---`);
  console.log(j.title ?? "");
  console.log(j.description ?? "");
  console.log();
}

const quakes = await fetchQuakes(3);
console.log(`地震情報: ${quakes.length} 件`);
if (quakes[0]) show("地震 (最新)", quakeEmbed(quakes[0]));

const tsunamis = await fetchTsunamis(3);
console.log(`津波情報: ${tsunamis.length} 件`);
if (tsunamis[0]) show("津波 (最新)", tsunamiEmbed(tsunamis[0]));

const eews = await fetchEews(3);
console.log(`緊急地震速報: ${eews.length} 件 (プレースホルダ除く)`);
if (eews[0]) show("EEW (最新)", eewEmbed(eews[0], eewArrivalLines(eews[0])));

for (const place of DEFAULT_PLACES) {
  const report = await fetchWeather(place.lat, place.lon, place.name);
  show(`天気 (${place.name})`, weatherEmbed(report));
}
console.log("デモが完了しました。");
