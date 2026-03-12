import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

try { process.loadEnvFile(); } catch { }

// ======================
// Binance REST signed
// ======================
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const REST_BASE = process.env.BINANCE_REST_BASE || "https://fapi.binance.com";
const RECV_WINDOW = Number(process.env.RECV_WINDOW ?? 5000);

const WS_COMBINED_BASE =
    REST_BASE.includes("demo-fapi.binance.com")
        ? "wss://stream.binancefuture.com/stream?streams="
        : "wss://fstream.binance.com/stream?streams=";

if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    throw new Error("Faltan BINANCE_API_KEY / BINANCE_API_SECRET");
}

function sign(queryString) {
    return crypto.createHmac("sha256", BINANCE_API_SECRET).update(queryString).digest("hex");
}

async function signedRequest(method, path, params = {}) {
    const timestamp = Date.now();
    const qs = new URLSearchParams({
        ...params,
        timestamp: String(timestamp),
        recvWindow: String(RECV_WINDOW),
    }).toString();

    const signature = sign(qs);
    const url = `${REST_BASE}${path}?${qs}&signature=${signature}`;

    const res = await fetch(url, {
        method,
        headers: { "X-MBX-APIKEY": BINANCE_API_KEY },
    });

    const text = await res.text();

    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!res.ok) {
        throw new Error(`Binance HTTP ${res.status} ${res.statusText}: ${text}`);
    }
    return json;
}

async function placeConditionalAlgo({
    symbol, side, orderType, triggerPrice, quantity, priceDec, qtyDec
}) {
    const params = {
        algoType: "CONDITIONAL",
        symbol,
        side,
        type: orderType, // TAKE_PROFIT_MARKET | STOP_MARKET
        triggerPrice: fmt(triggerPrice, priceDec),
        quantity: fmt(quantity, qtyDec),
        reduceOnly: "true",
        workingType: "CONTRACT_PRICE",
        newOrderRespType: "RESULT",
    };

    return signedRequest("POST", "/fapi/v1/algoOrder", params);
}

// ======================
// Config
// ======================
const SYMBOL_WS = process.env.SYMBOL_WS || "btcusdt";
const SYMBOL_DB = process.env.SYMBOL_DB || "BTCUSDT";
const INTERVAL = process.env.INTERVAL || "1m";

const WS_URL = `${WS_COMBINED_BASE}${SYMBOL_WS}@bookTicker/${SYMBOL_WS}@kline_1m`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TRADES_TABLE = process.env.TRADES_TABLE || "sim_trades";

// REAL / SIM
const DRY_RUN = String(process.env.DRY_RUN ?? "1") === "1";
const ARMED = String(process.env.ARMED ?? "0") === "1";

if (!DRY_RUN && !ARMED) {
    throw new Error("Bloqueado: DRY_RUN=0 pero ARMED!=1");
}

// Señal VWAP estilo soporte/resistencia
const TOUCH_BUFFER_BPS = Number(process.env.TOUCH_BUFFER_BPS ?? 2);
const REBOUND_BPS = Number(process.env.REBOUND_BPS ?? 6);
const CONFIRM_TICKS = Number(process.env.CONFIRM_TICKS ?? 3);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? (2 * 60_000));

// Gestión de trade
const TP_PCT = Number(process.env.TP_PCT ?? 0.0015);
const SL_PCT = Number(process.env.SL_PCT ?? 0.0015);
const QTY_BTC = Number(process.env.QTY_BTC ?? 0.0001);
const MAX_OPEN_TRADES = Number(process.env.MAX_OPEN_TRADES ?? 1);

// Logs / reconciliación
const PRINT_EVERY_MS = Number(process.env.PRINT_EVERY_MS ?? 5000);
const RECONCILE_EVERY_MS = Number(process.env.RECONCILE_EVERY_MS ?? 3000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

// ======================
// Exchange filters (tick/step)
// ======================
let TICK_SIZE = null;
let STEP_SIZE = null;
let MIN_QTY = null;
let TICK_SIZE_STR = null;
let STEP_SIZE_STR = null;

function decimalsFromStep(stepStr) {
    const s = String(stepStr);
    const dot = s.indexOf(".");
    if (dot === -1) return 0;
    const frac = s.slice(dot + 1).replace(/0+$/, "");
    return frac.length;
}

function floorToStep(value, step) {
    const v = Number(value);
    const st = Number(step);
    if (!Number.isFinite(v) || !Number.isFinite(st) || st <= 0) return v;
    return Math.floor(v / st) * st;
}

function roundToTick(value, tick) {
    const v = Number(value);
    const tk = Number(tick);
    if (!Number.isFinite(v) || !Number.isFinite(tk) || tk <= 0) return v;
    return Math.round(v / tk) * tk;
}

function fmt(value, decimals) {
    return Number(value).toFixed(decimals);
}

async function loadSymbolFilters() {
    const info = await publicRequest("/fapi/v1/exchangeInfo", { symbol: SYMBOL_DB });
    const s = info?.symbols?.[0];
    if (!s) throw new Error("No pude leer exchangeInfo.symbols[0]");

    const priceFilter = s.filters.find(f => f.filterType === "PRICE_FILTER");
    const lotFilter = s.filters.find(f => f.filterType === "LOT_SIZE");

    MIN_QTY = Number(lotFilter?.minQty);
    TICK_SIZE_STR = priceFilter?.tickSize;
    STEP_SIZE_STR = lotFilter?.stepSize;

    TICK_SIZE = Number(TICK_SIZE_STR);
    STEP_SIZE = Number(STEP_SIZE_STR);

    if (!Number.isFinite(TICK_SIZE) || !Number.isFinite(STEP_SIZE) || !Number.isFinite(MIN_QTY)) {
        throw new Error("No pude obtener tickSize/stepSize/minQty de exchangeInfo");
    }

    console.log("✅ exchangeInfo:", {
        symbol: SYMBOL_DB,
        tickSize: TICK_SIZE,
        stepSize: STEP_SIZE,
        minQty: MIN_QTY,
    });
}

// ======================
// Helpers públicos
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
let sessionDay = getUtcDayStr();
let sessionPVClosed = 0;
let sessionVolClosed = 0;

let currentKline = null;

let currentVWAP = null;
let previousVWAP = null;

let lastBid = null;
let lastAsk = null;

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
    previousVWAP = null;
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
        previousVWAP,
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

    previousVWAP = currentVWAP;
    currentVWAP = vol > 0 ? pv / vol : null;
}

// ======================
// Detector state
// ======================
let detectorTouched = false;
let detectorConfirm = 0;
let detectorTouchSide = null; // ABOVE | BELOW

function resetVWAPSessionIfNeeded() {
    const today = getUtcDayStr();
    if (today !== sessionDay) {
        sessionDay = today;
        sessionPVClosed = 0;
        sessionVolClosed = 0;
        currentKline = null;
        currentVWAP = null;
        previousVWAP = null;

        detectorTouched = false;
        detectorConfirm = 0;
        detectorTouchSide = null;
        lastClosedKlineOpenTime = null;

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
const openTrades = new Map();
let openingTrade = false;
const lastSignalAt = new Map();

function canOpenNewTrade() {
    return openTrades.size < MAX_OPEN_TRADES;
}

// ======================
// REAL OPEN + TP/SL
// ======================
async function openTradeReal({ side, bid, ask, vwap, distBps }) {
    if (openingTrade) {
        console.log("⏳ openTradeReal skipped: ya hay una apertura en curso");
        return null;
    }

    openingTrade = true;

    try {
        const cdKey = `${sessionDay}:VWAP:${side}`;
        const nowMs = Date.now();
        const last = lastSignalAt.get(cdKey) || 0;

        if (nowMs - last < COOLDOWN_MS) return null;
        if (!canOpenNewTrade()) return null;
        if (!Number.isFinite(vwap)) return null;

        const qtyRaw = QTY_BTC;
        const qtyDec = decimalsFromStep(STEP_SIZE_STR);
        const qtyAdj = Number(fmt(floorToStep(qtyRaw, STEP_SIZE), qtyDec));

        if (qtyAdj < MIN_QTY) {
            console.log("⛔ qty < minQty, skip", { qtyRaw, qtyAdj, minQty: MIN_QTY });
            return null;
        }

        const entrySide = side === "LONG" ? "BUY" : "SELL";
        const closeSide = side === "LONG" ? "SELL" : "BUY";

        if (DRY_RUN) {
            console.log("🧪 DRY_RUN openTradeReal", { side, level: "VWAP", qtyAdj });
            return null;
        }

        let entryOrder;
        try {
            entryOrder = await signedRequest("POST", "/fapi/v1/order", {
                symbol: SYMBOL_DB,
                side: entrySide,
                type: "MARKET",
                quantity: fmt(qtyAdj, qtyDec),
                newOrderRespType: "RESULT",
            });
        } catch (e) {
            console.error("❌ Entry order failed:", e.message);
            return null;
        }

        let entryPrice = Number(entryOrder?.avgPrice);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            entryPrice = Number(side === "LONG" ? ask : bid);
        }

        const entryTs = new Date().toISOString();

        const tpDelta = entryPrice * TP_PCT;
        const slDelta = entryPrice * SL_PCT;

        let tpPrice = side === "LONG" ? entryPrice + tpDelta : entryPrice - tpDelta;
        let slPrice = side === "LONG" ? entryPrice - slDelta : entryPrice + slDelta;

        tpPrice = roundToTick(tpPrice, TICK_SIZE);
        slPrice = roundToTick(slPrice, TICK_SIZE);

        const priceDec = decimalsFromStep(TICK_SIZE_STR);

        let tpOrder = null;
        let slOrder = null;

        try {
            tpOrder = await placeConditionalAlgo({
                symbol: SYMBOL_DB,
                side: closeSide,
                orderType: "TAKE_PROFIT_MARKET",
                triggerPrice: tpPrice,
                quantity: qtyAdj,
                priceDec,
                qtyDec,
            });

            slOrder = await placeConditionalAlgo({
                symbol: SYMBOL_DB,
                side: closeSide,
                orderType: "STOP_MARKET",
                triggerPrice: slPrice,
                quantity: qtyAdj,
                priceDec,
                qtyDec,
            });
        } catch (e) {
            console.error("❌ TP/SL failed, emergency close:", e.message);

            try {
                await signedRequest("POST", "/fapi/v1/order", {
                    symbol: SYMBOL_DB,
                    side: closeSide,
                    type: "MARKET",
                    reduceOnly: "true",
                    quantity: fmt(qtyAdj, qtyDec),
                    newOrderRespType: "RESULT",
                });
                console.error("🧯 Emergency close sent.");
            } catch (e2) {
                console.error("🧨 Emergency close FAILED:", e2.message);
            }
            return null;
        }

        const row = {
            symbol: SYMBOL_DB,
            interval: INTERVAL,
            pivot_base_day: sessionDay,
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
                strategy: "VWAP_AS_SUPPORT_RESISTANCE_REAL",
                dry_run: false,
                pivot_price: vwap,
                previous_pivot_price: previousVWAP,
                distance_bps_at_signal: Number(distBps.toFixed(2)),
                tp_pct: TP_PCT,
                sl_pct: SL_PCT,
                qty_btc: qtyAdj,
                touch_buffer_bps: TOUCH_BUFFER_BPS,
                rebound_bps: REBOUND_BPS,
                confirm_ticks: CONFIRM_TICKS,
                session_day_utc: sessionDay,
                detector_touch_side: detectorTouchSide,
                entry_order_id: entryOrder?.orderId ?? null,
                tp_algo_id: tpOrder?.algoId ?? null,
                sl_algo_id: slOrder?.algoId ?? null,
                binance_entry_order: entryOrder,
                binance_tp_order: tpOrder,
                binance_sl_order: slOrder,
            },
        };

        const { data, error } = await supabase.from(TRADES_TABLE).insert(row).select().single();
        if (error) {
            console.error("❌ Supabase insert failed:", error.message);
            return null;
        }

        lastSignalAt.set(cdKey, nowMs);

        openTrades.set(data.id, {
            id: data.id,
            side,
            level: "VWAP",
            entryPrice,
            tpPrice,
            slPrice,
            entryTs,
            qty: qtyAdj,
            meta: row.meta,
            sessionDay,
            entryOrderId: entryOrder?.orderId ?? null,
            tpAlgoId: tpOrder?.algoId ?? null,
            slAlgoId: slOrder?.algoId ?? null,
        });

        detectorTouched = false;
        detectorConfirm = 0;
        detectorTouchSide = null;

        console.log("✅ REAL TRADE OPENED", {
            id: data.id,
            side,
            level: "VWAP",
            entryPrice,
            tpPrice,
            slPrice,
            qty: qtyAdj,
            tpAlgoId: tpOrder?.algoId,
            slAlgoId: slOrder?.algoId,
        });

        return data.id;
    } finally {
        openingTrade = false;
    }
}

// ======================
// Reconcile TP/SL fills (polling)
// ======================
async function cancelAlgoSafe(algoId) {
    if (!algoId) return;
    try {
        await signedRequest("DELETE", "/fapi/v1/algoOrder", { algoId: String(algoId) });
    } catch { }
}

async function getOrderStatus(orderId) {
    if (!orderId) return null;
    return signedRequest("GET", "/fapi/v1/order", {
        symbol: SYMBOL_DB,
        orderId: String(orderId),
    });
}

async function getAlgoStatus(algoId) {
    return signedRequest("GET", "/fapi/v1/algoOrder", { algoId: String(algoId) });
}

function pickAlgoObj(resp) {
    if (!resp) return null;

    if (Array.isArray(resp)) return resp[0] ?? null;
    if (Array.isArray(resp?.data)) return resp.data[0] ?? null;
    if (Array.isArray(resp?.rows)) return resp.rows[0] ?? null;
    if (Array.isArray(resp?.algoOrders)) return resp.algoOrders[0] ?? null;
    if (Array.isArray(resp?.list)) return resp.list[0] ?? null;

    if (resp?.data && typeof resp.data === "object" && !Array.isArray(resp.data)) {
        return resp.data;
    }

    return resp;
}

function sumTradeQty(trades) {
    return (trades || []).reduce((acc, t) => acc + Number(t.qty || 0), 0);
}

function sumTradeCommissionUsdt(trades) {
    return (trades || []).reduce((acc, t) => {
        const asset = String(t.commissionAsset || "");
        const commission = Math.abs(Number(t.commission || 0));
        if (asset === "USDT") return acc + commission;
        return acc;
    }, 0);
}

function weightedAveragePrice(trades, fallbackPrice) {
    const totalQty = sumTradeQty(trades);
    if (!totalQty) return Number(fallbackPrice || 0);

    const totalNotional = (trades || []).reduce((acc, t) => {
        return acc + Number(t.price || 0) * Number(t.qty || 0);
    }, 0);

    return totalNotional / totalQty;
}

function sumRealizedPnl(trades) {
    return (trades || []).reduce((acc, t) => acc + Number(t.realizedPnl || 0), 0);
}

async function getUserTradesByOrderId(symbol, orderId) {
    if (!orderId) return [];
    try {
        const resp = await signedRequest("GET", "/fapi/v1/userTrades", {
            symbol,
            orderId: String(orderId),
        });
        return Array.isArray(resp) ? resp : [];
    } catch (e) {
        console.error("❌ getUserTradesByOrderId failed:", {
            symbol,
            orderId,
            error: e.message,
        });
        return [];
    }
}

async function reconcileOpenTrades() {
    if (DRY_RUN) return;
    if (openTrades.size === 0) return;

    for (const [id, t] of openTrades.entries()) {
        try {
            const tpAlgoRaw = t.tpAlgoId ? await getAlgoStatus(t.tpAlgoId) : null;
            const slAlgoRaw = t.slAlgoId ? await getAlgoStatus(t.slAlgoId) : null;

            const tpAlgo = pickAlgoObj(tpAlgoRaw);
            const slAlgo = pickAlgoObj(slAlgoRaw);

            const tpOrderId = tpAlgo?.orderId || tpAlgo?.actualOrderId || tpAlgo?.triggeredOrderId;
            const slOrderId = slAlgo?.orderId || slAlgo?.actualOrderId || slAlgo?.triggeredOrderId;

            if (!tpOrderId && !slOrderId) continue;

            const reason = tpOrderId ? "TP" : "SL";
            const triggeredOrderId = tpOrderId || slOrderId;

            const real = await getOrderStatus(triggeredOrderId);
            if (real?.status !== "FILLED") continue;

            if (reason === "TP") await cancelAlgoSafe(t.slAlgoId);
            if (reason === "SL") await cancelAlgoSafe(t.tpAlgoId);

            const entryTrades = t.entryOrderId
                ? await getUserTradesByOrderId(SYMBOL_DB, t.entryOrderId)
                : [];

            const exitTrades = triggeredOrderId
                ? await getUserTradesByOrderId(SYMBOL_DB, triggeredOrderId)
                : [];

            let entryPrice = weightedAveragePrice(entryTrades, t.entryPrice);
            if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
                entryPrice = Number(t.entryPrice);
            }

            let exitPrice = weightedAveragePrice(exitTrades, real?.avgPrice);
            if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
                exitPrice = t.side === "LONG"
                    ? (lastBid ?? t.tpPrice ?? t.entryPrice)
                    : (lastAsk ?? t.tpPrice ?? t.entryPrice);
            }

            const exitTs = new Date().toISOString();

            const entryQtyReal = sumTradeQty(entryTrades);
            const exitQtyReal = sumTradeQty(exitTrades);
            const pnlQty = entryQtyReal > 0 ? entryQtyReal : (exitQtyReal > 0 ? exitQtyReal : t.qty);

            const grossPnl = t.side === "LONG"
                ? (exitPrice - entryPrice) * pnlQty
                : (entryPrice - exitPrice) * pnlQty;

            const entryFeesUsdt = sumTradeCommissionUsdt(entryTrades);
            const exitFeesUsdt = sumTradeCommissionUsdt(exitTrades);
            const feesUsdt = entryFeesUsdt + exitFeesUsdt;

            const netPnl = grossPnl - feesUsdt;
            const realizedPnlBinance = sumRealizedPnl(exitTrades);

            const patch = {
                status: "CLOSED",
                exit_ts: exitTs,
                exit_price: exitPrice,
                exit_reason: reason,
                exit_bid: lastBid,
                exit_ask: lastAsk,
                pnl_usdt: Number(grossPnl.toFixed(8)),
                meta: {
                    ...(t.meta || {}),
                    exit_reason: reason,
                    exit_price: exitPrice,
                    exit_ts: exitTs,
                    exit_bid: lastBid,
                    exit_ask: lastAsk,

                    gross_pnl_usdt: Number(grossPnl.toFixed(8)),
                    fees_usdt: Number(feesUsdt.toFixed(8)),
                    net_pnl_usdt: Number(netPnl.toFixed(8)),
                    pnl_usdt: Number(netPnl.toFixed(8)),

                    entry_fees_usdt: Number(entryFeesUsdt.toFixed(8)),
                    exit_fees_usdt: Number(exitFeesUsdt.toFixed(8)),
                    entry_price_effective: Number(entryPrice.toFixed(8)),
                    exit_price_effective: Number(exitPrice.toFixed(8)),
                    qty_closed_btc: Number(pnlQty.toFixed(8)),
                    realized_pnl_binance_usdt: Number(realizedPnlBinance.toFixed(8)),

                    entry_trades_count: entryTrades.length,
                    exit_trades_count: exitTrades.length,
                    binance_entry_trades: entryTrades,
                    binance_exit_trades: exitTrades,

                    binance_exit_order: real,
                    binance_exit_order_id: real?.orderId,
                    binance_exit_update_time: real?.updateTime,
                    binance_tp_algo: tpAlgo,
                    binance_sl_algo: slAlgo,
                },
            };

            const { error } = await supabase.from(TRADES_TABLE).update(patch).eq("id", id);
            if (error) {
                console.error("❌ Supabase close update failed:", error.message);
                continue;
            }

            openTrades.delete(id);

            console.log("🔴 TRADE CLOSED (algo reconciled)", {
                id,
                reason,
                side: t.side,
                entry: Number(entryPrice.toFixed(6)),
                exit: Number(exitPrice.toFixed(6)),
                gross_pnl_usdt: Number(grossPnl.toFixed(6)),
                fees_usdt: Number(feesUsdt.toFixed(6)),
                net_pnl_usdt: Number(netPnl.toFixed(6)),
                realized_pnl_binance_usdt: Number(realizedPnlBinance.toFixed(6)),
            });
        } catch (e) {
            console.error("❌ reconcile error:", e.message);
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
            entryOrderId:
                r.meta?.binance_entry_order?.orderId ??
                r.meta?.entry_order_id ??
                null,
            tpAlgoId:
                r.meta?.tp_algo_id ??
                r.meta?.binance_tp_order?.algoId ??
                r.meta?.binance_tp_order?.id ??
                null,
            slAlgoId:
                r.meta?.sl_algo_id ??
                r.meta?.binance_sl_order?.algoId ??
                r.meta?.binance_sl_order?.id ??
                null,
        });
    }

    console.log("♻️ Restored OPEN trades:", openTrades.size);
}

// ======================
// Core signal logic
// VWAP tratado como soporte/resistencia
// ======================
async function processQuote({ bid, ask }) {
    if (!Number.isFinite(currentVWAP)) return;

    const levelPrice = currentVWAP;
    const midPrice = (bid + ask) / 2;

    const distBps = bpsDistance(midPrice, levelPrice);
    const absBps = Math.abs(distBps);

    // TOUCH
    if (!detectorTouched && absBps <= TOUCH_BUFFER_BPS) {
        detectorTouched = true;
        detectorConfirm = 0;
        detectorTouchSide = distBps >= 0 ? "ABOVE" : "BELOW";
        return;
    }

    if (detectorTouched) {
        const prev = detectorConfirm || 0;
        const touchSide = detectorTouchSide;

        // REBOTE ALCISTA
        if (touchSide === "ABOVE" && distBps >= REBOUND_BPS) {
            const next = prev >= 0 ? prev + 1 : 1;
            detectorConfirm = next;

            if (next >= CONFIRM_TICKS) {
                const openedId = await openTradeReal({
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
                }
            }
        }

        // REBOTE BAJISTA
        else if (touchSide === "BELOW" && distBps <= -REBOUND_BPS) {
            const next = prev <= 0 ? prev - 1 : -1;
            detectorConfirm = next;

            if (Math.abs(next) >= CONFIRM_TICKS) {
                const openedId = await openTradeReal({
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
                }
            }
        }

        // INVALIDACIÓN POR RUPTURA
        else if (
            (touchSide === "ABOVE" && distBps <= -REBOUND_BPS) ||
            (touchSide === "BELOW" && distBps >= REBOUND_BPS)
        ) {
            detectorTouched = false;
            detectorConfirm = 0;
            detectorTouchSide = null;
        }

        else {
            detectorConfirm = 0;
        }

        if (absBps > 50) {
            detectorTouched = false;
            detectorConfirm = 0;
            detectorTouchSide = null;
        }
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
        ` DRY_RUN=${DRY_RUN ? 1 : 0}` +
        ` BID=${bid}` +
        ` ASK=${ask}` +
        ` MID=${mid}` +
        ` PREV_VWAP=${previousVWAP ?? "null"}` +
        ` VWAP=${currentVWAP ?? "null"}` +
        ` DIST_BPS=${dist !== null ? dist.toFixed(2) : "null"}` +
        ` touched=${detectorTouched ? 1 : 0}` +
        ` touchSide=${detectorTouchSide || "-"}` +
        ` confirm=${detectorConfirm}` +
        ` openTrades=${openTrades.size}` +
        ` openingTrade=${openingTrade ? 1 : 0}`
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
await loadSymbolFilters();
await loadInitialVWAPState();
await restoreOpenTrades();

setInterval(reconcileOpenTrades, RECONCILE_EVERY_MS);

startWS();