import { useState, useEffect, useRef, useCallback } from 'react'

const SYMBOL_DB = 'BTCUSDT'
const SYMBOL_WS = 'btcusdt'
const REST_BASE = 'https://fapi.binance.com'
const WS_COMBINED_BASE = 'wss://fstream.binance.com/stream?streams='

function getUtcDayStartMs(ts = Date.now()) {
    const d = new Date(ts)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)
}

function typicalPriceFromOHLC(h, l, c) {
    return (Number(h) + Number(l) + Number(c)) / 3
}

export function useVWAP() {
    const [vwapData, setVwapData] = useState([])
    const [activeVwap, setActiveVwap] = useState(null)
    const vwapDataRef = useRef([])

    // session state
    const sessionPVClosed = useRef(0)
    const sessionVolClosed = useRef(0)
    const currentKline = useRef(null)
    const lastClosedKlineOpenTime = useRef(null)
    const sessionDayStartMs = useRef(getUtcDayStartMs())

    const wsRef = useRef(null)
    const reconnTimerRef = useRef(null)
    const attemptsRef = useRef(0)

    const fetchInitialData = useCallback(async () => {
        try {
            const now = Date.now()
            const dayStart = getUtcDayStartMs(now)
            sessionDayStartMs.current = dayStart

            const currentMinuteStart = Math.floor(now / 60000) * 60000

            const url = `${REST_BASE}/fapi/v1/klines?symbol=${SYMBOL_DB}&interval=1m&startTime=${dayStart}&endTime=${now}&limit=1500`
            const res = await fetch(url)
            const klines = await res.json()

            let pvClosed = 0
            let volClosed = 0
            let currentK = null

            const points = []

            for (const k of klines) {
                const openTime = Number(k[0])
                const high = Number(k[2])
                const low = Number(k[3])
                const close = Number(k[4])
                const volume = Number(k[5])

                if (![high, low, close, volume].every(Number.isFinite)) continue

                const tp = typicalPriceFromOHLC(high, low, close)

                if (openTime < currentMinuteStart) {
                    pvClosed += tp * volume
                    volClosed += volume
                    lastClosedKlineOpenTime.current = openTime

                    if (volClosed > 0) {
                        points.push({
                            time: Math.floor(openTime / 1000),
                            value: pvClosed / volClosed
                        })
                    }
                } else {
                    currentK = { openTime, high, low, close, volume }
                }
            }

            sessionPVClosed.current = pvClosed
            sessionVolClosed.current = volClosed
            currentKline.current = currentK

            // Add the current partial kline point
            let currentVwapVal = null
            if (currentK && Number(currentK.volume) > 0) {
                const tp = typicalPriceFromOHLC(currentK.high, currentK.low, currentK.close)
                const currentPV = pvClosed + tp * Number(currentK.volume)
                const currentVol = volClosed + Number(currentK.volume)
                currentVwapVal = currentVol > 0 ? currentPV / currentVol : null

                if (currentVwapVal !== null) {
                    points.push({
                        time: Math.floor(currentK.openTime / 1000),
                        value: currentVwapVal
                    })
                }
            }

            vwapDataRef.current = points
            setVwapData([...points])
            setActiveVwap(currentVwapVal ?? (volClosed > 0 ? pvClosed / volClosed : null))

        } catch (err) {
            console.error('Error fetching initial VWAP:', err)
        }
    }, [])

    const connectWS = useCallback(() => {
        const url = `${WS_COMBINED_BASE}${SYMBOL_WS}@bookTicker/${SYMBOL_WS}@kline_1m`
        const ws = new WebSocket(url)
        wsRef.current = ws

        ws.onopen = () => {
            attemptsRef.current = 0
        }

        ws.onmessage = (evt) => {
            try {
                const msg = JSON.parse(evt.data)
                const stream = msg?.stream
                const data = msg?.data

                if (!stream || !data) return

                if (stream.endsWith('@kline_1m')) {
                    const k = data.k
                    if (!k) return

                    const nowDayStart = getUtcDayStartMs()
                    if (nowDayStart !== sessionDayStartMs.current) {
                        // New day started, need to refetch and reset
                        sessionDayStartMs.current = nowDayStart
                        fetchInitialData()
                        return
                    }

                    const openTime = Number(k.t)
                    const high = Number(k.h)
                    const low = Number(k.l)
                    const close = Number(k.c)
                    const volume = Number(k.v)
                    const isClosed = Boolean(k.x)

                    if (![openTime, high, low, close, volume].every(Number.isFinite)) return

                    if (!currentKline.current || currentKline.current.openTime !== openTime) {
                        currentKline.current = { openTime, high, low, close, volume }
                    } else {
                        currentKline.current.high = high
                        currentKline.current.low = low
                        currentKline.current.close = close
                        currentKline.current.volume = volume
                    }

                    if (isClosed && lastClosedKlineOpenTime.current !== openTime) {
                        const tp = typicalPriceFromOHLC(high, low, close)
                        sessionPVClosed.current += tp * volume
                        sessionVolClosed.current += volume
                        lastClosedKlineOpenTime.current = openTime
                        currentKline.current = null
                    }

                    // Recalc current VWAP
                    let pv = sessionPVClosed.current
                    let vol = sessionVolClosed.current

                    if (currentKline.current && Number(currentKline.current.volume) > 0) {
                        const tp = typicalPriceFromOHLC(currentKline.current.high, currentKline.current.low, currentKline.current.close)
                        pv += tp * Number(currentKline.current.volume)
                        vol += Number(currentKline.current.volume)
                    }

                    const val = vol > 0 ? pv / vol : null

                    if (val !== null) {
                        setActiveVwap(val)
                        const tSecs = Math.floor(openTime / 1000)

                        // Update points array
                        const pts = vwapDataRef.current
                        const lastPt = pts.length > 0 ? pts[pts.length - 1] : null

                        if (lastPt && lastPt.time === tSecs) {
                            lastPt.value = val
                        } else {
                            pts.push({ time: tSecs, value: val })
                        }

                        // force re-render with new array ref if closed or just periodically
                        // to avoid excessive re-renders, we'll only update state if we want the chart to see it
                        // CandlestickChart requires a new array reference to update series via react effect
                        setVwapData([...pts])
                    }
                }
            } catch (e) {
                console.warn('[VWAP WS] Parse error:', e)
            }
        }

        ws.onclose = () => scheduleReconnect()
        ws.onerror = () => ws.close()
    }, [fetchInitialData])

    const scheduleReconnect = useCallback(() => {
        const delay = Math.min(1000 * 2 ** attemptsRef.current, 30000)
        attemptsRef.current += 1
        clearTimeout(reconnTimerRef.current)
        reconnTimerRef.current = setTimeout(() => {
            connectWS()
        }, delay)
    }, [connectWS])

    useEffect(() => {
        fetchInitialData().then(() => {
            connectWS()
        })

        return () => {
            clearTimeout(reconnTimerRef.current)
            if (wsRef.current) {
                wsRef.current.close()
            }
        }
    }, [fetchInitialData, connectWS])

    return { vwapData, activeVwap }
}
