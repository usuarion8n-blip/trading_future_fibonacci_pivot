/**
 * BTC/USDT Live Market Dashboard
 * WebSocket: wss://fstream.binance.com/ws/btcusdt@markPrice@1s
 */

// ── Constants ──────────────────────────────────────────
const WS_URL = 'wss://fstream.binance.com/ws/btcusdt@markPrice@1s';
const MAX_FEED = 50;        // max tick rows in the feed
const MAX_CANDLES = 500;    // max candles per series

// ── State ──────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
let reopenAttempts = 0;
let tickCount = 0;
let prevPrice = null;
let openPrice = null;
let sessionHigh = -Infinity;
let sessionLow = Infinity;
let chartSeries = null;
let candleMap = new Map();   // key: bucket-start → { open, high, low, close, time }
let bucketSeconds = 60;          // default: 1-minute candles

// ── DOM Refs ───────────────────────────────────────────
const elPrice = document.getElementById('priceValue');
const elChange = document.getElementById('priceChange');
const elChangePct = document.getElementById('changePct');
const elChangeAbs = document.getElementById('changeAbs');
const elChangeIcon = document.getElementById('changeIcon');
const elFundingRate = document.getElementById('fundingRate');
const elNextFund = document.getElementById('nextFunding');
const elHigh = document.getElementById('sessionHigh');
const elLow = document.getElementById('sessionLow');
const elLastUpd = document.getElementById('lastUpdate');
const elTickCount = document.getElementById('tickCount');
const elWsDot = document.getElementById('wsDot');
const elWsLabel = document.getElementById('wsLabel');
const elFeedList = document.getElementById('feedList');
const elClearFeed = document.getElementById('clearFeed');
const elTfBtns = document.querySelectorAll('.tf-btn');
const elChartCont = document.getElementById('chartContainer');

// ── Chart Setup ────────────────────────────────────────
function initChart() {
    const chart = LightweightCharts.createChart(elChartCont, {
        layout: {
            background: { color: '#11131a' },
            textColor: '#8b90a7',
        },
        grid: {
            vertLines: { color: 'rgba(255,255,255,0.04)' },
            horzLines: { color: 'rgba(255,255,255,0.04)' },
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: { color: 'rgba(247,147,26,.5)', labelBackgroundColor: '#F7931A' },
            horzLine: { color: 'rgba(247,147,26,.5)', labelBackgroundColor: '#F7931A' },
        },
        rightPriceScale: {
            borderColor: 'rgba(255,255,255,0.07)',
        },
        timeScale: {
            borderColor: 'rgba(255,255,255,0.07)',
            timeVisible: true,
            secondsVisible: true,
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true },
        width: elChartCont.clientWidth,
        height: elChartCont.clientHeight,
    });

    chartSeries = chart.addCandlestickSeries({
        upColor: '#00c896',
        downColor: '#ff4d6a',
        borderUpColor: '#00c896',
        borderDownColor: '#ff4d6a',
        wickUpColor: '#00c896',
        wickDownColor: '#ff4d6a',
    });

    // Resize observer
    new ResizeObserver(() => {
        chart.applyOptions({
            width: elChartCont.clientWidth,
            height: elChartCont.clientHeight,
        });
    }).observe(elChartCont);

    return chart;
}

const chart = initChart();

// ── Bucket helpers ─────────────────────────────────────
function getBucketKey(timestampMs) {
    return Math.floor(timestampMs / 1000 / bucketSeconds) * bucketSeconds;
}

function updateCandle(price, timestampMs) {
    const key = getBucketKey(timestampMs);
    const time = key; // Unix seconds (UTC)

    if (!candleMap.has(key)) {
        candleMap.set(key, { time, open: price, high: price, low: price, close: price });
    } else {
        const c = candleMap.get(key);
        c.high = Math.max(c.high, price);
        c.low = Math.min(c.low, price);
        c.close = price;
    }

    // Convert to sorted array and push/update
    const candles = [...candleMap.values()].sort((a, b) => a.time - b.time);

    // Keep size reasonable
    if (candles.length > MAX_CANDLES) {
        candleMap.delete([...candleMap.keys()].sort((a, b) => a - b)[0]);
        candles.shift();
    }

    chartSeries.setData(candles);
}

// ── Timeframe buttons ──────────────────────────────────
elTfBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const newSec = parseInt(btn.dataset.seconds, 10);
        if (newSec === bucketSeconds) return;

        bucketSeconds = newSec;
        candleMap.clear();
        chartSeries.setData([]);

        elTfBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

// ── Feed ───────────────────────────────────────────────
function addFeedItem(price, funding, dir) {
    const now = new Date();
    const time = now.toLocaleTimeString('es-PE', { hour12: false });

    const item = document.createElement('div');
    item.className = 'feed-item';

    const arrowClass = dir > 0 ? 'up' : dir < 0 ? 'down' : 'flat';
    const arrowChar = dir > 0 ? '▲' : dir < 0 ? '▼' : '━';

    item.innerHTML = `
    <span class="feed-time">${time}</span>
    <span class="feed-price">$${formatPrice(price)}</span>
    <span class="feed-funding">${(parseFloat(funding) * 100).toFixed(4)}%</span>
    <span class="feed-arrow ${arrowClass}">${arrowChar}</span>
  `;

    elFeedList.prepend(item);

    // Remove old items
    const items = elFeedList.querySelectorAll('.feed-item');
    if (items.length > MAX_FEED) {
        items[items.length - 1].remove();
    }
}

elClearFeed.addEventListener('click', () => {
    elFeedList.innerHTML = '';
});

// ── Formatters ─────────────────────────────────────────
function formatPrice(val) {
    return parseFloat(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCountdown(nextFundingTimeMs) {
    const diffMs = nextFundingTimeMs - Date.now();
    if (diffMs < 0) return '00:00:00';
    const h = Math.floor(diffMs / 3600000);
    const m = Math.floor((diffMs % 3600000) / 60000);
    const s = Math.floor((diffMs % 60000) / 1000);
    return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

// ── Message handler ────────────────────────────────────
function handleMessage(data) {
    // markPrice@1s message structure:
    // { e, E, s, p, i, P, r, T }
    // p = mark price, r = funding rate, T = next funding time, E = event time ms

    const price = parseFloat(data.p);
    const funding = data.r;
    const nextTime = data.T;
    const evtTimeMs = data.E;

    if (isNaN(price)) return;

    tickCount++;
    elTickCount.textContent = tickCount;

    // Track open / highs / lows
    if (openPrice === null) openPrice = price;
    if (price > sessionHigh) { sessionHigh = price; elHigh.textContent = '$' + formatPrice(price); }
    if (price < sessionLow) { sessionLow = price; elLow.textContent = '$' + formatPrice(price); }

    // Direction
    const dir = prevPrice === null ? 0 : price > prevPrice ? 1 : price < prevPrice ? -1 : 0;

    // ── Price Display ──
    elPrice.textContent = '$' + formatPrice(price);
    elPrice.classList.remove('up', 'down');
    if (dir > 0) elPrice.classList.add('up');
    if (dir < 0) elPrice.classList.add('down');
    setTimeout(() => elPrice.classList.remove('up', 'down'), 600);

    // ── Change vs Open ──
    const absChange = price - openPrice;
    const pctChange = ((price - openPrice) / openPrice) * 100;
    const sign = absChange >= 0 ? '+' : '';

    elChangePct.textContent = `${sign}${pctChange.toFixed(2)}%`;
    elChangeAbs.textContent = `${sign}${formatPrice(absChange)}`;
    elChangeIcon.textContent = absChange >= 0 ? '▲' : '▼';

    elChange.className = 'price-change ' + (absChange >= 0 ? 'up' : 'down');

    // ── Funding ──
    if (funding !== undefined) {
        const fPct = (parseFloat(funding) * 100).toFixed(4);
        const color = parseFloat(fPct) >= 0 ? 'var(--green)' : 'var(--red)';
        elFundingRate.innerHTML = `<span style="color:${color}">${fPct > 0 ? '+' : ''}${fPct}%</span>`;
    }
    if (nextTime) {
        elNextFund.textContent = formatCountdown(nextTime);
    }

    // ── Time ──
    const now = new Date(evtTimeMs || Date.now());
    elLastUpd.textContent = now.toLocaleTimeString('es-PE', { hour12: false });

    // ── Chart ──
    updateCandle(price, evtTimeMs || Date.now());

    // ── Feed ──
    addFeedItem(price, funding ?? '0', dir);

    prevPrice = price;
}

// ── WebSocket ──────────────────────────────────────────
function setStatus(state) {
    elWsDot.className = 'ws-dot ' + state;
    const labels = {
        connected: '● Conectado',
        connecting: 'Conectando…',
        reconnecting: 'Reconectando…',
        error: 'Error de conexión',
    };
    elWsLabel.textContent = labels[state] ?? state;
}

function connect() {
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
    setStatus('connecting');

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        reopenAttempts = 0;
        setStatus('connected');
        console.log('[WS] Conectado a', WS_URL);
    };

    ws.onmessage = (evt) => {
        try {
            const data = JSON.parse(evt.data);
            handleMessage(data);
        } catch (e) {
            console.warn('[WS] Error parsing:', e);
        }
    };

    ws.onerror = (err) => {
        console.error('[WS] Error:', err);
        setStatus('error');
    };

    ws.onclose = (evt) => {
        console.warn('[WS] Cerrado, código:', evt.code);
        if (evt.code !== 1000) scheduleReconnect();
    };
}

function scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** reopenAttempts, 30000);
    reopenAttempts++;
    setStatus('reconnecting');
    console.log(`[WS] Reconectando en ${delay / 1000}s (intento ${reopenAttempts})`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
}

// Keep funding countdown ticking
setInterval(() => {
    const nextTime = ws?._nextFundingTime;
    if (nextTime) elNextFund.textContent = formatCountdown(nextTime);
}, 1000);

// ── Boot ───────────────────────────────────────────────
connect();
