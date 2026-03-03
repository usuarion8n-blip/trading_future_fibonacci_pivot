import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";

try { process.loadEnvFile(); } catch { }

// ======================
// Env / Config
// ======================
const SYMBOL_WS = process.env.SYMBOL_WS || "btcusdt";
const SYMBOL_DB = process.env.SYMBOL_DB || "BTCUSDT";
const INTERVAL = process.env.INTERVAL || "1m";

const WS_URL = `wss://fstream.binance.com/ws/${SYMBOL_WS}@bookTicker`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PIVOT_TABLE = process.env.PIVOT_TABLE || "fib_pivot_daily";
const TRADES_TABLE = process.env.TRADES_TABLE || "sim_trades";

// detection tuning
const TOUCH_BUFFER_BPS = Number(process.env.TOUCH_BUFFER_BPS ?? 2);
const REBOUND_BPS = Number(process.env.REBOUND_BPS ?? 6);
const CONFIRM_TICKS = Number(process.env.CONFIRM_TICKS ?? 3);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? (2 * 60_000));

// trade rules
const TP_PCT = Number(process.env.TP_PCT ?? 0.0015); // 0.15%
const SL_PCT = Number(process.env.SL_PCT ?? 0.0015); // 0.15% (mismo)
const QTY_BTC = Number(process.env.QTY_BTC ?? 0.0001);

// tracker
const MAX_OPEN_TRADES = Number(process.env.MAX_OPEN_TRADES ?? 1); // 1 para no abrir múltiples a la vez
const PRINT_EVERY_MS = Number(process.env.PRINT_EVERY_MS ?? 5000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

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

        console.log("✅ Pivots cargados (2 días):");
        for (const p of pivotsList) {
            console.log("  - baseDay:", p.baseDay, "levels:", {
                S1: p.levels.S1, S2: p.levels.S2, R1: p.levels.R1, R2: p.levels.R2, PP: p.levels.PP
            });
        }
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
// Trade Tracker (in-memory)
// ======================
// openTrades: Map<tradeId, tradeState>
const openTrades = new Map();

function canOpenNewTrade() {
    return openTrades.size < MAX_OPEN_TRADES;
}

// para evitar spam de señales por nivel+lado
const lastSignalAt = new Map();

async function openTrade({ side, level, levelPrice, distBps, bid, ask, pivot_base_day_used }) {
    const key = `${pivot_base_day_used}:${level}:${side}`;
    const nowMs = Date.now();
    const last = lastSignalAt.get(key) || 0;
    if (nowMs - last < COOLDOWN_MS) return null;
    lastSignalAt.set(key, nowMs);

    if (!canOpenNewTrade()) return null;
    if (!pivot_base_day_used) return null;

    // ✅ entry real
    const entryPrice = side === "LONG" ? ask : bid;
    const qty = QTY_BTC;
    const notional_in = qty * entryPrice;

    // ✅ TP/SL en USDT desde entry
    const tpDelta = entryPrice * TP_PCT;
    const slDelta = entryPrice * SL_PCT;

    const tpPrice = side === "LONG" ? entryPrice + tpDelta : entryPrice - tpDelta;
    const slPrice = side === "LONG" ? entryPrice - slDelta : entryPrice + slDelta;

    const entryTs = new Date().toISOString();

    // Guardar entrada en Supabase
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
            touch_buffer_bps: TOUCH_BUFFER_BPS,
            rebound_bps: REBOUND_BPS,
            confirm_ticks: CONFIRM_TICKS,
            distance_bps_at_signal: Number(distBps.toFixed(2)),
            pivot_price: levelPrice,
            tp_pct: TP_PCT,
            sl_pct: SL_PCT,
            tp_delta: tpDelta,
            sl_delta: slDelta,
            qty_btc: qty,
            notional_in,
            pivot_base_day_used,
        },
    };

    const { data, error } = await supabase
        .from(TRADES_TABLE)
        .insert(row)
        .select()
        .single();

    if (error) {
        console.error("❌ Error guardando entrada:", error.message);
        return null;
    }

    // Track en memoria
    openTrades.set(data.id, {
        id: data.id,
        side,
        level,
        entryPrice,
        tpPrice,
        slPrice,
        entryTs,
        qty,                       // ✅ necesario
        meta: row.meta,            // ✅ guarda meta de entrada para merge
        closing: false,            // ✅ evita dobles cierres
        pivot_base_day_used,
    });

    console.log("🟢 OPEN TRADE", {
        id: data.id,
        side,
        level,
        entryPrice,
        tpPrice,
        slPrice,
        pivot_base_day: pivot_base_day_used,
        qty_btc: qty,
        notional_in: Number(notional_in.toFixed(4)),
    });

    // ✅ BLOQUEA este nivel hasta que haya trade en otro nivel distinto
    lockedLevelKey = levelKey(pivot_base_day_used, level);

    // (opcional) resetea estado de detección para ese nivel
    const dk = detKey(pivot_base_day_used, level);
    detectorTouched.set(dk, false);
    detectorConfirm.set(dk, 0);

    console.log("🔒 Nivel bloqueado:", lockedLevelKey);

    return data.id;
}

async function closeTrade({ tradeId, bid, ask, reason }) {
    const t = openTrades.get(tradeId);
    if (!t) return;

    // ✅ precio de salida real
    // LONG cierra vendiendo al BID; SHORT cierra comprando al ASK
    const exitPrice = t.side === "LONG" ? bid : ask;

    const exitTs = new Date().toISOString();

    const pnl = t.side === "LONG"
        ? (exitPrice - t.entryPrice) * t.qty
        : (t.entryPrice - exitPrice) * t.qty;

    const notional_out = t.qty * exitPrice;

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
            notional_out,
            pnl_usdt: pnl,
            exit_reason: reason,
            exit_price: exitPrice,
            exit_ts: exitTs,
        },
    };

    const { error } = await supabase
        .from(TRADES_TABLE)
        .update(patch)
        .eq("id", tradeId);

    if (error) {
        console.error("❌ Error actualizando cierre:", error.message);
        t.closing = false; // ✅ reintentar en el próximo tick
        return;
    }

    openTrades.delete(tradeId);

    console.log("🔴 CLOSE TRADE", {
        id: tradeId,
        reason,
        side: t.side,
        entry: t.entryPrice,
        exit: exitPrice,
        pnl_usdt: Number(pnl.toFixed(6)),
    });
}

// ✅ Bloqueo del último nivel que generó trade
// Formato: `${baseDay}:${level}`  ej: "2026-03-01:R2"
let lockedLevelKey = null;

function levelKey(baseDay, level) {
    return `${baseDay}:${level}`;
}

async function restoreOpenTrades() {
    const { data, error } = await supabase
        .from(TRADES_TABLE)
        .select("id, side, level, entry_price, tp_price, sl_price, entry_ts, meta")
        .eq("symbol", SYMBOL_DB)
        .eq("status", "OPEN")
        .order("entry_ts", { ascending: false })
        .limit(MAX_OPEN_TRADES);

    if (error) {
        console.error("❌ Error restaurando OPEN trades:", error.message);
        return;
    }

    for (const t of data || []) {
        openTrades.set(t.id, {
            id: t.id,
            side: t.side,
            level: t.level,
            entryPrice: Number(t.entry_price),
            tpPrice: Number(t.tp_price),
            slPrice: Number(t.sl_price),
            entryTs: t.entry_ts,
            qty: Number(t.meta?.qty_btc ?? QTY_BTC),
            meta: t.meta || {},
            closing: false,
            pivot_base_day_used: t.meta?.pivot_base_day_used,
        });
    }

    console.log("♻️ Restored OPEN trades:", openTrades.size);
}

function checkOpenTrades({ bid, ask }) {
    // Reglas de disparo:
    // LONG: TP cuando BID >= tpPrice; SL cuando BID <= slPrice
    // SHORT: TP cuando ASK <= tpPrice; SL cuando ASK >= slPrice
    for (const [id, t] of openTrades.entries()) {
        if (t.side === "LONG") {
            if (!t.closing && bid >= t.tpPrice) {
                t.closing = true;
                closeTrade({ tradeId: id, bid, ask, reason: "TP" });
            } else if (!t.closing && bid <= t.slPrice) {
                t.closing = true;
                closeTrade({ tradeId: id, bid, ask, reason: "SL" });
            }
        } else {
            if (!t.closing && ask <= t.tpPrice) {
                t.closing = true;
                closeTrade({ tradeId: id, bid, ask, reason: "TP" });
            } else if (!t.closing && ask >= t.slPrice) {
                t.closing = true;
                closeTrade({ tradeId: id, bid, ask, reason: "SL" });
            }
        }
    }
}

// ======================
// Rebound detector
// ======================
const detectorTouched = new Map(); // key = `${baseDay}:${level}` -> boolean
const detectorConfirm = new Map(); // key = `${baseDay}:${level}` -> number

function detKey(baseDay, level) {
    return `${baseDay}:${level}`;
}

async function processQuote({ bid, ask }) {
    if (!pivotsList.length) return;

    // track trades abiertos
    checkOpenTrades({ bid, ask });

    // genera niveles de ambos días
    const levelsToWatch = [];
    for (const p of pivotsList) {
        levelsToWatch.push(
            { baseDay: p.baseDay, level: "S1", side: "LONG", price: p.levels.S1 },
            { baseDay: p.baseDay, level: "S2", side: "LONG", price: p.levels.S2 },
            { baseDay: p.baseDay, level: "R1", side: "SHORT", price: p.levels.R1 },
            { baseDay: p.baseDay, level: "R2", side: "SHORT", price: p.levels.R2 },
        );
    }

    for (const item of levelsToWatch) {
        const levelPrice = item.price;

        // LONG mide ASK, SHORT mide BID
        const refPrice = item.side === "LONG" ? ask : bid;

        const distBps = bpsDistance(refPrice, levelPrice);
        const absBps = Math.abs(distBps);

        const k = detKey(item.baseDay, item.level);

        const lvlKey = levelKey(item.baseDay, item.level);

        // ✅ Si este nivel está bloqueado, no lo proceses
        if (lockedLevelKey === lvlKey) {
            continue;
        }

        // 1) touch
        if (!detectorTouched.get(k) && absBps <= TOUCH_BUFFER_BPS) {
            detectorTouched.set(k, true);
            detectorConfirm.set(k, 0);
            continue;
        }

        // 2) confirm rebote
        if (detectorTouched.get(k)) {
            const prev = detectorConfirm.get(k) || 0;

            if (item.side === "LONG") {
                const next = distBps >= REBOUND_BPS ? (prev + 1) : 0;
                detectorConfirm.set(k, next);

                if (next >= CONFIRM_TICKS) {
                    await openTrade({
                        side: "LONG",
                        level: item.level,
                        levelPrice,
                        distBps,
                        bid, ask,
                        pivot_base_day_used: item.baseDay,   // ✅ nuevo
                    });
                    detectorTouched.set(k, false);
                    detectorConfirm.set(k, 0);
                }
            } else {
                const next = distBps <= -REBOUND_BPS ? (prev + 1) : 0;
                detectorConfirm.set(k, next);

                if (next >= CONFIRM_TICKS) {
                    await openTrade({
                        side: "SHORT",
                        level: item.level,
                        levelPrice,
                        distBps,
                        bid, ask,
                        pivot_base_day_used: item.baseDay,   // ✅ nuevo
                    });
                    detectorTouched.set(k, false);
                    detectorConfirm.set(k, 0);
                }
            }

            // reset por invalidez
            if (absBps > 50) {
                detectorTouched.set(k, false);
                detectorConfirm.set(k, 0);
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

    // Encabezado simple
    console.log(`${ts} BID=${bid} ASK=${ask} openTrades=${openTrades.size}`);

    // 1 línea por pivot-day (sin tablas, sin bordes)
    for (const p of pivotsList) {
        const { S1, S2, R1, R2 } = p.levels;

        const askS2 = bpsDistance(ask, S2).toFixed(2);
        const askS1 = bpsDistance(ask, S1).toFixed(2);
        const bidR1 = bpsDistance(bid, R1).toFixed(2);
        const bidR2 = bpsDistance(bid, R2).toFixed(2);

        // formato “solo datos”
        console.log(
            `baseDay=${p.baseDay}` +
            ` S2=${S2} askS2bps=${askS2}` +
            ` S1=${S1} askS1bps=${askS1}` +
            ` R1=${R1} bidR1bps=${bidR1}` +
            ` R2=${R2} bidR2bps=${bidR2}`
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
await refreshPivots();
await restoreOpenTrades();
setInterval(refreshPivots, 10 * 60_000);
startWS();