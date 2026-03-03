/**
 * PriceHero — large price display + change vs open
 */
import { useEffect, useState } from 'react'

function formatPrice(val) {
    return parseFloat(val).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })
}

export default function PriceHero({ priceObj, openPrice }) {
    const [flashClass, setFlashClass] = useState('')

    // Flash green/red on every new price tick
    useEffect(() => {
        if (!priceObj) return
        const { value, prev } = priceObj
        if (prev === null || prev === undefined) return

        const cls = value > prev ? 'up' : value < prev ? 'down' : ''
        if (!cls) return

        setFlashClass(cls)
        const timer = setTimeout(() => setFlashClass(''), 600)
        return () => clearTimeout(timer)
    }, [priceObj])

    const currentPrice = priceObj?.value ?? null
    const absChange = currentPrice !== null && openPrice !== null
        ? currentPrice - openPrice : null
    const pctChange = absChange !== null && openPrice
        ? (absChange / openPrice) * 100 : null

    const changeDir = absChange !== null
        ? absChange >= 0 ? 'up' : 'down'
        : ''

    const sign = absChange !== null ? (absChange >= 0 ? '+' : '') : ''

    return (
        <div className="price-main">
            <span className="price-label">MARK PRICE</span>

            <div className={`price-value ${flashClass}`}>
                {currentPrice !== null ? `$${formatPrice(currentPrice)}` : '—'}
            </div>

            <div className={`price-change ${changeDir}`}>
                <span>{changeDir === 'up' ? '▲' : changeDir === 'down' ? '▼' : '▲'}</span>
                <span>{pctChange !== null ? `${sign}${pctChange.toFixed(2)}%` : '0.00%'}</span>
                <span>{absChange !== null ? `${sign}${formatPrice(absChange)}` : '+0.00'}</span>
                <span className="change-period">vs apertura</span>
            </div>
        </div>
    )
}
