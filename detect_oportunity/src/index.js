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
async function loadLatestPivots() {
    const { data, error } = await supabase
        .from(PIVOT_TABLE)
        .select("base_day, pp, r1, r2, r3, s1, s2, s3, symbol, interval, run_ts")
        .eq("symbol", SYMBOL_DB)
        .eq("interval", INTERVAL)
        .order("base_day", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error("No hay pivots en Supabase (fib_pivot_daily).");

    return {
        baseDay: data.base_day,
        levels: {
            PP: Number(data.pp),
            R1: Number(data.r1),
            R2: Number(data.r2),
            R3: Number(data.r3),
            S1: Number(data.s1),
            S2: Number(data.s2),
            S3: Number(data.s3),
        },
    };
}

let pivots = null;
let lastPrintTs = 0;

async function refreshPivots() {
    try {
        pivots = await loadLatestPivots();
        console.log("✅ Pivots cargados:", pivots.baseDay, pivots.levels);
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
const lastSignalAt = new Map(); // `${level}:${side}` -> ts

async function openTrade({ side, level, levelPrice, distBps, bid, ask }) {
    const key = `${level}:${side}`;
    const nowMs = Date.now();
    const last = lastSignalAt.get(key) || 0;
    if (nowMs - last < COOLDOWN_MS) return null;
    lastSignalAt.set(key, nowMs);

    if (!canOpenNewTrade()) return null;
    if (!pivots?.baseDay) return null;

    // ✅ entry real
    const entryPrice = side === "LONG" ? ask : bid;

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
        pivot_base_day: pivots.baseDay,
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
    });

    console.log("🟢 OPEN TRADE", {
        id: data.id,
        side,
        level,
        entryPrice,
        tpPrice,
        slPrice,
        pivot_base_day: pivots.baseDay,
    });

    return data.id;
}

async function closeTrade({ tradeId, bid, ask, reason }) {
    const t = openTrades.get(tradeId);
    if (!t) return;

    // ✅ precio de salida real
    // LONG cierra vendiendo al BID; SHORT cierra comprando al ASK
    const exitPrice = t.side === "LONG" ? bid : ask;

    const exitTs = new Date().toISOString();

    // ✅ PnL simple por unidad (sin qty)
    const pnl = t.side === "LONG"
        ? (exitPrice - t.entryPrice)
        : (t.entryPrice - exitPrice);

    const patch = {
        status: "CLOSED",
        exit_ts: exitTs,
        exit_price: exitPrice,
        exit_reason: reason, // TP o SL
        exit_bid: bid,
        exit_ask: ask,
        pnl_usdt: pnl,
    };

    const { error } = await supabase
        .from(TRADES_TABLE)
        .update(patch)
        .eq("id", tradeId);

    if (error) {
        console.error("❌ Error actualizando cierre:", error.message);
        return;
    }

    openTrades.delete(tradeId);

    console.log("🔴 CLOSE TRADE", {
        id: tradeId,
        reason,
        side: t.side,
        entry: t.entryPrice,
        exit: exitPrice,
        pnl_usdt: Number(pnl.toFixed(2)),
    });
}

function checkOpenTrades({ bid, ask }) {
    // Reglas de disparo:
    // LONG: TP cuando BID >= tpPrice; SL cuando BID <= slPrice
    // SHORT: TP cuando ASK <= tpPrice; SL cuando ASK >= slPrice
    for (const [id, t] of openTrades.entries()) {
        if (t.side === "LONG") {
            if (bid >= t.tpPrice) {
                closeTrade({ tradeId: id, bid, ask, reason: "TP" });
            } else if (bid <= t.slPrice) {
                closeTrade({ tradeId: id, bid, ask, reason: "SL" });
            }
        } else {
            if (ask <= t.tpPrice) {
                closeTrade({ tradeId: id, bid, ask, reason: "TP" });
            } else if (ask >= t.slPrice) {
                closeTrade({ tradeId: id, bid, ask, reason: "SL" });
            }
        }
    }
}

// ======================
// Rebound detector
// ======================
const detectorState = {
    touched: { S1: false, S2: false, R1: false, R2: false },
    confirm: { S1: 0, S2: 0, R1: 0, R2: 0 },
};

async function processQuote({ bid, ask }) {
    if (!pivots?.levels) return;

    // primero: track trades abiertos
    checkOpenTrades({ bid, ask });

    const levelsToWatch = [
        { level: "S1", side: "LONG" },
        { level: "S2", side: "LONG" },
        { level: "R1", side: "SHORT" },
        { level: "R2", side: "SHORT" },
    ];

    for (const item of levelsToWatch) {
        const levelPrice = pivots.levels[item.level];

        // LONG se “mide” contra ASK (compra), SHORT contra BID (venta)
        const refPrice = item.side === "LONG" ? ask : bid;

        const distBps = bpsDistance(refPrice, levelPrice);
        const absBps = Math.abs(distBps);

        // 1) touch
        if (!detectorState.touched[item.level] && absBps <= TOUCH_BUFFER_BPS) {
            detectorState.touched[item.level] = true;
            detectorState.confirm[item.level] = 0;
            continue;
        }

        // 2) confirm rebote
        if (detectorState.touched[item.level]) {
            if (item.side === "LONG") {
                if (distBps >= REBOUND_BPS) detectorState.confirm[item.level] += 1;
                else detectorState.confirm[item.level] = 0;

                if (detectorState.confirm[item.level] >= CONFIRM_TICKS) {
                    await openTrade({
                        side: "LONG",
                        level: item.level,
                        levelPrice,
                        distBps,
                        bid, ask,
                    });
                    detectorState.touched[item.level] = false;
                    detectorState.confirm[item.level] = 0;
                }
            } else {
                if (distBps <= -REBOUND_BPS) detectorState.confirm[item.level] += 1;
                else detectorState.confirm[item.level] = 0;

                if (detectorState.confirm[item.level] >= CONFIRM_TICKS) {
                    await openTrade({
                        side: "SHORT",
                        level: item.level,
                        levelPrice,
                        distBps,
                        bid, ask,
                    });
                    detectorState.touched[item.level] = false;
                    detectorState.confirm[item.level] = 0;
                }
            }

            // reset por invalidez
            if (absBps > 50) {
                detectorState.touched[item.level] = false;
                detectorState.confirm[item.level] = 0;
            }
        }
    }
}

function printLevels({ bid, ask }) {
    if (!pivots?.levels) return;
    const now = Date.now();
    if (now - lastPrintTs < PRINT_EVERY_MS) return;
    lastPrintTs = now;

    const { S1, S2, R1, R2 } = pivots.levels;

    console.log(
        `[${new Date().toISOString()}] BID:${bid} ASK:${ask}` +
        ` | S2:${S2} (ask ${bpsDistance(ask, S2).toFixed(2)}bps)` +
        ` | S1:${S1} (ask ${bpsDistance(ask, S1).toFixed(2)}bps)` +
        ` | R1:${R1} (bid ${bpsDistance(bid, R1).toFixed(2)}bps)` +
        ` | R2:${R2} (bid ${bpsDistance(bid, R2).toFixed(2)}bps)` +
        ` | openTrades:${openTrades.size}`
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
setInterval(refreshPivots, 10 * 60_000);
startWS();