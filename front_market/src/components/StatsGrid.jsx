/**
 * StatsGrid — 6 stat cards below the price
 */
export default function StatsGrid({
    fundingRate,
    countdown,
    sessionHigh,
    sessionLow,
    lastUpdate,
    tickCount,
    formatPrice,
}) {
    const fPct = fundingRate !== null
        ? (fundingRate * 100).toFixed(4)
        : null

    const fundingColor = fPct !== null
        ? (parseFloat(fPct) >= 0 ? 'var(--green)' : 'var(--red)')
        : undefined

    return (
        <div className="stats-grid">
            <div className="stat-card">
                <span className="stat-label">Funding Rate</span>
                <span className="stat-value" style={{ color: fundingColor }}>
                    {fPct !== null ? `${parseFloat(fPct) > 0 ? '+' : ''}${fPct}%` : '—'}
                </span>
            </div>

            <div className="stat-card">
                <span className="stat-label">Próximo Funding</span>
                <span className="stat-value">{countdown}</span>
            </div>

            <div className="stat-card">
                <span className="stat-label">Máximo (sesión)</span>
                <span className="stat-value">
                    {sessionHigh !== null ? `$${formatPrice(sessionHigh)}` : '—'}
                </span>
            </div>

            <div className="stat-card">
                <span className="stat-label">Mínimo (sesión)</span>
                <span className="stat-value">
                    {sessionLow !== null ? `$${formatPrice(sessionLow)}` : '—'}
                </span>
            </div>

            <div className="stat-card">
                <span className="stat-label">Último update</span>
                <span className="stat-value mono">{lastUpdate}</span>
            </div>

            <div className="stat-card">
                <span className="stat-label">Ticks recibidos</span>
                <span className="stat-value mono">{tickCount}</span>
            </div>
        </div>
    )
}
