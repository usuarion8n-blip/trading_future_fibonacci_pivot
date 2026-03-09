import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";

try { process.loadEnvFile(); } catch { }

// ======================
// Config
// ======================
const SYMBOL_WS = process.env.SYMBOL_WS || "btcusdt";
const SYMBOL_DB = process.env.SYMBOL_DB || "BTCUSDT";
const INTERVAL = process.env.INTERVAL || "1m";

const REST_BASE = process.env.BINANCE_REST_BASE || "https://fapi.binance.com";

const WS_COMBINED_BASE =
    REST_BASE.includes("demo-fapi.binance.com")
        ? "wss://stream.binancefuture.com/stream?streams="
        : "wss://fstream.binance.com/stream?streams=";

// VWAP necesita precio + volumen.
// Usamos:
// - bookTicker => para bid/ask en tiempo real
// - kline_1m   => para volumen y precio típico de la vela actual
const WS_URL = `${WS_COMBINED_BASE}${SYMBOL_WS}@bookTicker/${SYMBOL_WS}@kline_1m`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TRADES_TABLE = process.env.TRADES_TABLE || "sim_trades";

// SIMULACIÓN FORZADA
const DRY_RUN = true;

// Señal VWAP
const TOUCH_BUFFER_BPS = Number(process.env.TOUCH_BUFFER_BPS ?? 2);   // distancia máxima para considerar "toque"
const REBOUND_BPS = Number(process.env.REBOUND_BPS ?? 6);             // rebote mínimo
const CONFIRM_TICKS = Number(process.env.CONFIRM_TICKS ?? 3);         // cantidad de ticks confirmando rebote
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? (2 * 60_000));

// Gestión de trade simulado
const TP_PCT = Number(process.env.TP_PCT ?? 0.0015);                  // 0.15%
const SL_PCT = Number(process.env.SL_PCT ?? 0.0015);                  // 0.15%
const QTY_BTC = Number(process.env.QTY_BTC ?? 0.0001);
const MAX_OPEN_TRADES = Number(process.env.MAX_OPEN_TRADES ?? 1);

// Logs
const PRINT_EVERY_MS = Number(process.env.PRINT_EVERY_MS ?? 5000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

// ======================
// Helpers
// ======================
async function publicRequest(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `${REST_BASE}${path}${qs ? `?${qs}` : ""}`;

    const res = await fetch(url);
    const text = await res.text();

    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!res.ok) throw new Error(`Binance HTTP ${res.status} ${res.statusText}: ${text}`);
    return json;
}

function bpsDistance(price, refPrice) {
    return ((price - refPrice) / refPrice) * 10_000;
}

function getUtcDayStartMs(ts = Date.now()) {
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

function getUtcDayStr(ts = Date.now()) {
    return new Date(ts).toISOString().slice(0, 10);
}

function typicalPriceFromOHLC(h, l, c) {
    return (Number(h) + Number(l) + Number(c)) / 3;
}

// ======================
// VWAP state
// ======================
// VWAP de sesión UTC
let sessionDay = getUtcDayStr();
let sessionPVClosed = 0; // suma de (precio_tipico * volumen) de velas cerradas
let sessionVolClosed = 0; // suma de volumen de velas cerradas

// Vela actual en curso
let currentKline = null;

// Último VWAP calculado
let currentVWAP = null;

// Último bid/ask
let lastBid = null;
let lastAsk = null;

let prevDistBps = null;
let lastClosedKlineOpenTime = null;

async function loadInitialVWAPState() {
    const now = Date.now();
    const dayStart = getUtcDayStartMs(now);
    const currentMinuteStart = Math.floor(now / 60000) * 60000;

    const klines = await publicRequest("/fapi/v1/klines", {
        symbol: SYMBOL_DB,
        interval: "1m",
        startTime: String(dayStart),
        endTime: String(now),
        limit: "1500",
    });

    sessionPVClosed = 0;
    sessionVolClosed = 0;
    currentKline = null;
    currentVWAP = null;
    sessionDay = getUtcDayStr(now);

    for (const k of klines) {
        const openTime = Number(k[0]);
        const high = Number(k[2]);
        const low = Number(k[3]);
        const close = Number(k[4]);
        const volume = Number(k[5]);

        if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) || !Number.isFinite(volume)) {
            continue;
        }

        const tp = typicalPriceFromOHLC(high, low, close);

        if (openTime < currentMinuteStart) {
            sessionPVClosed += tp * volume;
            sessionVolClosed += volume;
        } else {
            currentKline = {
                openTime,
                high,
                low,
                close,
                volume,
            };
        }
    }

    recalcVWAP();

    console.log("✅ VWAP inicial cargado:", {
        sessionDay,
        sessionPVClosed,
        sessionVolClosed,
        currentKline,
        currentVWAP,
    });
}

function recalcVWAP() {
    let pv = sessionPVClosed;
    let vol = sessionVolClosed;

    if (currentKline && Number(currentKline.volume) > 0) {
        const tp = typicalPriceFromOHLC(currentKline.high, currentKline.low, currentKline.close);
        pv += tp * Number(currentKline.volume);
        vol += Number(currentKline.volume);
    }

    currentVWAP = vol > 0 ? pv / vol : null;
}

function resetVWAPSessionIfNeeded() {
    const today = getUtcDayStr();
    if (today !== sessionDay) {
        sessionDay = today;
        sessionPVClosed = 0;
        sessionVolClosed = 0;
        currentKline = null;
        currentVWAP = null;

        detectorTouched = false;
        detectorConfirm = 0;
        detectorTouchSide = null;
        lastClosedKlineOpenTime = null;
        prevDistBps = null;

        console.log("🔄 Nueva sesión UTC. Reiniciando VWAP...");
    }
}

function handleKlineUpdate(k) {
    resetVWAPSessionIfNeeded();

    const openTime = Number(k.t);
    const high = Number(k.h);
    const low = Number(k.l);
    const close = Number(k.c);
    const volume = Number(k.v);
    const isClosed = Boolean(k.x);

    if (![openTime, high, low, close, volume].every(Number.isFinite)) return;

    if (!currentKline || currentKline.openTime !== openTime) {
        currentKline = { openTime, high, low, close, volume };
    } else {
        currentKline.high = high;
        currentKline.low = low;
        currentKline.close = close;
        currentKline.volume = volume;
    }

    if (isClosed && lastClosedKlineOpenTime !== openTime) {
        const tp = typicalPriceFromOHLC(high, low, close);
        sessionPVClosed += tp * volume;
        sessionVolClosed += volume;
        lastClosedKlineOpenTime = openTime;
        currentKline = null;
    }

    recalcVWAP();
}

// ======================
// Trade tracker
// ======================
const openTrades = new Map(); // id -> state
let openingTrade = false;
const lastSignalAt = new Map(); // cooldown por lado

function canOpenNewTrade() {
    return openTrades.size < MAX_OPEN_TRADES;
}

// ======================
// Detector VWAP
// ======================
// Lógica:
// 1. precio toca VWAP
// 2. se identifica desde qué lado llegó
// 3. si rebota y confirma => abre trade simulado
//
// Caso LONG:
// - tocó desde arriba
// - rebota hacia arriba
//
// Caso SHORT:
// - tocó desde abajo
// - rebota hacia abajo
let detectorTouched = false;
let detectorConfirm = 0;
let detectorTouchSide = null; // "ABOVE" | "BELOW"

// ======================
// Sim open / close
// ======================
async function openTradeSim({ side, bid, ask, vwap, distBps }) {
    if (openingTrade) return null;
    openingTrade = true;

    try {
        const cdKey = `${sessionDay}:VWAP:${side}`;
        const nowMs = Date.now();
        const last = lastSignalAt.get(cdKey) || 0;
        if (nowMs - last < COOLDOWN_MS) return null;

        if (!canOpenNewTrade()) return null;
        if (!Number.isFinite(vwap)) return null;

        lastSignalAt.set(cdKey, nowMs);

        const entryPrice = side === "LONG" ? ask : bid;
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

        const tpDelta = entryPrice * TP_PCT;
        const slDelta = entryPrice * SL_PCT;

        const tpPrice = side === "LONG" ? entryPrice + tpDelta : entryPrice - tpDelta;
        const slPrice = side === "LONG" ? entryPrice - slDelta : entryPrice + slDelta;

        const entryTs = new Date().toISOString();

        const row = {
            symbol: SYMBOL_DB,
            interval: INTERVAL,
            pivot_base_day: sessionDay, // reutilizamos esta columna para guardar el día de sesión
            level: "VWAP",
            side,
            entry_ts: entryTs,
            entry_price: entryPrice,
            entry_bid: bid,
            entry_ask: ask,
            tp_price: tpPrice,
            sl_price: slPrice,
            status: "OPEN",
            meta: {
                source: "bookTicker+kline_1m",
                strategy: "VWAP_TOUCH_REBOUND_SIM",
                dry_run: true,
                vwap_at_entry: vwap,
                distance_bps_at_signal: Number(distBps.toFixed(2)),
                tp_pct: TP_PCT,
                sl_pct: SL_PCT,
                qty_btc: QTY_BTC,
                touch_buffer_bps: TOUCH_BUFFER_BPS,
                rebound_bps: REBOUND_BPS,
                confirm_ticks: CONFIRM_TICKS,
                session_day_utc: sessionDay,
            },
        };

        const { data, error } = await supabase.from(TRADES_TABLE).insert(row).select().single();
        if (error) {
            console.error("❌ Supabase insert failed:", error.message);
            return null;
        }

        openTrades.set(data.id, {
            id: data.id,
            side,
            level: "VWAP",
            entryPrice,
            tpPrice,
            slPrice,
            entryTs,
            qty: QTY_BTC,
            meta: row.meta,
            sessionDay,
        });

        console.log("🧪 SIM TRADE OPENED", {
            id: data.id,
            side,
            entryPrice,
            tpPrice,
            slPrice,
            qty: QTY_BTC,
            vwap,
        });

        return data.id;
    } finally {
        openingTrade = false;
    }
}

async function closeTradeSim(id, t, reason, bid, ask) {
    let exitPrice;

    if (reason === "TP") {
        exitPrice = t.tpPrice;
    } else if (reason === "SL") {
        exitPrice = t.slPrice;
    } else {
        exitPrice = t.side === "LONG" ? bid : ask;
    }

    const exitTs = new Date().toISOString();

    const pnl = t.side === "LONG"
        ? (exitPrice - t.entryPrice) * t.qty
        : (t.entryPrice - exitPrice) * t.qty;

    const patch = {
        status: "CLOSED",
        exit_ts: exitTs,
        exit_price: exitPrice,
        exit_reason: reason,
        exit_bid: bid,
        exit_ask: ask,
        pnl_usdt: pnl,
        meta: {
            ...(t.meta || {}),
            exit_reason: reason,
            exit_price: exitPrice,
            exit_ts: exitTs,
            exit_bid: bid,
            exit_ask: ask,
            pnl_usdt: pnl,
        },
    };

    const { error } = await supabase.from(TRADES_TABLE).update(patch).eq("id", id);
    if (error) {
        console.error("❌ Supabase close update failed:", error.message);
        return;
    }

    openTrades.delete(id);

    console.log("🔴 SIM TRADE CLOSED", {
        id,
        reason,
        side: t.side,
        entry: t.entryPrice,
        exit: exitPrice,
        pnl_usdt: Number(pnl.toFixed(8)),
    });
}

async function reconcileOpenTradesSim({ bid, ask }) {
    if (openTrades.size === 0) return;
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;

    for (const [id, t] of openTrades.entries()) {
        try {
            if (t.side === "LONG") {
                // LONG entra por ask y sale observando bid
                if (bid >= t.tpPrice) {
                    await closeTradeSim(id, t, "TP", bid, ask);
                    continue;
                }
                if (bid <= t.slPrice) {
                    await closeTradeSim(id, t, "SL", bid, ask);
                    continue;
                }
            } else {
                // SHORT entra por bid y sale observando ask
                if (ask <= t.tpPrice) {
                    await closeTradeSim(id, t, "TP", bid, ask);
                    continue;
                }
                if (ask >= t.slPrice) {
                    await closeTradeSim(id, t, "SL", bid, ask);
                    continue;
                }
            }
        } catch (e) {
            console.error("❌ reconcile sim error:", e.message);
        }
    }
}

async function restoreOpenTrades() {
    const { data, error } = await supabase
        .from(TRADES_TABLE)
        .select("id, side, level, entry_price, tp_price, sl_price, entry_ts, meta, pivot_base_day")
        .eq("symbol", SYMBOL_DB)
        .eq("status", "OPEN")
        .order("entry_ts", { ascending: false })
        .limit(MAX_OPEN_TRADES);

    if (error) {
        console.error("❌ Error restaurando OPEN trades:", error.message);
        return;
    }

    const today = getUtcDayStr();

    for (const r of data || []) {
        if (r.pivot_base_day !== today) continue;

        openTrades.set(r.id, {
            id: r.id,
            side: r.side,
            level: r.level,
            entryPrice: Number(r.entry_price),
            tpPrice: Number(r.tp_price),
            slPrice: Number(r.sl_price),
            entryTs: r.entry_ts,
            qty: Number(r.meta?.qty_btc ?? QTY_BTC),
            meta: r.meta || {},
            sessionDay: r.pivot_base_day,
        });
    }

    console.log("♻️ Restored OPEN sim trades:", openTrades.size);
}

// ======================
// Core signal logic
// ======================
async function processQuote({ bid, ask }) {
    if (!Number.isFinite(currentVWAP)) return;

    const midPrice = (bid + ask) / 2;
    const distBps = bpsDistance(midPrice, currentVWAP);
    const absBps = Math.abs(distBps);

    if (!detectorTouched && absBps <= TOUCH_BUFFER_BPS) {
        detectorTouched = true;
        detectorConfirm = 0;

        if (prevDistBps !== null) {
            detectorTouchSide = prevDistBps > 0 ? "FROM_ABOVE" : "FROM_BELOW";
        } else {
            detectorTouchSide = distBps >= 0 ? "FROM_ABOVE" : "FROM_BELOW";
        }

        prevDistBps = distBps;
        return;
    }

    if (!detectorTouched) {
        prevDistBps = distBps;
        return;
    }

    // 2) Confirmación de rebote
    if (detectorTouchSide === "FROM_ABOVE" && distBps >= REBOUND_BPS) {
        detectorConfirm = detectorConfirm >= 0 ? detectorConfirm + 1 : 1;

        if (detectorConfirm >= CONFIRM_TICKS) {
            const openedId = await openTradeSim({
                side: "LONG",
                bid,
                ask,
                vwap: currentVWAP,
                distBps,
            });

            if (openedId) {
                detectorTouched = false;
                detectorConfirm = 0;
                detectorTouchSide = null;
                prevDistBps = null;
            }
        }
    }
    else if (detectorTouchSide === "FROM_BELOW" && distBps <= -REBOUND_BPS) {
        detectorConfirm = detectorConfirm <= 0 ? detectorConfirm - 1 : -1;

        if (Math.abs(detectorConfirm) >= CONFIRM_TICKS) {
            const openedId = await openTradeSim({
                side: "SHORT",
                bid,
                ask,
                vwap: currentVWAP,
                distBps,
            });

            if (openedId) {
                detectorTouched = false;
                detectorConfirm = 0;
                detectorTouchSide = null;
                prevDistBps = null;
            }
        }
    }
    else if (
        (detectorTouchSide === "FROM_ABOVE" && distBps <= -REBOUND_BPS) ||
        (detectorTouchSide === "FROM_BELOW" && distBps >= REBOUND_BPS)
    ) {
        detectorTouched = false;
        detectorConfirm = 0;
        detectorTouchSide = null;
    }
    else {
        detectorConfirm = 0;
    }

    prevDistBps = distBps;

    // 4) invalidación por alejarse demasiado sin estructura clara
    if (absBps > 50) {
        detectorTouched = false;
        detectorConfirm = 0;
        detectorTouchSide = null;
    }
}

let lastPrintTs = 0;

function printStatus({ bid, ask }) {
    const now = Date.now();
    if (now - lastPrintTs < PRINT_EVERY_MS) return;
    lastPrintTs = now;

    const ts = new Date().toISOString();
    const mid = (bid + ask) / 2;
    const dist = Number.isFinite(currentVWAP) ? bpsDistance(mid, currentVWAP) : null;

    console.log(
        `${ts}` +
        ` DRY_RUN=1` +
        ` BID=${bid}` +
        ` ASK=${ask}` +
        ` MID=${mid}` +
        ` VWAP=${currentVWAP ?? "null"}` +
        ` DIST_BPS=${dist !== null ? dist.toFixed(2) : "null"}` +
        ` touched=${detectorTouched ? 1 : 0}` +
        ` touchSide=${detectorTouchSide || "-"}` +
        ` confirm=${detectorConfirm}` +
        ` openTrades=${openTrades.size}`
    );
}

// ======================
// WebSocket
// ======================
let attempt = 0;

function startWS() {
    attempt += 1;
    console.log(`[${new Date().toISOString()}] Conectando (intento ${attempt}) → ${WS_URL}`);

    const ws = new WebSocket(WS_URL, { handshakeTimeout: 15000, perMessageDeflate: false });

    ws.on("open", () => {
        console.log(`[${new Date().toISOString()}] ✅ OPEN`);
        attempt = 0;
    });

    ws.on("message", async (raw) => {
        try {
            const msg = JSON.parse(raw.toString());

            const stream = msg?.stream;
            const data = msg?.data;

            if (!stream || !data) return;

            // bookTicker
            if (stream.endsWith("@bookTicker")) {
                const bid = Number(data.b);
                const ask = Number(data.a);
                if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;

                lastBid = bid;
                lastAsk = ask;

                printStatus({ bid, ask });
                await reconcileOpenTradesSim({ bid, ask });
                await processQuote({ bid, ask });
                return;
            }

            // kline_1m
            if (stream.endsWith("@kline_1m")) {
                if (!data.k) return;
                handleKlineUpdate(data.k);
                return;
            }
        } catch (e) {
            console.error("❌ WS message error:", e.message);
        }
    });

    ws.on("close", (code, reason) => {
        console.log(`🔌 CLOSE code=${code} reason=${reason?.toString?.() || ""}`);
        const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(5, attempt)));
        setTimeout(startWS, delay);
    });

    ws.on("error", (err) => {
        console.error("❌ WS error:", err.message || err);
        try { ws.close(); } catch { }
    });

    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 60_000);

    ws.on("close", () => clearInterval(pingInterval));
}

// ======================
// Boot
// ======================
await loadInitialVWAPState();
await restoreOpenTrades();
startWS();