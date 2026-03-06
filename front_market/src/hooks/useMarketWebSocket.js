/**
 * useMarketWebSocket
 * Encapsula la conexión WebSocket a Binance Futures markPrice
 * y retorna todo el estado del mercado.
 */
import { useState, useEffect, useRef, useCallback } from 'react'

const WS_URL = 'wss://fstream.binance.com/ws/btcusdt@markPrice@1s'
const MAX_TICKS = 50
const LS_KEY = 'fm_market_state'

function formatPrice(val) {
    return parseFloat(val).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })
}

function formatCountdown(nextFundingTimeMs) {
    const diffMs = nextFundingTimeMs - Date.now()
    if (diffMs < 0) return '00:00:00'
    const h = Math.floor(diffMs / 3600000)
    const m = Math.floor((diffMs % 3600000) / 60000)
    const s = Math.floor((diffMs % 60000) / 1000)
    return [h, m, s].map(n => String(n).padStart(2, '0')).join(':')
}

/** Lee el estado guardado en localStorage (o devuelve null si no existe/error). */
function loadSavedState() {
    try {
        const raw = localStorage.getItem(LS_KEY)
        return raw ? JSON.parse(raw) : null
    } catch {
        return null
    }
}

/** Guarda campos relevantes en localStorage. */
function saveState(patch) {
    try {
        const prev = loadSavedState() ?? {}
        localStorage.setItem(LS_KEY, JSON.stringify({ ...prev, ...patch }))
    } catch { /* cuota llena u otro error → ignorar */ }
}

export function useMarketWebSocket() {
    // Carga estado previo UNA vez al inicio
    const saved = useRef(loadSavedState())

    const [wsStatus, setWsStatus] = useState('connecting') // connecting | connected | reconnecting | error
    const [price, setPrice] = useState(null)
    const [prevPrice, setPrevPrice] = useState(null)
    const [openPrice, setOpenPrice] = useState(saved.current?.openPrice ?? null)
    const [sessionHigh, setSessionHigh] = useState(saved.current?.sessionHigh ?? null)
    const [sessionLow, setSessionLow] = useState(saved.current?.sessionLow ?? null)
    const [fundingRate, setFundingRate] = useState(saved.current?.fundingRate ?? null)
    const [nextFundingTime, setNextFundingTime] = useState(null)
    const [countdown, setCountdown] = useState('—')
    const [lastUpdate, setLastUpdate] = useState(saved.current?.lastUpdate ?? '—')
    const [tickCount, setTickCount] = useState(saved.current?.ticks?.length ?? 0)
    const [ticks, setTicks] = useState(saved.current?.ticks ?? [])

    // Internal refs — avoid closure staleness
    const wsRef = useRef(null)
    const reconnTimerRef = useRef(null)
    const attemptsRef = useRef(0)
    const openPriceRef = useRef(saved.current?.openPrice ?? null)
    const highRef = useRef(saved.current?.sessionHigh ?? -Infinity)
    const lowRef = useRef(saved.current?.sessionLow ?? Infinity)
    const tickIdRef = useRef(saved.current?.ticks?.length ?? 0)
    const nextFundRef = useRef(null)

    // Countdown ticker
    useEffect(() => {
        const id = setInterval(() => {
            if (nextFundRef.current) {
                setCountdown(formatCountdown(nextFundRef.current))
            }
        }, 1000)
        return () => clearInterval(id)
    }, [])

    const connect = useCallback(() => {
        const ws = new WebSocket(WS_URL)
        wsRef.current = ws
        setWsStatus('connecting')

        ws.onopen = () => {
            attemptsRef.current = 0
            setWsStatus('connected')
        }

        ws.onmessage = (evt) => {
            try {
                const data = JSON.parse(evt.data)
                const newPrice = parseFloat(data.p)
                const funding = data.r
                const nextTime = data.T
                const evtTimeMs = data.E

                if (isNaN(newPrice)) return

                // Open / high / low
                if (openPriceRef.current === null) {
                    openPriceRef.current = newPrice
                    setOpenPrice(newPrice)
                    saveState({ openPrice: newPrice })
                }
                if (newPrice > highRef.current) {
                    highRef.current = newPrice
                    setSessionHigh(newPrice)
                    saveState({ sessionHigh: newPrice })
                }
                if (newPrice < lowRef.current) {
                    lowRef.current = newPrice
                    setSessionLow(newPrice)
                    saveState({ sessionLow: newPrice })
                }

                // Funding
                if (funding !== undefined) {
                    const fr = parseFloat(funding)
                    setFundingRate(fr)
                    saveState({ fundingRate: fr })
                }
                if (nextTime) {
                    nextFundRef.current = nextTime
                    setNextFundingTime(nextTime)
                    setCountdown(formatCountdown(nextTime))
                }

                // Time
                const now = new Date(evtTimeMs || Date.now())
                const timeStr = now.toLocaleTimeString('es-PE', { hour12: false })
                setLastUpdate(timeStr)
                saveState({ lastUpdate: timeStr })

                // Price state (triggers flash via component)
                setPrevPrice(p => {
                    const prev = p
                    setPrice({ value: newPrice, prev, evtTimeMs })
                    return newPrice
                })

                setTickCount(c => c + 1)

                // Tick feed
                const tickTime = new Date(evtTimeMs || Date.now())
                    .toLocaleTimeString('es-PE', { hour12: false })
                const id = tickIdRef.current++
                setTicks(prev => {
                    const newTicks = [
                        {
                            id,
                            time: tickTime,
                            price: newPrice,
                            formattedPrice: formatPrice(newPrice),
                            funding: funding ?? '0',
                            fundingPct: (parseFloat(funding || 0) * 100).toFixed(4),
                        },
                        ...prev.slice(0, MAX_TICKS - 1),
                    ]
                    saveState({ ticks: newTicks })
                    return newTicks
                })
            } catch (e) {
                console.warn('[WS] Error parsing:', e)
            }
        }

        ws.onerror = () => setWsStatus('error')

        ws.onclose = (evt) => {
            if (evt.code !== 1000) scheduleReconnect()
        }
    }, [])

    const scheduleReconnect = useCallback(() => {
        const delay = Math.min(1000 * 2 ** attemptsRef.current, 30000)
        attemptsRef.current += 1
        setWsStatus('reconnecting')
        clearTimeout(reconnTimerRef.current)
        reconnTimerRef.current = setTimeout(connect, delay)
    }, [connect])

    useEffect(() => {
        connect()
        return () => {
            clearTimeout(reconnTimerRef.current)
            if (wsRef.current) wsRef.current.close(1000)
        }
    }, [connect])

    const clearTicks = useCallback(() => {
        setTicks([])
        setTickCount(0)
        saveState({ ticks: [] })
    }, [])

    return {
        wsStatus,
        price,
        prevPrice,
        openPrice,
        sessionHigh,
        sessionLow,
        fundingRate,
        nextFundingTime,
        countdown,
        lastUpdate,
        tickCount,
        ticks,
        clearTicks,
        formatPrice,
    }
}
