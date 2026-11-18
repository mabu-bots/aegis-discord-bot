// ===== 1. P2P地震情報 API (地震・津波・緊急地震速報) =====
// 既存 AEGIS (Python 版) のパース規則を TypeScript に移植したもの。
// API: https://api.p2pquake.net/v2/history?codes=<code>&limit=<n>
//   551 = 地震情報 / 552 = 津波予報 / 554 = 緊急地震速報 (EEW)

const P2P_HISTORY = "https://api.p2pquake.net/v2/history";

// ----- 1.1 震度階級 -----
// P2P の scale 値 (10=震度1, 45=5弱, 55=6弱 ...) を表示文字列へ変換する
const SCALE_LABELS: Record<number, string> = {
  10: "1",
  20: "2",
  30: "3",
  40: "4",
  45: "5弱",
  50: "5強",
  55: "6弱",
  60: "6強",
  70: "7",
};

export function scaleLabel(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return "不明"; // -1 は震度不明のセンチネル
  return SCALE_LABELS[scale] ?? String(scale);
}

// 重要度 (0=INFO .. 4=CRITICAL)。AEGIS の scale_to_severity と同じ規則:
// 震度と M のどちらか高い方で判定する
export function scaleSeverity(scale: number, magnitude: number | null): number {
  const m = magnitude ?? 0;
  if (scale >= 45 || m >= 6.0) return 4;
  if (scale >= 40 || m >= 5.0) return 3;
  if (scale >= 30 || m >= 4.5) return 2;
  if (scale >= 20) return 1;
  return 0;
}

// ----- 1.2 共通の地点定義 -----
export interface WatchedPlace {
  name: string;
  pref: string;
  lat: number;
  lon: number;
}

// 既定の注目地点 (運用者の生活圏: 高崎=群馬県 / 大宮=埼玉県)
export const DEFAULT_PLACES: WatchedPlace[] = [
  { name: "高崎", pref: "群馬県", lat: 36.3219, lon: 139.0023 },
  { name: "大宮", pref: "埼玉県", lat: 35.9064, lon: 139.6239 },
];

// ----- 1.3 地震情報 (551) -----
export interface QuakeInfo {
  kind: "quake";
  id: string;
  // 発生時刻 (P2P 表記 "2026/11/19 06:41:00")
  time: string;
  hypocenter: string;
  magnitude: number | null;
  // 深さ (km)。null は不明、-1 は「ごく浅い」
  depthKm: number | null;
  maxScale: number;
  // 津波の見通し (domesticTsunami の原文キー)
  tsunamiKind: string;
  tsunamiLabel: string;
  lat: number | null;
  lon: number | null;
  // 最大震度を観測した地点名 (あれば)
  topPoint: string | null;
  // 都道府県別の最大震度 (降順、上位のみではない全件)
  prefScales: { pref: string; scale: number }[];
  // 注目地点の都道府県の震度 (観測があるものだけ)
  localScales: { name: string; pref: string; scale: number }[];
}

const TSUNAMI_LABELS: Record<string, string> = {
  None: "津波の心配なし",
  Forecast: "若干の海面変動の可能性あり",
  Advisory: "津波注意報レベル",
  Warning: "津波警報レベル",
  Unknown: "津波の有無は確認中",
};

function numOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function parseQuakes(data: unknown, places: WatchedPlace[] = DEFAULT_PLACES): QuakeInfo[] {
  if (!Array.isArray(data)) return [];
  const out: QuakeInfo[] = [];
  for (const item of data) {
    const eq = item?.earthquake;
    if (!eq) continue;
    const hypo = eq.hypocenter ?? {};
    const maxScale = numOrNull(eq.maxScale) ?? -1;
    const magRaw = numOrNull(hypo.magnitude);
    const magnitude = magRaw !== null && magRaw >= 0 ? magRaw : null;
    const depthRaw = numOrNull(hypo.depth);
    const tsunamiKind = String(eq.domesticTsunami ?? "None");
    const points: { pref?: string; addr?: string; scale?: number }[] = Array.isArray(item.points)
      ? item.points
      : [];
    const top = points.find((p) => p.scale === maxScale);
    const prefMax = new Map<string, number>();
    for (const p of points) {
      if (!p.pref) continue;
      const sc = numOrNull(p.scale) ?? 0;
      prefMax.set(p.pref, Math.max(prefMax.get(p.pref) ?? 0, sc));
    }
    const prefScales = [...prefMax.entries()]
      .map(([pref, scale]) => ({ pref, scale }))
      .sort((a, b) => b.scale - a.scale);
    const localScales = places
      .filter((pl) => prefMax.has(pl.pref))
      .map((pl) => ({ name: pl.name, pref: pl.pref, scale: prefMax.get(pl.pref)! }));
    out.push({
      kind: "quake",
      id: String(item.id ?? ""),
      time: String(eq.time ?? item.time ?? ""),
      hypocenter: String(hypo.name ?? "不明"),
      magnitude,
      depthKm: depthRaw,
      maxScale,
      tsunamiKind,
      tsunamiLabel: TSUNAMI_LABELS[tsunamiKind] ?? "津波の有無は確認中",
      lat: numOrNull(hypo.latitude),
      lon: numOrNull(hypo.longitude),
      topPoint: top ? String(top.addr ?? top.pref ?? "") || null : null,
      prefScales,
      localScales,
    });
  }
  return out;
}

export function depthLabel(depthKm: number | null): string {
  if (depthKm === null) return "深さ不明";
  if (depthKm === -1) return "ごく浅い";
  return `約${depthKm}km`;
}

// ----- 1.4 津波予報 (552) -----
export type TsunamiGrade = "MajorWarning" | "Warning" | "Watch" | "Unknown";

export interface TsunamiArea {
  name: string;
  grade: string;
  maxHeightLabel: string | null;
  arrivalLabel: string | null;
}

export interface TsunamiInfo {
  kind: "tsunami";
  id: string;
  time: string;
  cancelled: boolean;
  // 最も高いグレード
  grade: TsunamiGrade;
  areas: TsunamiArea[];
}

const GRADE_RANK: Record<string, number> = { MajorWarning: 3, Warning: 2, Watch: 1 };

export function parseTsunamis(data: unknown): TsunamiInfo[] {
  if (!Array.isArray(data)) return [];
  const out: TsunamiInfo[] = [];
  for (const item of data) {
    const areasRaw: Record<string, any>[] = Array.isArray(item?.areas) ? item.areas : [];
    const areas: TsunamiArea[] = areasRaw.map((a) => {
      const at = typeof a?.firstHeight?.arrivalTime === "string" ? a.firstHeight.arrivalTime : null;
      return {
        name: String(a?.name ?? ""),
        grade: String(a?.grade ?? ""),
        maxHeightLabel:
          typeof a?.maxHeight?.description === "string" ? a.maxHeight.description : null,
        arrivalLabel: at && at.length >= 16 ? at.slice(11, 16) : at,
      };
    });
    let grade: TsunamiGrade = "Unknown";
    for (const a of areas) {
      if ((GRADE_RANK[a.grade] ?? 0) > (GRADE_RANK[grade] ?? 0)) grade = a.grade as TsunamiGrade;
    }
    out.push({
      kind: "tsunami",
      id: String(item?.id ?? ""),
      time: String(item?.time ?? ""),
      cancelled: Boolean(item?.cancelled),
      grade,
      areas,
    });
  }
  return out;
}

export function tsunamiGradeLabel(info: TsunamiInfo): string {
  if (info.cancelled) return "津波警報・注意報 解除";
  switch (info.grade) {
    case "MajorWarning":
      return "大津波警報";
    case "Warning":
      return "津波警報";
    case "Watch":
      return "津波注意報";
    default:
      return "津波予報/情報";
  }
}

// ----- 1.5 緊急地震速報 (554) -----
export interface EewInfo {
  kind: "eew";
  // 続報は item id が変わるため、発生時刻+震源名で同一視する (AEGIS と同じ規則)。
  // 取消報は "-cancel" を付けた別キーにする
  key: string;
  baseKey: string;
  time: string;
  cancel: boolean;
  hypocenter: string;
  estScale: number;
  estMagnitude: number | null;
  // 対象の都道府県 (重複なし、最大6件)
  prefs: string[];
  originTime: string;
  lat: number | null;
  lon: number | null;
  depthKm: number | null;
  // 都道府県ごとの主要動到達予想時刻 (あれば)
  areaArrivals: { pref: string; arrivalTime: string }[];
}

export function parseEews(data: unknown): EewInfo[] {
  if (!Array.isArray(data)) return [];
  const out: EewInfo[] = [];
  for (const item of data) {
    const eq = item?.earthquake;
    if (!eq) continue; // プレースホルダは採用しない
    const hypo = eq.hypocenter ?? {};
    const hypoName = String(hypo.name ?? "不明");
    const cancel = Boolean(item.isCancel);
    const magRaw = numOrNull(hypo.magnitude);
    const prefs: string[] = [];
    const areaArrivals: { pref: string; arrivalTime: string }[] = [];
    for (const a of Array.isArray(item.areas) ? item.areas : []) {
      if (a?.pref && !prefs.includes(a.pref)) {
        if (prefs.length < 6) prefs.push(a.pref);
      }
      if (a?.pref && typeof a?.arrivalTime === "string") {
        areaArrivals.push({ pref: a.pref, arrivalTime: a.arrivalTime });
      }
    }
    const baseKey = `eew-${String(eq.originTime ?? item.time ?? "")}-${hypoName}`;
    out.push({
      kind: "eew",
      key: baseKey + (cancel ? "-cancel" : ""),
      baseKey,
      time: String(item.time ?? ""),
      cancel,
      hypocenter: hypoName,
      estScale: numOrNull(eq.maxScale) ?? -1,
      estMagnitude: magRaw !== null && magRaw >= 0 ? magRaw : null,
      prefs,
      originTime: String(eq.originTime ?? item.time ?? ""),
      lat: numOrNull(hypo.latitude),
      lon: numOrNull(hypo.longitude),
      depthKm: numOrNull(hypo.depth),
      areaArrivals,
    });
  }
  return out;
}

// ----- 1.6 EEW 主要動の到達予想 -----
// AEGIS の eew_arrival_estimates の移植: area の arrivalTime があればそれを使い、
// 無ければ震源距離と S波 3.5km/s から推定して「推定」と明記する
const S_WAVE_KM_S = 3.5;

export function parseP2pTime(s: string): Date | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/.exec(s ?? "");
  if (!m) return null;
  // P2P の時刻は JST。ローカル時刻として解釈せず、UTC+9 として構築する
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}+09:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371.0;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

export function eewArrivalLines(
  eew: EewInfo,
  places: WatchedPlace[] = DEFAULT_PLACES,
  now: Date = new Date(),
): string[] {
  if (eew.cancel) return [];
  const origin = parseP2pTime(eew.originTime);
  if (!origin) return [];
  const depth = eew.depthKm !== null && eew.depthKm > 0 ? eew.depthKm : 0;
  const lines: string[] = [];
  for (const place of places) {
    let arrival: Date | null = null;
    let estimated = false;
    const areaHit = eew.areaArrivals.find((a) => a.pref === place.pref);
    if (areaHit) arrival = parseP2pTime(areaHit.arrivalTime);
    if (!arrival && eew.lat !== null && eew.lon !== null) {
      const dist = Math.sqrt(haversineKm(place.lat, place.lon, eew.lat, eew.lon) ** 2 + depth ** 2);
      arrival = new Date(origin.getTime() + (dist / S_WAVE_KM_S) * 1000);
      estimated = true;
    }
    if (!arrival) continue;
    const remain = Math.floor((arrival.getTime() - now.getTime()) / 1000);
    // 実行環境のタイムゾーンに依らず JST で表示する
    const hm = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(arrival);
    const [hh, mm] = hm.split(":");
    const note = remain >= 0 ? `あと約${remain}秒` : "到達した可能性が高いです";
    lines.push(`${place.name}の主要動到達予想 ${hh}:${mm}（${estimated ? "推定・" : ""}${note}）`);
  }
  return lines;
}

// ----- 1.7 取得 -----
async function fetchHistory(code: number, limit: number): Promise<unknown> {
  const url = `${P2P_HISTORY}?codes=${code}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "aegis-discord-bot/1.0 (+https://github.com/i-mabu)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`P2P地震情報 API が ${res.status} を返しました (codes=${code})`);
  return res.json();
}

export async function fetchQuakes(limit = 10): Promise<QuakeInfo[]> {
  return parseQuakes(await fetchHistory(551, limit));
}

export async function fetchTsunamis(limit = 5): Promise<TsunamiInfo[]> {
  return parseTsunamis(await fetchHistory(552, limit));
}

export async function fetchEews(limit = 5): Promise<EewInfo[]> {
  return parseEews(await fetchHistory(554, limit));
}
