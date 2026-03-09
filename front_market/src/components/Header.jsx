/**
 * Header — logo + WS status indicator + navigation
 */
export default function Header({ wsStatus, activePage, onNavigate }) {
    const labels = {
        connected: '● Conectado',
        connecting: 'Conectando…',
        reconnecting: 'Reconectando…',
        error: 'Error de conexión',
    }

    return (
        <header className="header">
            <div className="header-left">
                <div className="logo">
                    <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                        <circle cx="16" cy="16" r="16" fill="#F7931A" />
                        <path d="M22.5 13.5c.3-2.1-1.3-3.2-3.5-4l.7-2.8-1.7-.4-.7 2.7c-.4-.1-.9-.2-1.4-.3l.7-2.7-1.7-.4-.7 2.8c-.4-.1-.7-.2-1-.2v0l-2.4-.6-.5 1.8s1.3.3 1.2.3c.7.2.8.7.8 1l-.8 3.3c0 0 .1 0 .1 0l-.1 0-1.2 4.6c-.1.2-.3.6-.9.4 0 .1-1.2-.3-1.2-.3L9 20.8l2.2.6c.4.1.8.2 1.2.3l-.7 2.9 1.7.4.7-2.8c.5.1.9.2 1.4.4l-.7 2.8 1.7.4.7-2.8c2.9.5 5.1.3 6-2.3.7-2-.0-3.2-1.5-3.9 1.1-.2 1.9-1 2.1-2.6zm-3.8 5.3c-.5 2-3.9 1-5.1.6l.9-3.6c1.1.3 4.7.8 4.2 3zm.5-5.3c-.5 1.8-3.3 1-4.3.7l.8-3.3c1 .3 4 .8 3.5 2.6z" fill="white" />
                    </svg>
                    <span className="logo-text">
                        BTC<span className="logo-pair">/USDT</span>
                    </span>
                </div>
                <div className="badge badge--futures">FUTURES · PERPETUAL</div>
            </div>

            <nav className="header-nav">
                <button
                    className={`nav-btn ${activePage === 'dashboard' ? 'nav-btn--active' : ''}`}
                    onClick={() => onNavigate('dashboard')}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                        <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                    </svg>
                    Dashboard
                </button>
                <button
                    className={`nav-btn ${activePage === 'trades' ? 'nav-btn--active' : ''}`}
                    onClick={() => onNavigate('trades')}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                        <polyline points="10 9 9 9 8 9" />
                    </svg>
                    Historial de Trades
                </button>
            </nav>

            <div className="header-right">
                <div className="ws-status">
                    <span className={`ws-dot ${wsStatus}`} />
                    <span>{labels[wsStatus] ?? wsStatus}</span>
                </div>
            </div>
        </header>
    )
}
