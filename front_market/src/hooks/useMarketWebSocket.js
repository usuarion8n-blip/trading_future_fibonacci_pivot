/**
 * useMarketWebSocket
 * Encapsula la conexión WebSocket a Binance Futures markPrice
 * y retorna todo el estado del mercado.
 */
import { useState, useEffect, useRef, useCallback } from 'react'

const WS_URL = 'wss://fstream.binance.com/ws/btcusdt@markPrice@1s'
const MAX_TICKS = 50

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

export function useMarketWebSocket() {
    const [wsStatus, setWsStatus] = useState('connecting') // connecting | connected | reconnecting | error
    const [price, setPrice] = useState(null)
    const [prevPrice, setPrevPrice] = useState(null)
    const [openPrice, setOpenPrice] = useState(null)
    const [sessionHigh, setSessionHigh] = useState(null)
    const [sessionLow, setSessionLow] = useState(null)
    const [fundingRate, setFundingRate] = useState(null)
    const [nextFundingTime, setNextFundingTime] = useState(null)
    const [countdown, setCountdown] = useState('—')
    const [lastUpdate, setLastUpdate] = useState('—')
    const [tickCount, setTickCount] = useState(0)
    const [ticks, setTicks] = useState([])

    // Internal refs — avoid closure staleness
    const wsRef = useRef(null)
    const reconnTimerRef = useRef(null)
    const attemptsRef = useRef(0)
    const openPriceRef = useRef(null)
    const highRef = useRef(-Infinity)
    const lowRef = useRef(Infinity)
    const tickIdRef = useRef(0)
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
                }
                if (newPrice > highRef.current) {
                    highRef.current = newPrice
                    setSessionHigh(newPrice)
                }
                if (newPrice < lowRef.current) {
                    lowRef.current = newPrice
                    setSessionLow(newPrice)
                }

                // Funding
                if (funding !== undefined) setFundingRate(parseFloat(funding))
                if (nextTime) {
                    nextFundRef.current = nextTime
                    setNextFundingTime(nextTime)
                    setCountdown(formatCountdown(nextTime))
                }

                // Time
                const now = new Date(evtTimeMs || Date.now())
                setLastUpdate(now.toLocaleTimeString('es-PE', { hour12: false }))

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
                setTicks(prev => [
                    {
                        id,
                        time: tickTime,
                        price: newPrice,
                        formattedPrice: formatPrice(newPrice),
                        funding: funding ?? '0',
                        fundingPct: (parseFloat(funding || 0) * 100).toFixed(4),
                    },
                    ...prev.slice(0, MAX_TICKS - 1),
                ])
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

    const clearTicks = useCallback(() => setTicks([]), [])

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
