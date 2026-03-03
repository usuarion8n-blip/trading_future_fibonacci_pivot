/**
 * TickFeed — real-time tick list (most recent on top)
 */
export default function TickFeed({ ticks, clearTicks }) {
    return (
        <section className="feed-section">
            <div className="feed-header">
                <h2 className="feed-title">Feed de ticks</h2>
                <button className="clear-btn" onClick={clearTicks}>
                    Limpiar
                </button>
            </div>

            <div className="feed-list">
                {ticks.map(tick => {
                    const dir = tick.dir ?? 0
                    const arrowClass = dir > 0 ? 'up' : dir < 0 ? 'down' : 'flat'
                    const arrowChar = dir > 0 ? '▲' : dir < 0 ? '▼' : '━'

                    return (
                        <div key={tick.id} className="feed-item">
                            <span className="feed-time">{tick.time}</span>
                            <span className="feed-price">${tick.formattedPrice}</span>
                            <span className="feed-funding">{tick.fundingPct}%</span>
                            <span className={`feed-arrow ${arrowClass}`}>{arrowChar}</span>
                        </div>
                    )
                })}
            </div>
        </section>
    )
}
