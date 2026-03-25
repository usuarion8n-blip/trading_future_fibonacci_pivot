import WebSocket from "ws";
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
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

    let res;
    let text;

    try {
        res = await fetchWithTimeout(
            url,
            { method, headers: { "X-MBX-APIKEY": BINANCE_API_KEY } },
            10000
        );
        text = await res.text();
    } catch (e) {
        console.error("❌ signedRequest fetch error:", {
            method,
            path,
            message: e?.message,
            cause: e?.cause,
        });
        throw e;
    }

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

async function publicRequest(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `${REST_BASE}${path}${qs ? `?${qs}` : ""}`;

    let res;
    let text;

    try {
        res = await fetchWithTimeout(url, {}, 10000);
        text = await res.text();
    } catch (e) {
        console.error("❌ publicRequest fetch error:", {
            path,
            message: e?.message,
            cause: e?.cause,
        });
        throw e;
    }

    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!res.ok) throw new Error(`Binance HTTP ${res.status} ${res.statusText}: ${text}`);
    return json;
}

// ======================
// Config
// ======================
const DRY_RUN = String(process.env.DRY_RUN ?? "1") === "1";

const SYMBOL_WS = process.env.SYMBOL_WS || "btcusdt";
const SYMBOL_DB = process.env.SYMBOL_DB || "BTCUSDT";
const INTERVAL = process.env.INTERVAL || "1m";
const WS_URL = `${WS_BASE}/${SYMBOL_WS}@bookTicker`;

const API_TRADES_URL = process.env.API_TRADES_URL || "http://localhost:3000";

// ======================
// Ownership / strategy segregation
// ======================
const STRATEGY_NAME = process.env.STRATEGY_NAME || "PIVOT_SR";
const SERVICE_NAME = process.env.SERVICE_NAME || "pivot_sr_service";

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

function makeTradeGroupId() {
    return crypto.randomUUID();
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
        strategy_name: STRATEGY_NAME,
        service_name: SERVICE_NAME,
    });
}

// ======================
// Pivots loader
// ======================
async function loadRecentPivots(days = 2) {
    const res = await fetchWithTimeout(`${API_TRADES_URL}/api/pivots/recent?limit=${days}&symbol=${SYMBOL_DB}&interval=${INTERVAL}`);

    if (!res.ok) {
        throw new Error(`API pivots fetch error: ${res.status}`);
    }

    const json = await res.json();
    const data = json.data;

    if (!data || data.length === 0) {
        throw new Error("No hay pivots en API (api_trades).");
    }

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
const openTrades = new Map();
let lockedLevelKey = null;
let openingTrade = false;
let temporaryLockTimeout = null;

const CROSS_NO_REBOUND_BLOCK_MS = Number(
    process.env.CROSS_NO_REBOUND_BLOCK_MS ?? (15 * 60_000)
);

function clearTemporaryLockTimer() {
    if (temporaryLockTimeout) {
        clearTimeout(temporaryLockTimeout);
        temporaryLockTimeout = null;
    }
}

function lockLevelTemporarily(baseDay, level, reason = "CROSS_NO_REBOUND") {
    const nextKey = levelKey(baseDay, level);
    const previous = lockedLevelKey;

    // este nuevo lock reemplaza cualquier lock anterior
    lockedLevelKey = nextKey;

    // si había timer anterior, se cancela
    clearTemporaryLockTimer();

    const blockedUntil = new Date(Date.now() + CROSS_NO_REBOUND_BLOCK_MS).toISOString();

    console.log("🚫 Temporary locked level changed:", {
        previous,
        current: lockedLevelKey,
        reason,
        blockedUntil,
        strategy_name: STRATEGY_NAME,
        service_name: SERVICE_NAME,
    });

    temporaryLockTimeout = setTimeout(() => {
        if (lockedLevelKey === nextKey) {
            lockedLevelKey = null;
            console.log("🔓 Temporary locked level expired:", {
                released: nextKey,
                reason,
                strategy_name: STRATEGY_NAME,
                service_name: SERVICE_NAME,
            });
        }
        temporaryLockTimeout = null;
    }, CROSS_NO_REBOUND_BLOCK_MS);
}

// ======================
// Locked level, actualizar nivel bloqueado
// ======================

function updateLockedLevel(baseDay, level) {
    const nextKey = levelKey(baseDay, level);
    const prevKey = lockedLevelKey;

    // si existía un lock temporal, lo reemplazamos por uno permanente
    clearTemporaryLockTimer();

    lockedLevelKey = nextKey;

    if (prevKey !== nextKey) {
        console.log("🔒 Locked level changed:", {
            previous: prevKey,
            current: lockedLevelKey,
            lock_type: "TRADE_SUCCESS",
            strategy_name: STRATEGY_NAME,
            service_name: SERVICE_NAME,
        });
    } else {
        console.log("🔒 Locked level remains:", {
            current: lockedLevelKey,
            lock_type: "TRADE_SUCCESS",
            strategy_name: STRATEGY_NAME,
            service_name: SERVICE_NAME,
        });
    }
}

function levelKey(baseDay, level) {
    return `${baseDay}:${level}`;
}

function isUniqueOpenViolation(error) {
    const msg = String(error?.message || "").toLowerCase();
    return (
        error?.code === "23505" ||
        msg.includes("duplicate key") ||
        msg.includes("unique") ||
        msg.includes("uq_") ||
        msg.includes("open")
    );
}

async function reserveOpenTradeInDb({
    side,
    level,
    levelPrice,
    distBps,
    bid,
    ask,
    pivot_base_day_used,
    qtyAdj,
    tradeGroupId,
}) {
    const entryTs = new Date().toISOString();

    const row = {
        symbol: SYMBOL_DB,
        interval: INTERVAL,
        strategy_name: STRATEGY_NAME,
        service_name: SERVICE_NAME,
        trade_group_id: tradeGroupId,
        pivot_base_day: pivot_base_day_used,
        level,
        side,
        entry_ts: entryTs,
        entry_price: 0,
        entry_bid: bid,
        entry_ask: ask,
        tp_price: 0,
        sl_price: 0,
        status: "OPEN",
        meta: {
            strategy_name: STRATEGY_NAME,
            service_name: SERVICE_NAME,
            trade_group_id: tradeGroupId,
            source: "bookTicker",
            pivot_price: levelPrice,
            distance_bps_at_signal: Number(distBps.toFixed(2)),
            tp_pct: TP_PCT,
            sl_pct: SL_PCT,
            qty_btc: qtyAdj,
            trade_state: "RESERVED",
            entry_order_id: null,
            tp_algo_id: null,
            sl_algo_id: null,
            binance_entry_order: null,
            binance_tp_order: null,
            binance_sl_order: null,
        },
    };

    const res = await fetchWithTimeout(`${API_TRADES_URL}/api/trades`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
    });

    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.message || "Failed reserving trade in API");
    return json.data;
}

async function finalizeReservedTradeInDb({
    id,
    entryPrice,
    tpPrice,
    slPrice,
    entryOrder,
    tpOrder,
    slOrder,
}) {
    try {

        // 1) Leer meta actual a través del nuevo endpoint por ID
        const resTrade = await fetchWithTimeout(`${API_TRADES_URL}/api/trades/${id}`);
        let currentMeta = {};
        if (resTrade.ok) {
            const tradeJson = await resTrade.json();
            if (tradeJson.data?.meta) currentMeta = tradeJson.data.meta;
        }

        // 2) Merge del meta anterior + nuevos campos
        const patch = {
            entry_price: entryPrice,
            tp_price: tpPrice,
            sl_price: slPrice,
            meta: {
                ...currentMeta,
                trade_state: "LIVE",
                entry_order_id: entryOrder?.orderId ?? null,
                tp_algo_id: tpOrder?.algoId ?? null,
                sl_algo_id: slOrder?.algoId ?? null,
                binance_entry_order: entryOrder,
                binance_tp_order: tpOrder,
                binance_sl_order: slOrder,
            },
        };

        const res = await fetchWithTimeout(`${API_TRADES_URL}/api/trades/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        });

        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || "Failed finalizing trade in API");
        return json.data;
    } catch (e) {
        console.error("❌ finalizeReservedTradeInDb fetch error:", e?.message || e);
        throw e;
    }
}

async function closeReservedTradeAsFailed(id, failureReason, extraMeta = {}) {
    try {
        const resTrade = await fetchWithTimeout(`${API_TRADES_URL}/api/trades/${id}`);
        let currentMeta = {};
        if (resTrade.ok) {
            const tradeJson = await resTrade.json();
            if (tradeJson.data?.meta) currentMeta = tradeJson.data.meta;
        }

        // 2) Merge del meta anterior + estado de fallo
        const patch = {
            status: "CLOSED",
            exit_ts: new Date().toISOString(),
            exit_reason: failureReason,
            pnl_usdt: 0,
            meta: {
                ...currentMeta,
                trade_state: "FAILED_BEFORE_LIVE",
                failure_reason: failureReason,
                ...extraMeta,
            },
        };

        const res = await fetchWithTimeout(`${API_TRADES_URL}/api/trades/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        });
        if (!res.ok) {
            console.error("❌ closeReservedTradeAsFailed API error:", await res.text());
        }
    } catch (e) {
        console.error("❌ closeReservedTradeAsFailed fetch error:", e.message);
    }
}

function canOpenNewTrade() {
    return openTrades.size < MAX_OPEN_TRADES;
}

const lastSignalAt = new Map();

// detector per (baseDay:level)
const detectorTouched = new Map();
const detectorConfirm = new Map();
const detectorTouchSide = new Map();

function detKey(baseDay, level) {
    return `${baseDay}:${level}`;
}

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
        if (!canOpenNewTrade()) return null;
        if (!pivot_base_day_used) return null;

        const qtyRaw = QTY_BTC;
        const qtyDec = decimalsFromStep(STEP_SIZE_STR);
        const qtyAdj = Number(fmt(floorToStep(qtyRaw, STEP_SIZE), qtyDec));

        if (qtyAdj < MIN_QTY) {
            console.log("⛔ qty < minQty, skip", { qtyRaw, qtyAdj, minQty: MIN_QTY });
            return null;
        }

        const tradeGroupId = makeTradeGroupId();

        // ==================================================
        // 1) PRIMERO RESERVAR EL OPEN EN LA API
        // ==================================================
        let reservedTrade;
        try {
            reservedTrade = await reserveOpenTradeInDb({
                side,
                level,
                levelPrice,
                distBps,
                bid,
                ask,
                pivot_base_day_used,
                qtyAdj,
                tradeGroupId,
            });
        } catch (e) {
            // Apply cooldown and clear detector even if DB fails, to prevent infinite loops
            lastSignalAt.set(cdKey, nowMs);
            detectorTouched.clear();
            detectorConfirm.clear();
            detectorTouchSide.clear();


            if (isUniqueOpenViolation(e)) {
                console.log("⛔ Otro servicio ya reservó un OPEN para este símbolo. No opero.", {
                    symbol: SYMBOL_DB,
                    strategy_name: STRATEGY_NAME,
                    service_name: SERVICE_NAME,
                });
                return null;
            }

            console.error("❌ No pude reservar OPEN en la API. No opero en Binance.", {
                symbol: SYMBOL_DB,
                strategy_name: STRATEGY_NAME,
                service_name: SERVICE_NAME,
                error: e?.message || e,
            });
            return null;
        }

        // Desde aquí, este servicio ganó el lock lógico en BD
        lastSignalAt.set(cdKey, nowMs);

        if (DRY_RUN) {
            openTrades.set(reservedTrade.id, {
                id: reservedTrade.id,
                strategyName: STRATEGY_NAME,
                serviceName: SERVICE_NAME,
                tradeGroupId,
                side,
                level,
                entryPrice: null,
                tpPrice: null,
                slPrice: null,
                entryTs: reservedTrade.entry_ts,
                qty: qtyAdj,
                meta: reservedTrade.meta || {},
                pivot_base_day_used,
                entryOrderId: null,
                tpAlgoId: null,
                slAlgoId: null,
            });

            updateLockedLevel(pivot_base_day_used, level);
            detectorTouched.clear();
            detectorConfirm.clear();
            detectorTouchSide.clear();

            console.log("🧪 DRY_RUN RESERVED TRADE", {
                id: reservedTrade.id,
                symbol: SYMBOL_DB,
                side,
                level,
                qty: qtyAdj,
            });

            return reservedTrade.id;
        }

        const entrySide = side === "LONG" ? "BUY" : "SELL";
        const closeSide = side === "LONG" ? "SELL" : "BUY";

        // ==================================================
        // 2) LUEGO OPERAR EN BINANCE
        // ==================================================
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
            console.error("❌ Entry order failed after API reservation:", e.message);

            await closeReservedTradeAsFailed(reservedTrade.id, "ENTRY_ORDER_FAILED", {
                entry_error: e.message,
            });

            return null;
        }

        let entryPrice = Number(entryOrder?.avgPrice);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            entryPrice = Number(side === "LONG" ? ask : bid);
        }

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
            console.error("❌ TP/SL failed after Binance entry:", e.message);

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

            await closeReservedTradeAsFailed(reservedTrade.id, "TP_SL_CREATION_FAILED", {
                entry_order_id: entryOrder?.orderId ?? null,
                tp_sl_error: e.message,
            });

            return null;
        }

        // ==================================================
        // 3) ACTUALIZAR EL MISMO REGISTRO OPEN EN LA API
        // ==================================================
        let data;
        try {
            data = await finalizeReservedTradeInDb({
                id: reservedTrade.id,
                entryPrice,
                tpPrice,
                slPrice,
                entryOrder,
                tpOrder,
                slOrder,
            });
        } catch (e) {
            console.error("❌ No pude finalizar trade OPEN en la API después de Binance:", e.message);

            await cancelAlgoSafe(tpOrder?.algoId ?? null);
            await cancelAlgoSafe(slOrder?.algoId ?? null);

            try {
                await signedRequest("POST", "/fapi/v1/order", {
                    symbol: SYMBOL_DB,
                    side: closeSide,
                    type: "MARKET",
                    reduceOnly: "true",
                    quantity: fmt(qtyAdj, qtyDec),
                    newOrderRespType: "RESULT",
                });
                console.error("🧯 Emergency close sent after finalize failure.");
            } catch (e2) {
                console.error("🧨 Emergency close FAILED after finalize failure:", e2.message);
            }

            await closeReservedTradeAsFailed(reservedTrade.id, "FINALIZE_DB_FAILED", {
                entry_order_id: entryOrder?.orderId ?? null,
                tp_algo_id: tpOrder?.algoId ?? null,
                sl_algo_id: slOrder?.algoId ?? null,
                finalize_error: e.message,
            });

            return null;
        }

        openTrades.set(data.id, {
            id: data.id,
            strategyName: STRATEGY_NAME,
            serviceName: SERVICE_NAME,
            tradeGroupId,
            side,
            level,
            entryPrice,
            tpPrice,
            slPrice,
            entryTs: data.entry_ts,
            qty: qtyAdj,
            meta: {
                ...(reservedTrade.meta || {}),
                ...(data.meta || {}),
            },
            pivot_base_day_used,
            entryOrderId: entryOrder?.orderId ?? null,
            tpAlgoId: tpOrder?.algoId ?? null,
            slAlgoId: slOrder?.algoId ?? null,
        });

        updateLockedLevel(pivot_base_day_used, level);

        detectorTouched.clear();
        detectorConfirm.clear();
        detectorTouchSide.clear();

        console.log("✅ REAL TRADE OPENED", {
            id: data.id,
            strategy_name: STRATEGY_NAME,
            service_name: SERVICE_NAME,
            trade_group_id: tradeGroupId,
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
// Reconcile helpers
// ======================
async function cancelOrderSafe(orderId) {
    if (!orderId) return;
    try {
        await signedRequest("DELETE", "/fapi/v1/order", {
            symbol: SYMBOL_DB,
            orderId: String(orderId),
        });
    } catch { }
}

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

async function getPositionRisk(symbol) {
    try {
        const resp = await signedRequest("GET", "/fapi/v2/positionRisk", { symbol });

        if (Array.isArray(resp)) return resp[0] ?? null;
        return resp ?? null;
    } catch (e) {
        console.error("❌ getPositionRisk failed:", {
            symbol,
            error: e.message,
        });
        return null;
    }
}

function isPositionFlat(positionRisk) {
    if (!positionRisk) return null;
    const amt = Number(positionRisk.positionAmt ?? 0);
    return Math.abs(amt) < 1e-12;
}

async function getRecentUserTrades(symbol, limit = 200) {
    try {
        const resp = await signedRequest("GET", "/fapi/v1/userTrades", {
            symbol,
            limit: String(limit),
        });
        return Array.isArray(resp) ? resp : [];
    } catch (e) {
        console.error("❌ getRecentUserTrades failed:", {
            symbol,
            error: e.message,
        });
        return [];
    }
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

function tradeTimeMs(t) {
    return Number(t.time ?? t.timestamp ?? 0);
}

function groupExitTradesForSide(trades, side) {
    const expectedSide = side === "LONG" ? "SELL" : "BUY";
    return (trades || []).filter(t => String(t.side || "").toUpperCase() === expectedSide);
}

function filterTradesAfterEntry(trades, entryTs) {
    const entryMs = new Date(entryTs).getTime();
    return (trades || []).filter(t => tradeTimeMs(t) >= entryMs);
}

function sortTradesAsc(trades) {
    return [...(trades || [])].sort((a, b) => tradeTimeMs(a) - tradeTimeMs(b));
}

function takeTradesUntilQty(trades, targetQty) {
    const out = [];
    let acc = 0;

    for (const t of sortTradesAsc(trades)) {
        const q = Number(t.qty || 0);
        if (q <= 0) continue;

        out.push(t);
        acc += q;

        if (acc + 1e-12 >= targetQty) break;
    }

    return out;
}

function detectFallbackExitReason(exitTrades, side, tpPrice, slPrice) {
    if (!exitTrades?.length) return "BINANCE_CLOSED_FALLBACK";

    const exitPx = weightedAveragePrice(exitTrades, 0);
    if (!Number.isFinite(exitPx) || exitPx <= 0) return "BINANCE_CLOSED_FALLBACK";

    const distTp = Math.abs(exitPx - Number(tpPrice || 0));
    const distSl = Math.abs(exitPx - Number(slPrice || 0));

    if (Number.isFinite(distTp) && Number.isFinite(distSl)) {
        return distTp <= distSl ? "TP_FALLBACK" : "SL_FALLBACK";
    }

    return "BINANCE_CLOSED_FALLBACK";
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

// ======================
// Reconcile OPEN trades
// ======================
async function reconcileOpenTrades() {
    if (DRY_RUN) return;
    if (openTrades.size === 0) return;

    for (const [id, t] of openTrades.entries()) {
        try {
            let reason = null;
            let triggeredOrderId = null;
            let real = null;
            let tpAlgo = null;
            let slAlgo = null;
            let entryTrades = [];
            let exitTrades = [];

            // =========================
            // A) Intento normal vía algoOrder
            // =========================
            try {
                const tpAlgoRaw = t.tpAlgoId ? await getAlgoStatus(t.tpAlgoId) : null;
                const slAlgoRaw = t.slAlgoId ? await getAlgoStatus(t.slAlgoId) : null;

                tpAlgo = pickAlgoObj(tpAlgoRaw);
                slAlgo = pickAlgoObj(slAlgoRaw);

                const tpOrderId = tpAlgo?.orderId || tpAlgo?.actualOrderId || tpAlgo?.triggeredOrderId;
                const slOrderId = slAlgo?.orderId || slAlgo?.actualOrderId || slAlgo?.triggeredOrderId;

                if (tpOrderId || slOrderId) {
                    reason = tpOrderId ? "TP" : "SL";
                    triggeredOrderId = tpOrderId ? tpOrderId : slOrderId;

                    real = await getOrderStatus(triggeredOrderId);
                    if (real?.status !== "FILLED") {
                        real = null;
                        triggeredOrderId = null;
                        reason = null;
                    }
                }
            } catch (e) {
                console.error("⚠️ normal algo reconcile failed, using fallback:", e.message);
            }

            // =========================
            // B) Fallback por posición real en Binance
            // =========================
            if (!triggeredOrderId) {
                const positionRisk = await getPositionRisk(SYMBOL_DB);
                const flat = isPositionFlat(positionRisk);

                // si la posición real todavía existe, no cierres en la API
                if (flat === false) {
                    continue;
                }
                if (flat === null) {
                    console.error("⚠️ No pude determinar si la posición está flat");
                    continue;
                }

                // si está flat, reconstruimos salida usando userTrades
                entryTrades = t.entryOrderId
                    ? await getUserTradesByOrderId(SYMBOL_DB, t.entryOrderId)
                    : [];

                const recentTrades = await getRecentUserTrades(SYMBOL_DB, 200);
                const candidateExitTrades = takeTradesUntilQty(
                    filterTradesAfterEntry(
                        groupExitTradesForSide(recentTrades, t.side),
                        t.entryTs
                    ),
                    t.qty
                );

                if (!candidateExitTrades.length) {
                    console.error("⚠️ Position is flat but no exit trades found yet", {
                        id,
                        strategy_name: STRATEGY_NAME,
                        service_name: SERVICE_NAME,
                        entryTs: t.entryTs,
                        side: t.side,
                    });
                    continue;
                }

                exitTrades = candidateExitTrades;
                reason = detectFallbackExitReason(exitTrades, t.side, t.tpPrice, t.slPrice);

                real = {
                    status: "FILLED",
                    orderId: exitTrades[0]?.orderId ?? null,
                    avgPrice: weightedAveragePrice(exitTrades, 0),
                    updateTime: tradeTimeMs(exitTrades[exitTrades.length - 1]),
                };
            } else {
                entryTrades = t.entryOrderId
                    ? await getUserTradesByOrderId(SYMBOL_DB, t.entryOrderId)
                    : [];

                exitTrades = triggeredOrderId
                    ? await getUserTradesByOrderId(SYMBOL_DB, triggeredOrderId)
                    : [];
            }

            // =========================
            // C) Cancelar algo opuesto solo si fue cierre normal TP/SL
            // =========================
            if (reason === "TP") await cancelAlgoSafe(t.slAlgoId);
            if (reason === "SL") await cancelAlgoSafe(t.tpAlgoId);

            // =========================
            // D) Calcular precios / qty / fees / pnl
            // =========================
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

            const exitTs = exitTrades.length
                ? new Date(tradeTimeMs(exitTrades[exitTrades.length - 1])).toISOString()
                : new Date().toISOString();

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

            // =========================
            // E) Update API
            // =========================
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
                    strategy_name: STRATEGY_NAME,
                    service_name: SERVICE_NAME,
                    trade_group_id: t.tradeGroupId ?? t.meta?.trade_group_id ?? null,

                    exit_reason: reason,
                    exit_price: exitPrice,
                    exit_ts: exitTs,
                    exit_bid: lastBid,
                    exit_ask: lastAsk,

                    gross_pnl_usdt: Number(grossPnl.toFixed(8)),
                    fees_usdt: Number(feesUsdt.toFixed(8)),
                    net_pnl_usdt: Number(netPnl.toFixed(8)),
                    pnl_usdt: Number(grossPnl.toFixed(8)),

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

            try {
                const res = await fetchWithTimeout(`${API_TRADES_URL}/api/trades/${id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch),
                });
                if (!res.ok) {
                    console.error("❌ API close update failed:", await res.text());
                    continue;
                }
            } catch (err) {
                console.error("❌ API close update failed:", err.message);
                continue;
            }

            openTrades.delete(id);

            console.log("🔴 TRADE CLOSED (reconciled)", {
                id,
                strategy_name: STRATEGY_NAME,
                service_name: SERVICE_NAME,
                trade_group_id: t.tradeGroupId,
                reason,
                side: t.side,
                entry: Number(entryPrice.toFixed(6)),
                exit: Number(exitPrice.toFixed(6)),
                gross_pnl_usdt: Number(grossPnl.toFixed(6)),
                fees_usdt: Number(feesUsdt.toFixed(6)),
                net_pnl_usdt: Number(netPnl.toFixed(6)),
                realized_pnl_binance_usdt: Number(realizedPnlBinance.toFixed(6)),
                lockedLevelKey,
            });

        } catch (e) {
            console.error("❌ reconcile error:", e.message);
        }
    }
}

async function restoreOpenTrades() {
    let data = [];
    try {
        const res = await fetchWithTimeout(`${API_TRADES_URL}/api/trades?status=OPEN&symbol=${SYMBOL_DB}&strategy_name=${STRATEGY_NAME}&service_name=${SERVICE_NAME}`);
        if (res.ok) {
            const json = await res.json();
            data = (json.data || []).slice(0, MAX_OPEN_TRADES);
        } else {
            console.error("❌ Error restaurando OPEN trades (status API != 200)");
        }
    } catch (e) {
        console.error("❌ Error restaurando OPEN trades:", e.message);
        return;
    }

    for (const r of data || []) {
        openTrades.set(r.id, {
            id: r.id,
            strategyName: r.strategy_name,
            serviceName: r.service_name,
            tradeGroupId: r.trade_group_id ?? r.meta?.trade_group_id ?? null,
            side: r.side,
            level: r.level,
            entryPrice: Number(r.entry_price),
            tpPrice: Number(r.tp_price),
            slPrice: Number(r.sl_price),
            entryTs: r.entry_ts,
            qty: Number(r.meta?.qty_btc ?? QTY_BTC),
            meta: r.meta || {},
            pivot_base_day_used: r.pivot_base_day,
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

    console.log("♻️ Restored OPEN trades:", {
        strategy_name: STRATEGY_NAME,
        service_name: SERVICE_NAME,
        count: openTrades.size,
    });

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

        if (!detectorTouched.get(k) && absBps <= TOUCH_BUFFER_BPS) {
            detectorTouched.set(k, true);
            detectorConfirm.set(k, 0);
            detectorTouchSide.set(k, distBps >= 0 ? "ABOVE" : "BELOW");
            continue;
        }

        if (detectorTouched.get(k)) {
            const prev = detectorConfirm.get(k) || 0;
            const touchSide = detectorTouchSide.get(k);

            if (touchSide === "ABOVE" && distBps >= REBOUND_BPS) {
                const next = prev >= 0 ? prev + 1 : 1;
                detectorConfirm.set(k, next);

                if (next >= CONFIRM_TICKS) {
                    const openedId = await openTradeReal({
                        side: "LONG",
                        level: item.level,
                        levelPrice,
                        distBps,
                        bid,
                        ask,
                        pivot_base_day_used: item.baseDay,
                    });

                    if (openedId) {
                        detectorTouched.set(k, false);
                        detectorConfirm.set(k, 0);
                        detectorTouchSide.delete(k);
                    }
                }
            } else if (touchSide === "BELOW" && distBps <= -REBOUND_BPS) {
                const next = prev <= 0 ? prev - 1 : -1;
                detectorConfirm.set(k, next);

                if (Math.abs(next) >= CONFIRM_TICKS) {
                    const openedId = await openTradeReal({
                        side: "SHORT",
                        level: item.level,
                        levelPrice,
                        distBps,
                        bid,
                        ask,
                        pivot_base_day_used: item.baseDay,
                    });

                    if (openedId) {
                        detectorTouched.set(k, false);
                        detectorConfirm.set(k, 0);
                        detectorTouchSide.delete(k);
                    }
                }
            } else if (
                (touchSide === "ABOVE" && distBps <= -REBOUND_BPS) ||
                (touchSide === "BELOW" && distBps >= REBOUND_BPS)
            ) {
                detectorTouched.set(k, false);
                detectorConfirm.set(k, 0);
                detectorTouchSide.delete(k);

                lockLevelTemporarily(item.baseDay, item.level, "CROSS_NO_REBOUND");

                console.log("🚫 Nivel bloqueado por cruce sin rebote:", {
                    level: item.level,
                    baseDay: item.baseDay,
                    levelPrice,
                    touchSide,
                    distBps: distBps.toFixed(2),
                    lockMs: CROSS_NO_REBOUND_BLOCK_MS,
                    lockedLevelKey,
                    strategy_name: STRATEGY_NAME,
                    service_name: SERVICE_NAME,
                });
            } else {
                detectorConfirm.set(k, 0);
            }

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

    console.log(
        `${ts}` +
        ` strategy=${STRATEGY_NAME}` +
        ` service=${SERVICE_NAME}` +
        ` DRY_RUN=${DRY_RUN ? 1 : 0}` +
        ` BID=${bid}` +
        ` ASK=${ask}` +
        ` MID=${mid}` +
        ` openTrades=${openTrades.size}` +
        ` openingTrade=${openingTrade ? 1 : 0}` +
        ` locked=${lockedLevelKey || "-"}`
    );

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
        let bid, ask;

        try {
            const msg = JSON.parse(raw.toString());
            bid = Number(msg.b);
            ask = Number(msg.a);
            if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;
        } catch (e) {
            console.error("❌ WS parse error:", e.message);
            return;
        }

        lastBid = bid;
        lastAsk = ask;

        printLevels({ bid, ask });

        try {
            await processQuote({ bid, ask });
        } catch (e) {
            console.error("❌ processQuote error:", e?.stack || e?.message || e);
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
await refreshPivots();
await restoreOpenTrades();

setInterval(refreshPivots, 10 * 60_000);
setInterval(reconcileOpenTrades, RECONCILE_EVERY_MS);

startWS();