/**
 * TradeHistory — displays simulated trades from the sim_trades Supabase table
 */
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../supabaseClient.js'

const PAGE_SIZE = 50

/* ── Formatters ──────────────────────────────────────── */
function fmtDate(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('es-PE', {
        dateStyle: 'short',
        timeStyle: 'medium',
    })
}

function fmtPrice(n, decimals = 2) {
    if (n == null) return '—'
    return Number(n).toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    })
}

/* ── Sub-components ──────────────────────────────────── */
function StatusBadge({ status }) {
    if (!status) return <span className="th-muted">—</span>
    const s = status.toUpperCase()
    let cls = ''
    if (s === 'OPEN') cls = 'th-badge-open'
    else if (s === 'WIN' || s.includes('TP') || s.includes('WIN')) cls = 'th-badge-win'
    else if (s === 'LOSS' || s.includes('SL') || s.includes('LOSS')) cls = 'th-badge-loss'
    else if (s.includes('EXPIR') || s.includes('CANCEL')) cls = 'th-badge-expired'
    return <span className={`th-badge ${cls}`}>{status}</span>
}

function SideBadge({ side }) {
    const upper = String(side ?? '').toUpperCase()
    const cls = upper === 'LONG' ? 'th-side-long' : 'th-side-short'
    return <span className={`th-badge ${cls}`}>{upper}</span>
}

function Pnl({ value }) {
    if (value == null) return <span className="th-mono th-muted">—</span>
    const n = Number(value)
    const cls = n > 0 ? 'th-pnl-pos' : n < 0 ? 'th-pnl-neg' : 'th-mono'
    const sign = n > 0 ? '+' : ''
    return <span className={`th-mono ${cls}`}>{sign}{fmtPrice(n)} <small>USDT</small></span>
}

/* ── Column definitions ──────────────────────────────── */
const COLUMNS = [
    { key: 'id', label: '#', render: r => <span className="th-mono th-muted">{r.id}</span> },
    { key: 'entry_ts', label: 'Entrada', render: r => <span className="th-mono th-muted">{fmtDate(r.entry_ts)}</span> },
    { key: 'symbol', label: 'Símbolo', render: r => <span className="th-symbol">{r.symbol}</span> },
    { key: 'interval', label: 'TF', render: r => <span className="th-mono th-muted">{r.interval}</span> },
    { key: 'level', label: 'Nivel', render: r => <span className="th-level">{r.level}</span> },
    { key: 'side', label: 'Lado', render: r => <SideBadge side={r.side} /> },
    { key: 'qty', label: 'Cant.', render: r => <span className="th-mono">{r.meta?.qty_btc ?? '—'}</span> },
    { key: 'status', label: 'Estado', render: r => <StatusBadge status={r.status} /> },
    { key: 'entry_price', label: 'Precio entrada', render: r => <span className="th-mono">{fmtPrice(r.entry_price)}</span> },
    { key: 'tp_price', label: 'TP', render: r => <span className="th-mono th-tp">{fmtPrice(r.tp_price)}</span> },
    { key: 'sl_price', label: 'SL', render: r => <span className="th-mono th-sl">{fmtPrice(r.sl_price)}</span> },
    { key: 'exit_price', label: 'Precio salida', render: r => <span className="th-mono">{fmtPrice(r.exit_price)}</span> },
    { key: 'exit_reason', label: 'Razón salida', render: r => r.exit_reason ? <span className="th-reason">{r.exit_reason}</span> : <span className="th-muted">—</span> },
    { key: 'pnl_usdt', label: 'PnL (USDT)', render: r => <Pnl value={r.pnl_usdt} /> },
    { key: 'exit_ts', label: 'Salida', render: r => <span className="th-mono th-muted">{fmtDate(r.exit_ts)}</span> },
    { key: 'pivot_base_day', label: 'Pivot Day', render: r => <span className="th-mono th-muted">{r.pivot_base_day ?? '—'}</span> },
]

/* ── Summary strip ───────────────────────────────────── */
function SummaryStrip({ trades }) {
    if (!trades.length) return null
    const closed = trades.filter(t => t.status !== 'OPEN' && t.pnl_usdt != null)
    const wins = closed.filter(t => t.pnl_usdt > 0).length
    const losses = closed.filter(t => t.pnl_usdt < 0).length
    const totalPnl = closed.reduce((acc, t) => acc + Number(t.pnl_usdt), 0)
    const wr = closed.length ? ((wins / closed.length) * 100).toFixed(1) : null

    return (
        <div className="th-summary">
            <div className="th-summary-card">
                <span className="th-summary-label">Trades en vista</span>
                <span className="th-summary-value">{trades.length}</span>
            </div>
            <div className="th-summary-card">
                <span className="th-summary-label">Ganadores</span>
                <span className="th-summary-value th-pnl-pos">{wins}</span>
            </div>
            <div className="th-summary-card">
                <span className="th-summary-label">Perdedores</span>
                <span className="th-summary-value th-pnl-neg">{losses}</span>
            </div>
            {wr !== null && (
                <div className="th-summary-card">
                    <span className="th-summary-label">Win rate</span>
                    <span className={`th-summary-value ${Number(wr) >= 50 ? 'th-pnl-pos' : 'th-pnl-neg'}`}>{wr}%</span>
                </div>
            )}
            <div className="th-summary-card">
                <span className="th-summary-label">PnL acumulado</span>
                <span className={`th-summary-value th-mono ${totalPnl > 0 ? 'th-pnl-pos' : totalPnl < 0 ? 'th-pnl-neg' : ''}`}>
                    {totalPnl > 0 ? '+' : ''}{fmtPrice(totalPnl)} USDT
                </span>
            </div>
        </div>
    )
}

/* ── Main component ──────────────────────────────────── */
export default function TradeHistory({ onBack }) {
    const [trades, setTrades] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [page, setPage] = useState(0)
    const [hasMore, setHasMore] = useState(true)
    const [total, setTotal] = useState(null)
    const [filter, setFilter] = useState('ALL')
    const [statuses, setStatuses] = useState([])   // dynamic from DB

    // Fetch distinct status values once on mount
    useEffect(() => {
        supabase
            .from('sim_trades')
            .select('status')
            .then(({ data }) => {
                if (!data) return
                const unique = ['ALL', ...new Set(data.map(r => r.status).filter(Boolean))]
                setStatuses(unique)
            })
    }, [])

    const fetchTrades = useCallback(async (pageIndex, statusFilter) => {
        setLoading(true)
        setError(null)

        const from = pageIndex * PAGE_SIZE
        const to = from + PAGE_SIZE - 1

        let query = supabase
            .from('sim_trades')
            .select('*', { count: 'exact' })
            .order('entry_ts', { ascending: false })
            .range(from, to)

        if (statusFilter !== 'ALL') {
            query = query.eq('status', statusFilter)
        }

        const { data, error: err, count } = await query

        setLoading(false)
        if (err) { setError(err.message); return }
        if (count !== null) setTotal(count)
        setTrades(data ?? [])
        setHasMore((data ?? []).length === PAGE_SIZE)
    }, [])

    useEffect(() => { fetchTrades(page, filter) }, [fetchTrades, page, filter])

    const handleFilter = (f) => {
        setPage(0)
        setFilter(f)
    }

    const FILTERS = statuses.length ? statuses : ['ALL']

    return (
        <div className="th-page">
            {/* ── Page Header ── */}
            <div className="th-header">
                <div className="th-header-left">
                    <button className="th-back-btn" onClick={onBack}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M19 12H5M12 5l-7 7 7 7" />
                        </svg>
                        Dashboard
                    </button>
                    <div className="th-title">
                        <span>📊</span>
                        Historial de Trades
                    </div>
                    {total !== null && (
                        <span className="th-count-badge">
                            {total.toLocaleString()} trades
                        </span>
                    )}
                </div>

                <div className="th-header-right">
                    {/* Status filter buttons */}
                    <div className="th-filters">
                        {FILTERS.map(f => (
                            <button
                                key={f}
                                className={`th-filter-btn ${filter === f ? 'th-filter-btn--active' : ''}`}
                                onClick={() => handleFilter(f)}
                            >
                                {f}
                            </button>
                        ))}
                    </div>

                    <button
                        className="th-refresh-btn"
                        onClick={() => fetchTrades(page, filter)}
                        disabled={loading}
                    >
                        <svg
                            width="14" height="14" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                            className={loading ? 'th-spin' : ''}
                        >
                            <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
                            <path d="M3.51 9a9 9 0 0114.14-3.36L23 10M1 14l5.35 4.36A9 9 0 0020.49 15" />
                        </svg>
                        {loading ? 'Cargando…' : 'Actualizar'}
                    </button>
                </div>
            </div>

            {/* ── Summary ── */}
            <SummaryStrip trades={trades} />

            {/* ── Error ── */}
            {error && (
                <div className="th-error">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    Error al cargar: {error}
                </div>
            )}

            {/* ── Table ── */}
            <div className="th-table-wrap">
                {loading && trades.length === 0 ? (
                    <div className="th-loading">
                        <div className="th-spinner" />
                        <span>Cargando historial…</span>
                    </div>
                ) : !loading && trades.length === 0 ? (
                    <div className="th-empty">
                        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.25">
                            <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" />
                        </svg>
                        <p>No hay trades registrados</p>
                    </div>
                ) : (
                    <table className="th-table">
                        <thead>
                            <tr>
                                {COLUMNS.map(col => (
                                    <th key={col.key} className="th-th">{col.label}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {trades.map(row => (
                                <tr key={row.id} className={`th-tr th-tr--${row.status?.toLowerCase()}`}>
                                    {COLUMNS.map(col => (
                                        <td key={col.key} className="th-td">
                                            {col.render(row)}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* ── Pagination ── */}
            {!loading && trades.length > 0 && (
                <div className="th-pagination">
                    <button
                        className="th-page-btn"
                        disabled={page === 0}
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                    >← Anterior</button>
                    <span className="th-page-info">
                        Pág. {page + 1}
                        {total !== null && ` · ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} de ${total.toLocaleString()}`}
                    </span>
                    <button
                        className="th-page-btn"
                        disabled={!hasMore}
                        onClick={() => setPage(p => p + 1)}
                    >Siguiente →</button>
                </div>
            )}
        </div>
    )
}
