/**
 * Header — logo + WS status indicator
 */
export default function Header({ wsStatus }) {
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

            <div className="header-right">
                <div className="ws-status">
                    <span className={`ws-dot ${wsStatus}`} />
                    <span>{labels[wsStatus] ?? wsStatus}</span>
                </div>
            </div>
        </header>
    )
}
