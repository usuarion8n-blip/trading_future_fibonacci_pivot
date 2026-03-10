/**
 * CandlestickChart — Lightweight Charts candlestick chart
 * Manages its own candle map in a ref to avoid re-render overhead.
 * Draws Fibonacci pivot/resistance/support lines from Supabase.
 * Two sets of levels:
 *   - Yesterday     → dashed, bright colors
 *   - Day before    → dotted, dim colors, suffixed "-2"
 */
import { useRef, useEffect, useState, useCallback } from 'react'
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts'
import { useFibPivot } from '../hooks/useFibPivot'
// import { useVWAP } from '../hooks/useVWAP'

const TIMEFRAMES = [
    { label: '1m', seconds: 60 },
    { label: '5m', seconds: 300 },
    { label: '15m', seconds: 900 },
    { label: '1h', seconds: 3600 },
    { label: '1d', seconds: 86400 },
]

const MAX_CANDLES = 500
const LS_CHART_KEY = 'fm_chart_state'

/** Mapeo de segundos → intervalo de Binance */
const TF_TO_INTERVAL = {
    60: '1m',
    300: '5m',
    900: '15m',
    3600: '1h',
    86400: '1d',
}

/** Devuelve la clave de candles para un timeframe específico */
function candlesKey(tf) { return `${LS_CHART_KEY}_candles_${tf}` }

/** Lee las velas guardadas para un timeframe desde localStorage */
function loadCandles(tf) {
    try {
        const raw = localStorage.getItem(candlesKey(tf))
        return raw ? JSON.parse(raw) : []
    } catch { return [] }
}

/** Guarda el array de velas para un timeframe en localStorage */
function saveCandles(tf, candles) {
    try {
        localStorage.setItem(candlesKey(tf), JSON.stringify(candles.slice(-MAX_CANDLES)))
    } catch { /* cuota llena → ignorar */ }
}

/** Lee el último timeframe activo guardado */
function loadActiveTf() {
    try {
        const v = localStorage.getItem(`${LS_CHART_KEY}_tf`)
        const n = v ? parseInt(v, 10) : 60
        return TF_TO_INTERVAL[n] ? n : 60
    } catch { return 60 }
}

/** Guarda el timeframe activo */
function saveActiveTf(tf) {
    try { localStorage.setItem(`${LS_CHART_KEY}_tf`, String(tf)) } catch { }
}

/**
 * Descarga klines históricos de Binance Futures REST API.
 * Devuelve array de { time, open, high, low, close } ordenado.
 */
async function fetchKlines(tf, limit = 500) {
    const interval = TF_TO_INTERVAL[tf] ?? '1m'
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Binance klines error: ${res.status}`)
    const data = await res.json()
    // data[i] = [openTime, open, high, low, close, volume, closeTime, ...]
    return data.map(k => ({
        time: Math.floor(k[0] / 1000),  // openTime en segundos
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
    }))
}

// Yesterday's lines — dashed, bright
const PIVOT_LINES = [
    { key: 'r3', label: 'R3', color: '#ff1744', lineWidth: 1, lineStyle: LineStyle.Dashed },
    { key: 'r2', label: 'R2', color: '#ff4d6a', lineWidth: 1, lineStyle: LineStyle.Dashed },
    { key: 'r1', label: 'R1', color: '#ff8fa3', lineWidth: 1, lineStyle: LineStyle.Dashed },
    { key: 'pivot', label: 'P', color: '#f7931a', lineWidth: 2, lineStyle: LineStyle.Dashed },
    { key: 's1', label: 'S1', color: '#69d9b0', lineWidth: 1, lineStyle: LineStyle.Dashed },
    { key: 's2', label: 'S2', color: '#00c896', lineWidth: 1, lineStyle: LineStyle.Dashed },
    { key: 's3', label: 'S3', color: '#00916e', lineWidth: 1, lineStyle: LineStyle.Dashed },
]

// Day-before-yesterday lines — dotted, dim (lower opacity via hex alpha)
const PREV_PIVOT_LINES = [
    { key: 'r3', label: 'R3-2', color: '#ff174466', lineWidth: 1, lineStyle: LineStyle.Dotted },
    { key: 'r2', label: 'R2-2', color: '#ff4d6a66', lineWidth: 1, lineStyle: LineStyle.Dotted },
    { key: 'r1', label: 'R1-2', color: '#ff8fa366', lineWidth: 1, lineStyle: LineStyle.Dotted },
    { key: 'pivot', label: 'P-2', color: '#f7931a66', lineWidth: 1, lineStyle: LineStyle.Dotted },
    { key: 's1', label: 'S1-2', color: '#69d9b066', lineWidth: 1, lineStyle: LineStyle.Dotted },
    { key: 's2', label: 'S2-2', color: '#00c89666', lineWidth: 1, lineStyle: LineStyle.Dotted },
    { key: 's3', label: 'S3-2', color: '#00916e66', lineWidth: 1, lineStyle: LineStyle.Dotted },
]

export default function CandlestickChart({ priceObj }) {
    const containerRef = useRef(null)
    const chartRef = useRef(null)
    const seriesRef = useRef(null)
    // const vwapSeriesRef = useRef(null)

    // Restaurar timeframe y candles desde localStorage antes del primer render
    const initialTf = loadActiveTf()
    const initialCandles = loadCandles(initialTf)
    const initialMap = new Map(initialCandles.map(c => [c.time, c]))

    const candleMapRef = useRef(initialMap)
    const priceLinesRef = useRef([])       // yesterday price lines
    const prevPriceLinesRef = useRef([])   // day-before price lines
    const [activeTf, setActiveTf] = useState(initialTf)
    const [klineLoading, setKlineLoading] = useState(false)

    const { levels, prevLevels, loading: pivotLoading, error: pivotError } = useFibPivot()
    // const { vwapData, activeVwap } = useVWAP()

    // Store activeTf in a ref so the onmessage closure uses the latest value
    const tfRef = useRef(initialTf)
    useEffect(() => { tfRef.current = activeTf }, [activeTf])

    /**
     * Carga klines históricos de Binance para un TF dado,
     * los fusiona con lo que haya en localStorage (para no perder
     * la vela en curso) y renderiza en el chart.
     */
    const applyKlines = useCallback(async (tf) => {
        if (!seriesRef.current) return
        setKlineLoading(true)
        try {
            const apiCandles = await fetchKlines(tf)
            // Fusionar: API como base + velas locales más recientes encima
            const savedCandles = loadCandles(tf)
            const map = new Map(apiCandles.map(c => [c.time, c]))
            // Las velas locales pueden tener la vela parcial actual → las superponemos
            savedCandles.forEach(c => map.set(c.time, c))
            const merged = [...map.values()].sort((a, b) => a.time - b.time)
            candleMapRef.current = map
            seriesRef.current.setData(merged)
            saveCandles(tf, merged)
        } catch (err) {
            console.warn('[Chart] Error fetching klines:', err)
            // Fallback: usar lo que haya en localStorage
            const saved = loadCandles(tf)
            if (saved.length > 0) {
                const map = new Map(saved.map(c => [c.time, c]))
                candleMapRef.current = map
                seriesRef.current.setData(saved)
            }
        } finally {
            setKlineLoading(false)
        }
    }, [])

    // Init chart once on mount
    useEffect(() => {
        const chart = createChart(containerRef.current, {
            layout: {
                background: { color: '#11131a' },
                textColor: '#8b90a7',
            },
            grid: {
                vertLines: { color: 'rgba(255,255,255,0.04)' },
                horzLines: { color: 'rgba(255,255,255,0.04)' },
            },
            crosshair: {
                mode: CrosshairMode.Normal,
                vertLine: { color: 'rgba(247,147,26,.5)', labelBackgroundColor: '#F7931A' },
                horzLine: { color: 'rgba(247,147,26,.5)', labelBackgroundColor: '#F7931A' },
            },
            rightPriceScale: { borderColor: 'rgba(255,255,255,0.07)' },
            localization: {
                timeFormatter: (timestamp) => {
                    const date = new Date(timestamp * 1000)
                    return date.toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                    })
                },
            },
            timeScale: {
                borderColor: 'rgba(255,255,255,0.07)',
                timeVisible: true,
                secondsVisible: false,
                tickMarkFormatter: (timestamp) => {
                    const date = new Date(timestamp * 1000)
                    return date.toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                    })
                },
            },
            handleScroll: { mouseWheel: true, pressedMouseMove: true },
            handleScale: { axisPressedMouseMove: true, mouseWheel: true },
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight,
        })

        const series = chart.addCandlestickSeries({
            upColor: '#00c896',
            downColor: '#ff4d6a',
            borderUpColor: '#00c896',
            borderDownColor: '#ff4d6a',
            wickUpColor: '#00c896',
            wickDownColor: '#ff4d6a',
        })

        /*
        const vwapSeries = chart.addLineSeries({
            color: '#00b8d9',
            lineWidth: 2,
            crosshairMarkerVisible: false,
            lastValueVisible: false,
            priceLineVisible: false,
        })
        */

        chartRef.current = chart
        seriesRef.current = series
        // vwapSeriesRef.current = vwapSeries

        // Mostrar velas de localStorage inmediatamente (sin esperar a la API)
        const savedCandles = [...candleMapRef.current.values()].sort((a, b) => a.time - b.time)
        if (savedCandles.length > 0) {
            series.setData(savedCandles)
        }

        // Luego refrescar con datos históricos reales de Binance
        applyKlines(tfRef.current)

        // Responsive resize
        const ro = new ResizeObserver(() => {
            chart.applyOptions({
                width: containerRef.current.clientWidth,
                height: containerRef.current.clientHeight,
            })
        })
        ro.observe(containerRef.current)

        return () => {
            ro.disconnect()
            chart.remove()
        }
    }, [applyKlines]) // eslint-disable-line react-hooks/exhaustive-deps

    // Helper to draw a set of price lines
    function drawLines(levelData, lineDefinitions, linesRef) {
        const series = seriesRef.current
        if (!series) return

        // Remove existing
        linesRef.current.forEach(line => {
            try { series.removePriceLine(line) } catch (_) { }
        })
        linesRef.current = []

        if (!levelData) return

        // Add new
        lineDefinitions.forEach(({ key, label, color, lineWidth, lineStyle }) => {
            const price = levelData[key]
            if (price == null || isNaN(price)) return

            const line = series.createPriceLine({
                price,
                color,
                lineWidth,
                lineStyle,
                axisLabelVisible: true,
                title: label,
            })
            linesRef.current.push(line)
        })
    }

    // Draw / update yesterday's pivot lines
    useEffect(() => {
        drawLines(levels, PIVOT_LINES, priceLinesRef)
    }, [levels])

    // Draw / update day-before-yesterday's pivot lines
    useEffect(() => {
        drawLines(prevLevels, PREV_PIVOT_LINES, prevPriceLinesRef)
    }, [prevLevels])

    // Sync VWAP data to its line series
    /*
    useEffect(() => {
        if (vwapSeriesRef.current && vwapData.length > 0) {
            // Remove duplicates with the same time (Lightweight charts requires strictly ascending time)
            const uniqueData = []
            let lastTime = -1
            for (const pt of vwapData) {
                if (pt.time > lastTime) {
                    uniqueData.push(pt)
                    lastTime = pt.time
                } else if (pt.time === lastTime) {
                    uniqueData[uniqueData.length - 1] = pt // update last
                }
            }
            vwapSeriesRef.current.setData(uniqueData)
        }
    }, [vwapData])
    */

    // Update candle when a new price tick arrives
    useEffect(() => {
        if (!priceObj || !seriesRef.current) return
        const { value: price, evtTimeMs } = priceObj
        const ts = evtTimeMs || Date.now()
        const bucket = Math.floor(ts / 1000 / tfRef.current) * tfRef.current

        const map = candleMapRef.current
        if (!map.has(bucket)) {
            map.set(bucket, { time: bucket, open: price, high: price, low: price, close: price })
        } else {
            const c = map.get(bucket)
            c.high = Math.max(c.high, price)
            c.low = Math.min(c.low, price)
            c.close = price
        }

        const candles = [...map.values()].sort((a, b) => a.time - b.time)
        if (candles.length > MAX_CANDLES) {
            const oldest = [...map.keys()].sort((a, b) => a - b)[0]
            map.delete(oldest)
            candles.shift()
        }

        seriesRef.current.setData(candles)
        saveCandles(tfRef.current, candles)
    }, [priceObj])

    // Change timeframe
    const handleTfChange = useCallback((seconds) => {
        if (seconds === tfRef.current) return // ya estamos en este TF
        setActiveTf(seconds)
        saveActiveTf(seconds)
        tfRef.current = seconds
        // Mostrar velas de localStorage del nuevo TF de inmediato
        const saved = loadCandles(seconds)
        const newMap = new Map(saved.map(c => [c.time, c]))
        candleMapRef.current = newMap
        if (seriesRef.current) seriesRef.current.setData(saved)
        // Luego enriquecer con datos históricos reales
        applyKlines(seconds)
    }, [applyKlines])

    return (
        <section className="chart-section">
            <div className="chart-toolbar">
                <div className="chart-title">Precio en tiempo real</div>
                <div className="tf-buttons">
                    {TIMEFRAMES.map(tf => (
                        <button
                            key={tf.seconds}
                            className={`tf-btn${activeTf === tf.seconds ? ' active' : ''}`}
                            onClick={() => handleTfChange(tf.seconds)}
                        >
                            {tf.label}
                        </button>
                    ))}
                </div>
                {/* Pivot status badge */}
                <div className="pivot-status">
                    {klineLoading && <span className="pivot-badge loading">⏳ Cargando velas…</span>}
                    {pivotLoading && <span className="pivot-badge loading">⏳ Cargando pivots…</span>}
                    {pivotError && <span className="pivot-badge error">⚠ Error al cargar pivots</span>}
                    {levels && !pivotLoading && (
                        <span className="pivot-badge ok">
                            🔶 P: {levels.pivot?.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </span>
                    )}
                    {prevLevels && !pivotLoading && (
                        <span className="pivot-badge ok" style={{ opacity: 0.6 }}>
                            🔸 P-2: {prevLevels.pivot?.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </span>
                    )}
                    {/* activeVwap && (
                        <span className="pivot-badge ok" style={{ borderColor: '#00b8d9', color: '#00b8d9' }}>
                            🌊 VWAP: {activeVwap.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </span>
                    ) */}
                </div>
            </div>
            <div className="chart-container" ref={containerRef} />
        </section>
    )
}
