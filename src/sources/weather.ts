// ===== 2. 天気 (Open-Meteo) =====
// 予報の取得と、任意地点のジオコーディング。AEGIS と同じ Open-Meteo を使う。
// 週間予報まで含めた「表形式」の表示データを返す。

// ----- 2.1 WMO 天気コード -----
const WMO_WEATHER: Record<number, string> = {
  0: "快晴",
  1: "晴れ",
  2: "一部曇り",
  3: "曇り",
  45: "霧",
  48: "霧",
  51: "霧雨",
  53: "霧雨",
  55: "霧雨",
  56: "着氷性の霧雨",
  57: "着氷性の霧雨",
  61: "雨",
  63: "雨",
  65: "大雨",
  66: "着氷性の雨",
  67: "着氷性の雨",
  71: "雪",
  73: "雪",
  75: "大雪",
  77: "雪あられ",
  80: "にわか雨",
  81: "にわか雨",
  82: "激しい雨",
  85: "雪",
  86: "雪",
  95: "雷雨",
  96: "雷雨（雹）",
  99: "雷雨（雹）",
};

const WMO_EMOJI: Record<number, string> = {
  0: "☀",
  1: "🌤",
  2: "⛅",
  3: "☁",
  45: "🌫",
  48: "🌫",
  51: "🌦",
  53: "🌦",
  55: "🌦",
  56: "🌧",
  57: "🌧",
  61: "🌧",
  63: "🌧",
  65: "🌧",
  66: "🌧",
  67: "🌧",
  71: "🌨",
  73: "🌨",
  75: "🌨",
  77: "🌨",
  80: "🌦",
  81: "🌦",
  82: "⛈",
  85: "🌨",
  86: "🌨",
  95: "⛈",
  96: "⛈",
  99: "⛈",
};

export function weatherLabel(code: number | null): string {
  if (code === null) return "不明";
  return WMO_WEATHER[code] ?? "不明";
}

export function weatherEmoji(code: number | null, pop: number | null = null): string {
  let icon = code === null ? "☁" : (WMO_EMOJI[code] ?? "☁");
  // AEGIS の wx_icon と同じ規則: 降水確率が高ければ雨系を優先する
  if (pop !== null && pop >= 50 && (icon === "☀" || icon === "🌤" || icon === "⛅" || icon === "☁")) {
    icon = pop >= 80 ? "🌧" : "🌦";
  }
  return icon;
}

// ----- 2.2 予報データ -----
export interface DayForecast {
  // "2026-11-19"
  date: string;
  // "11/19(木)"
  label: string;
  code: number | null;
  tempMin: number | null;
  tempMax: number | null;
  popMax: number | null;
}

export interface WeatherReport {
  placeName: string;
  currentLabel: string;
  currentEmoji: string;
  currentTemp: number | null;
  windKmh: number | null;
  today: DayForecast | null;
  days: DayForecast[];
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

export function dayLabel(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return isoDate;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${Number(m[2])}/${Number(m[3])}(${WEEKDAY_JA[d.getUTCDay()]})`;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseForecast(data: any, placeName: string): WeatherReport {
  const cur = data?.current ?? {};
  const daily = data?.daily ?? {};
  const times: string[] = Array.isArray(daily.time) ? daily.time : [];
  const days: DayForecast[] = times.slice(0, 7).map((t, i) => ({
    date: String(t),
    label: dayLabel(String(t)),
    code: numOrNull((daily.weather_code ?? [])[i]),
    tempMin: numOrNull((daily.temperature_2m_min ?? [])[i]),
    tempMax: numOrNull((daily.temperature_2m_max ?? [])[i]),
    popMax: numOrNull((daily.precipitation_probability_max ?? [])[i]),
  }));
  const curCode = numOrNull(cur.weather_code);
  return {
    placeName,
    currentLabel: weatherLabel(curCode),
    currentEmoji: weatherEmoji(curCode, days[0]?.popMax ?? null),
    currentTemp: numOrNull(cur.temperature_2m),
    windKmh: numOrNull(cur.wind_speed_10m),
    today: days[0] ?? null,
    days,
  };
}

// ----- 2.3 取得 -----
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": "aegis-discord-bot/1.0 (+https://github.com/i-mabu)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Open-Meteo が ${res.status} を返しました`);
  return res.json();
}

export async function fetchWeather(lat: number, lon: number, placeName: string): Promise<WeatherReport> {
  const url =
    `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,weather_code,wind_speed_10m" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code" +
    "&forecast_days=7&timezone=Asia%2FTokyo";
  return parseForecast(await fetchJson(url), placeName);
}

export interface GeoPlace {
  name: string;
  displayName: string;
  lat: number;
  lon: number;
}

export function parseGeocoding(data: any): GeoPlace[] {
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  return results
    .filter((r) => typeof r?.latitude === "number" && typeof r?.longitude === "number")
    .map((r) => {
      const admin = [r.admin1, r.admin2].filter((s) => typeof s === "string" && s).join(" ");
      return {
        name: String(r.name ?? ""),
        displayName: admin ? `${r.name}（${admin}）` : String(r.name ?? ""),
        lat: r.latitude,
        lon: r.longitude,
      };
    });
}

// 地名から地点を引く。日本国内の候補を優先し、無ければ先頭の候補を返す
export async function geocode(query: string): Promise<GeoPlace | null> {
  const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=5&language=ja&format=json`;
  const data = await fetchJson(url);
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  const jp = results.find((r) => r?.country_code === "JP");
  const parsed = parseGeocoding(jp ? { results: [jp] } : data);
  return parsed[0] ?? null;
}
