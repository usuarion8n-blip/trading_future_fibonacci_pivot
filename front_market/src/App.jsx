/**
 * App — root component, wires up all the pieces
 */
import { useState } from 'react'
import Header from './components/Header.jsx'
import PriceHero from './components/PriceHero.jsx'
import StatsGrid from './components/StatsGrid.jsx'
import CandlestickChart from './components/CandlestickChart.jsx'
import TickFeed from './components/TickFeed.jsx'
import TradeHistory from './components/TradeHistory.jsx'
import { useMarketWebSocket } from './hooks/useMarketWebSocket.js'

export default function App() {
    const [page, setPage] = useState('dashboard')

    const {
        wsStatus,
        price,
        openPrice,
        sessionHigh,
        sessionLow,
        fundingRate,
        countdown,
        lastUpdate,
        tickCount,
        ticks,
        clearTicks,
        formatPrice,
    } = useMarketWebSocket()

    return (
        <>
            {/* Animated dark background grid */}
            <div className="bg-grid" />

            <div className="app">
                <Header
                    wsStatus={wsStatus}
                    activePage={page}
                    onNavigate={setPage}
                />

                {page === 'trades' ? (
                    <TradeHistory onBack={() => setPage('dashboard')} />
                ) : (
                    <>
                        {/* Price + Stats row */}
                        <section className="price-hero">
                            <PriceHero priceObj={price} openPrice={openPrice} />
                            <StatsGrid
                                fundingRate={fundingRate}
                                countdown={countdown}
                                sessionHigh={sessionHigh}
                                sessionLow={sessionLow}
                                lastUpdate={lastUpdate}
                                tickCount={tickCount}
                                formatPrice={formatPrice}
                            />
                        </section>

                        <CandlestickChart priceObj={price} />

                        <TickFeed ticks={ticks} clearTicks={clearTicks} />
                    </>
                )}
            </div>
        </>
    )
}
