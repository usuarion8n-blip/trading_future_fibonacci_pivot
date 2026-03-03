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

const TIMEFRAMES = [
    { label: '1m', seconds: 60 },
    { label: '5m', seconds: 300 },
    { label: '15m', seconds: 900 },
    { label: '1h', seconds: 3600 },
]

const MAX_CANDLES = 500

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
    const candleMapRef = useRef(new Map())
    const priceLinesRef = useRef([])       // yesterday price lines
    const prevPriceLinesRef = useRef([])   // day-before price lines
    const [activeTf, setActiveTf] = useState(60)

    const { levels, prevLevels, loading: pivotLoading, error: pivotError } = useFibPivot()

    // Store activeTf in a ref so the onmessage closure uses the latest value
    const tfRef = useRef(activeTf)
    useEffect(() => { tfRef.current = activeTf }, [activeTf])

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
            timeScale: {
                borderColor: 'rgba(255,255,255,0.07)',
                timeVisible: true,
                secondsVisible: true,
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

        chartRef.current = chart
        seriesRef.current = series

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
    }, []) // run once

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
    }, [priceObj])

    // Change timeframe
    const handleTfChange = useCallback((seconds) => {
        setActiveTf(seconds)
        candleMapRef.current.clear()
        if (seriesRef.current) seriesRef.current.setData([])
    }, [])

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
                </div>
            </div>
            <div className="chart-container" ref={containerRef} />
        </section>
    )
}
