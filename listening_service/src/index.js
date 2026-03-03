import { createClient } from "@supabase/supabase-js";

process.loadEnvFile();

const symbol = "BTCUSDT";
const interval = "1m";
const limit = 1000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "fib_pivot_daily";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el .env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

async function getKlinesLast6Days({ start, endTime }) {
    let startTime = start;
    const all = [];

    while (true) {
        const url =
            `https://fapi.binance.com/fapi/v1/klines` +
            `?symbol=${symbol}&interval=${interval}&limit=${limit}` +
            `&startTime=${startTime}&endTime=${endTime}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const klines = await res.json();

        if (!Array.isArray(klines) || klines.length === 0) break;

        all.push(...klines);

        const lastOpenTime = klines[klines.length - 1][0];
        if (lastOpenTime === startTime) break;

        startTime = lastOpenTime + 1;

        if (startTime >= endTime) break;
        if (klines.length < limit) break;
    }

    // estrictamente < endTime para no meter la vela de 00:00 del día siguiente
    return all.filter(k => k[0] >= start && k[0] < endTime);
}

function calcDailyStats(klines) {
    const byDay = new Map();

    for (const k of klines) {
        const openTime = k[0];
        const high = Number(k[2]);
        const low = Number(k[3]);
        const close = Number(k[4]);

        if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;

        const dayKey = new Date(openTime).toISOString().slice(0, 10); // UTC day

        if (!byDay.has(dayKey)) {
            byDay.set(dayKey, {
                day: dayKey,
                maxHigh: -Infinity,
                minLow: Infinity,
                lastOpenTime: -Infinity,
                closeDay: null,
                count: 0,
            });
        }

        const d = byDay.get(dayKey);

        if (high > d.maxHigh) d.maxHigh = high;
        if (low < d.minLow) d.minLow = low;

        if (openTime > d.lastOpenTime) {
            d.lastOpenTime = openTime;
            d.closeDay = close;
        }

        d.count += 1;
    }

    return [...byDay.values()]
        .filter(d => d.count > 0 && Number.isFinite(d.maxHigh) && Number.isFinite(d.minLow) && Number.isFinite(d.closeDay))
        .map(d => ({
            day: d.day,
            maxHigh: d.maxHigh,
            minLow: d.minLow,
            avgDayMid: (d.maxHigh + d.minLow) / 2,
            closeDay: d.closeDay,
            candles: d.count,
        }))
        .sort((a, b) => a.day.localeCompare(b.day));
}

// Helpers
function top2By(arr, key) {
    return [...arr].sort((a, b) => b[key] - a[key]).slice(0, 2);
}
function bottom2By(arr, key) {
    return [...arr].sort((a, b) => a[key] - b[key]).slice(0, 2);
}
function avg2(items, key) {
    if (items.length === 0) return null;
    if (items.length === 1) return items[0][key];
    return (items[0][key] + items[1][key]) / 2;
}
function medianEvenAvg(arr, key) {
    const sorted = [...arr].sort((a, b) => a[key] - b[key]);
    const n = sorted.length;
    if (n === 0) return { avg: null, center: [] };
    if (n % 2 === 1) {
        const mid = Math.floor(n / 2);
        return { avg: sorted[mid][key], center: [sorted[mid]] };
    }
    const mid1 = n / 2 - 1;
    const mid2 = n / 2;
    return { avg: (sorted[mid1][key] + sorted[mid2][key]) / 2, center: [sorted[mid1], sorted[mid2]] };
}

async function saveToSupabase(row) {
    // upsert por unique (symbol, base_day, interval)
    const { data, error } = await supabase
        .from(SUPABASE_TABLE)
        .upsert(row, { onConflict: "symbol,base_day,interval" })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function run() {
    // 6 días COMPLETOS: [start, endTime) donde endTime = hoy 00:00 UTC
    const now = new Date();
    const endTime = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const start = endTime - 6 * 24 * 60 * 60 * 1000;

    const klines = await getKlinesLast6Days({ start, endTime });
    if (!klines.length) {
        console.log("No hay velas en el rango.");
        return;
    }

    const daily = calcDailyStats(klines);
    const dailyFull = daily.filter(d => d.candles === 1440);

    if (dailyFull.length < 1) {
        console.log("No hay días completos suficientes para pivots.");
        return;
    }

    // Resumen 6 días (solo días completos)
    const top2Max = top2By(dailyFull, "maxHigh");
    const max6d = avg2(top2Max, "maxHigh");

    const bot2Min = bottom2By(dailyFull, "minLow");
    const min6d = avg2(bot2Min, "minLow");

    const medObj = medianEvenAvg(dailyFull, "avgDayMid");
    const avg6d = medObj.avg;

    // Pivot diario clásico: base = último día completo (ayer)
    const prevDay = dailyFull[dailyFull.length - 1];

    const H = prevDay.maxHigh;
    const L = prevDay.minLow;
    const C = prevDay.closeDay;

    const PP = (H + L + C) / 3;
    const range = H - L;

    const R1 = PP + range * 0.382;
    const R2 = PP + range * 0.618;
    const R3 = PP + range * 1.0;

    const S1 = PP - range * 0.382;
    const S2 = PP - range * 0.618;
    const S3 = PP - range * 1.0;

    const row = {
        symbol,
        interval,
        run_ts: new Date().toISOString(),
        base_day: prevDay.day, // 'YYYY-MM-DD'

        h: H,
        l: L,
        c: C,

        pp: PP,
        r1: R1,
        r2: R2,
        r3: R3,
        s1: S1,
        s2: S2,
        s3: S3,

        max6d,
        min6d,
        avg6d,

        days_full: dailyFull.length,
        days_total: daily.length,
        end_time_ms: endTime,
        start_time_ms: start,
    };

    const saved = await saveToSupabase(row);

    console.log("✅ Guardado en Supabase:", {
        id: saved.id,
        symbol: saved.symbol,
        base_day: saved.base_day,
        pp: saved.pp,
    });
}

run().catch(err => {
    console.error("❌ Error:", err.message || err);
    process.exitCode = 1;
});