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

const WS_BASE =
    REST_BASE.includes("demo-fapi.binance.com")
        ? "wss://stream.binancefuture.com/ws"
        : "wss://fstream.binance.com/ws";

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

    const res = await fetch(url, { method, headers: { "X-MBX-APIKEY": BINANCE_API_KEY } });
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
        type: orderType, // "TAKE_PROFIT_MARKET" | "STOP_MARKET"
        triggerPrice: fmt(triggerPrice, priceDec),
        quantity: fmt(quantity, qtyDec),
        reduceOnly: "true",
        workingType: "CONTRACT_PRICE",
        newOrderRespType: "RESULT",
    };

    return signedRequest("POST", "/fapi/v1/algoOrder", params);
}

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

// ======================
// Config
// ======================
const DRY_RUN = String(process.env.DRY_RUN ?? "1") === "1"; // ✅ 1 = no opera, 0 = opera real

const SYMBOL_WS = process.env.SYMBOL_WS || "btcusdt";
const SYMBOL_DB = process.env.SYMBOL_DB || "BTCUSDT";
const INTERVAL = process.env.INTERVAL || "1m";
const WS_URL = `${WS_BASE}/${SYMBOL_WS}@bookTicker`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PIVOT_TABLE = process.env.PIVOT_TABLE || "fib_pivot_daily";
const TRADES_TABLE = process.env.TRADES_TABLE || "sim_trades";

const TOUCH_BUFFER_BPS = Number(process.env.TOUCH_BUFFER_BPS ?? 2);
const REBOUND_BPS = Number(process.env.REBOUND_BPS ?? 6);
const CONFIRM_TICKS = Number(process.env.CONFIRM_TICKS ?? 3);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? (2 * 60_000));

const TP_PCT = Number(process.env.TP_PCT ?? 0.0015);
const SL_PCT = Number(process.env.SL_PCT ?? 0.0015);
const QTY_BTC = Number(process.env.QTY_BTC ?? 0.0001);

const MAX_OPEN_TRADES = Number(process.env.MAX_OPEN_TRADES ?? 1);
const PRINT_EVERY_MS = Number(process.env.PRINT_EVERY_MS ?? 5000);
const RECONCILE_EVERY_MS = Number(process.env.RECONCILE_EVERY_MS ?? 3000);

const ARMED = String(process.env.ARMED ?? "0") === "1";
if (!DRY_RUN && !ARMED) {
    throw new Error("Bloqueado: DRY_RUN=0 pero ARMED!=1");
}

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
    // "0.00100000" -> 3
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
// Pivots loader
// ======================
async function loadRecentPivots(days = 2) {
    const { data, error } = await supabase
        .from(PIVOT_TABLE)
        .select("base_day, pp, r1, r2, r3, s1, s2, s3, symbol, interval, run_ts")
        .eq("symbol", SYMBOL_DB)
        .eq("interval", INTERVAL)
        .order("base_day", { ascending: false })
        .limit(days);

    if (error) throw error;
    if (!data || data.length === 0) throw new Error("No hay pivots en Supabase (fib_pivot_daily).");

    return data.map(row => ({
        baseDay: row.base_day,
        levels: {
            PP: Number(row.pp),
            R1: Number(row.r1),
            R2: Number(row.r2),
            R3: Number(row.r3),
            S1: Number(row.s1),
            S2: Number(row.s2),
            S3: Number(row.s3),
        },
    }));
}

let pivotsList = [];
let lastPrintTs = 0;

async function refreshPivots() {
    try {
        pivotsList = await loadRecentPivots(2);
        console.log("✅ Pivots cargados (2 días):", pivotsList.map(p => p.baseDay).join(", "));
    } catch (e) {
        console.error("❌ No pude cargar pivots:", e.message);
    }
}

// ======================
// Utils
// ======================
function bpsDistance(price, levelPrice) {
    return ((price - levelPrice) / levelPrice) * 10_000;
}

// ======================
// Trade tracker
// ======================
const openTrades = new Map(); // id -> state
let lockedLevelKey = null; // `${baseDay}:${level}`
let openingTrade = false; // evita dobles entradas mientras una apertura está en curso

function updateLockedLevel(baseDay, level) {
    const nextKey = levelKey(baseDay, level);
    const prevKey = lockedLevelKey;

    // solo cambia si realmente es otro nivel
    if (prevKey !== nextKey) {
        lockedLevelKey = nextKey;
        console.log("🔒 Locked level changed:", {
            previous: prevKey,
            current: lockedLevelKey,
        });
    } else {
        console.log("🔒 Locked level remains:", lockedLevelKey);
    }
}

function levelKey(baseDay, level) {
    return `${baseDay}:${level}`;
}

function canOpenNewTrade() {
    return openTrades.size < MAX_OPEN_TRADES;
}

const lastSignalAt = new Map(); // cooldown key -> ts

// detector per (baseDay:level)
const detectorTouched = new Map();
const detectorConfirm = new Map();
const detectorTouchSide = new Map(); // ABOVE | BELOW
function detKey(baseDay, level) {
    return `${baseDay}:${level}`;
}

// último bid/ask para reconciliación
let lastBid = null;
let lastAsk = null;

// ======================
// REAL OPEN + TP/SL
// ======================
async function openTradeReal({ side, level, levelPrice, distBps, bid, ask, pivot_base_day_used }) {
    if (openingTrade) {
        console.log("⏳ openTradeReal skipped: ya hay una apertura en curso");
        return null;
    }

    openingTrade = true;

    try {
        const cdKey = `${pivot_base_day_used}:${level}:${side}`;
        const nowMs = Date.now();
        const last = lastSignalAt.get(cdKey) || 0;
        if (nowMs - last < COOLDOWN_MS) return null;
        lastSignalAt.set(cdKey, nowMs);

        if (!canOpenNewTrade()) return null;
        if (!pivot_base_day_used) return null;

        // qty ajustada a stepSize
        const qtyRaw = QTY_BTC;
        const qtyDec = decimalsFromStep(STEP_SIZE_STR);
        const qtyAdj = Number(fmt(floorToStep(qtyRaw, STEP_SIZE), qtyDec));
        if (qtyAdj < MIN_QTY) {
            console.log("⛔ qty < minQty, skip", { qtyRaw, qtyAdj, minQty: MIN_QTY });
            return null;
        }

        const entrySide = side === "LONG" ? "BUY" : "SELL";
        const closeSide = side === "LONG" ? "SELL" : "BUY";

        // Entry MARKET
        if (DRY_RUN) {
            console.log("🧪 DRY_RUN openTradeReal", { side, level, qtyAdj });
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

        // entryPrice (si avgPrice viene 0, fallback a ask/bid)
        let entryPrice = Number(entryOrder?.avgPrice);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            entryPrice = Number(side === "LONG" ? ask : bid);
        }

        const entryTs = new Date().toISOString();

        // TP/SL por %
        const tpDelta = entryPrice * TP_PCT;
        const slDelta = entryPrice * SL_PCT;

        let tpPrice = side === "LONG" ? entryPrice + tpDelta : entryPrice - tpDelta;
        let slPrice = side === "LONG" ? entryPrice - slDelta : entryPrice + slDelta;

        // redondeo a tickSize
        tpPrice = roundToTick(tpPrice, TICK_SIZE);
        slPrice = roundToTick(slPrice, TICK_SIZE);

        const priceDec = decimalsFromStep(TICK_SIZE_STR);

        // Colocar TP/SL (si falla, cerrar posición inmediatamente)
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

            // intento cerrar inmediatamente para no quedar sin SL
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

        // Guardar en Supabase
        const row = {
            symbol: SYMBOL_DB,
            interval: INTERVAL,
            pivot_base_day: pivot_base_day_used,
            level,
            side,
            entry_ts: entryTs,
            entry_price: entryPrice,
            entry_bid: bid,
            entry_ask: ask,
            tp_price: tpPrice,
            sl_price: slPrice,
            status: "OPEN",
            meta: {
                source: "bookTicker",
                pivot_price: levelPrice,
                distance_bps_at_signal: Number(distBps.toFixed(2)),
                tp_pct: TP_PCT,
                sl_pct: SL_PCT,
                qty_btc: qtyAdj,
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

        openTrades.set(data.id, {
            id: data.id,
            side,
            level,
            entryPrice,
            tpPrice,
            slPrice,
            entryTs,
            qty: qtyAdj,
            meta: row.meta,
            pivot_base_day_used,
            tpAlgoId: tpOrder?.algoId,
            slAlgoId: slOrder?.algoId,
        });

        // lock por nivel:
        // este nivel queda bloqueado hasta que otra oportunidad válida
        // se detecte en otro soporte/resistencia
        updateLockedLevel(pivot_base_day_used, level);

        // limpiar detectores para reiniciar el escaneo
        detectorTouched.clear();
        detectorConfirm.clear();
        detectorTouchSide.clear();

        console.log("✅ REAL TRADE OPENED", {
            id: data.id,
            side,
            level,
            entryPrice,
            tpPrice,
            slPrice,
            qty: qtyAdj,
            tpAlgoId: tpOrder?.algoId,
            slAlgoId: slOrder?.algoId,
            lockedLevelKey,
        });

        return data.id;
    } finally {
        openingTrade = false;
    }
}

// ======================
// Reconcile TP/SL fills (polling)
// ======================
async function cancelOrderSafe(orderId) {
    if (!orderId) return;
    try {
        await signedRequest("DELETE", "/fapi/v1/order", { symbol: SYMBOL_DB, orderId: String(orderId) });
    } catch { /* ignore */ }
}

async function cancelAlgoSafe(algoId) {
    if (!algoId) return;
    try {
        await signedRequest("DELETE", "/fapi/v1/algoOrder", { algoId: String(algoId) });
    } catch { /* ignore */ }
}

async function getOrderStatus(orderId) {
    if (!orderId) return null;
    return signedRequest("GET", "/fapi/v1/order", { symbol: SYMBOL_DB, orderId: String(orderId) });
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

async function reconcileOpenTrades() {
    if (DRY_RUN) return;
    if (openTrades.size === 0) return;

    for (const [id, t] of openTrades.entries()) {
        try {
            // 1) Consultar ALGOs (no /order)
            const tpAlgoRaw = t.tpAlgoId ? await getAlgoStatus(t.tpAlgoId) : null;
            const slAlgoRaw = t.slAlgoId ? await getAlgoStatus(t.slAlgoId) : null;

            const tpAlgo = pickAlgoObj(tpAlgoRaw);
            const slAlgo = pickAlgoObj(slAlgoRaw);

            // 2) Ver si alguno ya generó una orden real (orderId)
            const tpOrderId = tpAlgo?.orderId || tpAlgo?.actualOrderId || tpAlgo?.triggeredOrderId;
            const slOrderId = slAlgo?.orderId || slAlgo?.actualOrderId || slAlgo?.triggeredOrderId;

            // Si ninguno se activó, no hay nada que reconciliar
            if (!tpOrderId && !slOrderId) continue;

            const reason = tpOrderId ? "TP" : "SL";
            const triggeredOrderId = tpOrderId ? tpOrderId : slOrderId;

            // 3) Consultar la ORDEN REAL ya creada por el algo
            const real = await getOrderStatus(triggeredOrderId);
            if (real?.status !== "FILLED") continue;

            // 4) Cancelar el ALGO opuesto (no /order)
            if (reason === "TP") await cancelAlgoSafe(t.slAlgoId);
            if (reason === "SL") await cancelAlgoSafe(t.tpAlgoId);

            // 5) Calcular salida/PnL
            let exitPrice = Number(real?.avgPrice);
            if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
                exitPrice = t.side === "LONG"
                    ? (lastBid ?? t.tpPrice ?? t.entryPrice)
                    : (lastAsk ?? t.tpPrice ?? t.entryPrice);
            }

            const exitTs = new Date().toISOString();
            const pnl = t.side === "LONG"
                ? (exitPrice - t.entryPrice) * t.qty
                : (t.entryPrice - exitPrice) * t.qty;

            // 6) Update Supabase
            const patch = {
                status: "CLOSED",
                exit_ts: exitTs,
                exit_price: exitPrice,
                exit_reason: reason,
                exit_bid: lastBid,
                exit_ask: lastAsk,
                pnl_usdt: pnl,
                meta: {
                    ...(t.meta || {}),
                    exit_reason: reason,
                    exit_price: exitPrice,
                    exit_ts: exitTs,
                    exit_bid: lastBid,
                    exit_ask: lastAsk,
                    pnl_usdt: pnl,
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
                entry: t.entryPrice,
                exit: exitPrice,
                pnl_usdt: Number(pnl.toFixed(6)),
                lockedLevelKey,
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

    for (const r of data || []) {
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
            pivot_base_day_used: r.pivot_base_day,
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

    // restaurar lock (si existe)
    if (openTrades.size > 0 && !lockedLevelKey) {
        const any = openTrades.values().next().value;
        if (any?.pivot_base_day_used && any?.level) {
            lockedLevelKey = levelKey(any.pivot_base_day_used, any.level);
            console.log("🔒 Locked level restored:", lockedLevelKey);
        }
    }
}

// ======================
// Detector
// ======================
async function processQuote({ bid, ask }) {
    if (!pivotsList.length) return;

    const levelsToWatch = [];
    for (const p of pivotsList) {
        levelsToWatch.push(
            { baseDay: p.baseDay, level: "S1", price: p.levels.S1 },
            { baseDay: p.baseDay, level: "S2", price: p.levels.S2 },
            { baseDay: p.baseDay, level: "S3", price: p.levels.S3 },
            { baseDay: p.baseDay, level: "R1", price: p.levels.R1 },
            { baseDay: p.baseDay, level: "R2", price: p.levels.R2 },
            { baseDay: p.baseDay, level: "R3", price: p.levels.R3 },
        );
    }

    const midPrice = (bid + ask) / 2;

    for (const item of levelsToWatch) {
        const lvlKey = levelKey(item.baseDay, item.level);
        if (lockedLevelKey === lvlKey) continue;

        const levelPrice = item.price;
        const distBps = bpsDistance(midPrice, levelPrice);
        const absBps = Math.abs(distBps);
        const k = detKey(item.baseDay, item.level);

        // TOUCH
        if (!detectorTouched.get(k) && absBps <= TOUCH_BUFFER_BPS) {
            detectorTouched.set(k, true);
            detectorConfirm.set(k, 0);
            detectorTouchSide.set(k, distBps >= 0 ? "ABOVE" : "BELOW");
            continue;
        }

        if (detectorTouched.get(k)) {
            const prev = detectorConfirm.get(k) || 0;
            const touchSide = detectorTouchSide.get(k);

            // =========================
            // REBOTE ALCISTA
            // Llegó desde arriba, tocó, y vuelve a quedar arriba
            // =========================
            if (touchSide === "ABOVE" && distBps >= REBOUND_BPS) {
                const next = prev >= 0 ? prev + 1 : 1;
                detectorConfirm.set(k, next);

                if (next >= CONFIRM_TICKS) {
                    await openTradeReal({
                        side: "LONG",
                        level: item.level,
                        levelPrice,
                        distBps,
                        bid,
                        ask,
                        pivot_base_day_used: item.baseDay,
                    });

                    detectorTouched.set(k, false);
                    detectorConfirm.set(k, 0);
                    detectorTouchSide.delete(k);
                }
            }

            // =========================
            // REBOTE BAJISTA
            // Llegó desde abajo, tocó, y vuelve a quedar abajo
            // =========================
            else if (touchSide === "BELOW" && distBps <= -REBOUND_BPS) {
                const next = prev <= 0 ? prev - 1 : -1;
                detectorConfirm.set(k, next);

                if (Math.abs(next) >= CONFIRM_TICKS) {
                    await openTradeReal({
                        side: "SHORT",
                        level: item.level,
                        levelPrice,
                        distBps,
                        bid,
                        ask,
                        pivot_base_day_used: item.baseDay,
                    });

                    detectorTouched.set(k, false);
                    detectorConfirm.set(k, 0);
                    detectorTouchSide.delete(k);
                }
            }

            // =========================
            // Si cruzó al lado contrario, eso parece más ruptura
            // que rebote. Aquí lo invalidamos.
            // =========================
            else if (
                (touchSide === "ABOVE" && distBps <= -REBOUND_BPS) ||
                (touchSide === "BELOW" && distBps >= REBOUND_BPS)
            ) {
                detectorTouched.set(k, false);
                detectorConfirm.set(k, 0);
                detectorTouchSide.delete(k);
            }

            else {
                detectorConfirm.set(k, 0);
            }

            // invalidación por alejarse demasiado sin estructura clara
            if (absBps > 50) {
                detectorTouched.set(k, false);
                detectorConfirm.set(k, 0);
                detectorTouchSide.delete(k);
            }
        }
    }
}

function printLevels({ bid, ask }) {
    if (!pivotsList.length) return;

    const now = Date.now();
    if (now - lastPrintTs < PRINT_EVERY_MS) return;
    lastPrintTs = now;

    const ts = new Date().toISOString();
    const mid = (bid + ask) / 2;

    console.log(`${ts} DRY_RUN=${DRY_RUN ? 1 : 0} BID=${bid} ASK=${ask} MID=${mid} openTrades=${openTrades.size} openingTrade=${openingTrade ? 1 : 0} locked=${lockedLevelKey || "-"}`);

    for (const p of pivotsList) {
        const { S1, S2, S3, R1, R2, R3 } = p.levels;

        console.log(
            `baseDay=${p.baseDay}` +
            ` S3=${S3} midS3bps=${bpsDistance(mid, S3).toFixed(2)}` +
            ` S2=${S2} midS2bps=${bpsDistance(mid, S2).toFixed(2)}` +
            ` S1=${S1} midS1bps=${bpsDistance(mid, S1).toFixed(2)}` +
            ` R1=${R1} midR1bps=${bpsDistance(mid, R1).toFixed(2)}` +
            ` R2=${R2} midR2bps=${bpsDistance(mid, R2).toFixed(2)}` +
            ` R3=${R3} midR3bps=${bpsDistance(mid, R3).toFixed(2)}`
        );
    }
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
        const msg = JSON.parse(raw.toString());
        const bid = Number(msg.b);
        const ask = Number(msg.a);
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;

        lastBid = bid;
        lastAsk = ask;

        printLevels({ bid, ask });
        await processQuote({ bid, ask });
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
await refreshPivots();
await restoreOpenTrades();

setInterval(refreshPivots, 10 * 60_000);
setInterval(reconcileOpenTrades, RECONCILE_EVERY_MS);

startWS();