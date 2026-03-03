# 📈 Trading Futures — Fibonacci Pivot Strategy

Sistema automatizado de detección de oportunidades de trading en futuros de criptomonedas, basado en **niveles de pivot Fibonacci**. Conecta con Binance Futures en tiempo real y persiste los datos en Supabase.

---

## 🏗️ Arquitectura

```
trading_futures/
├── listening_service/     # Calcula y guarda los pivots Fibonacci en Supabase
├── detect_oportunity/     # Detecta oportunidades en tiempo real vía WebSocket
└── front_market/          # Dashboard React para visualizar el mercado y los pivots
```

```
Binance Futures REST API
        │
        ▼
┌─────────────────────┐       upsert      ┌──────────────┐
│  listening_service  │ ─────────────────▶│   Supabase   │
│  (calcula pivots)   │                   │  (Postgres)  │
└─────────────────────┘                   └──────┬───────┘
                                                 │  lee pivots (2 días)
Binance Futures WebSocket (bookTicker)           │
        │                                        ▼
        ▼                              ┌──────────────────────┐
┌─────────────────────┐   guarda ops  │  detect_oportunity   │
│   (precios BID/ASK) │ ─────────────▶│  (detecta rebotes)   │
└─────────────────────┘               └──────────────────────┘
                                                 │
                                         consulta datos
                                                 ▼
                                      ┌──────────────────┐
                                      │   front_market   │
                                      │  (React + Vite)  │
                                      └──────────────────┘
```

---

## 📦 Servicios

### 1. `listening_service` — Cálculo de Pivots Fibonacci

Obtiene las últimas velas diarias completas de **Binance Futures REST API** y calcula los niveles de pivot Fibonacci diarios para el símbolo configurado. Guarda los resultados en la tabla `fib_pivot_daily` de Supabase mediante upsert.

**Fórmulas utilizadas:**
| Nivel | Fórmula |
|-------|---------|
| PP    | `(H + L + C) / 3` |
| R1    | `PP + range × 0.382` |
| R2    | `PP + range × 0.618` |
| R3    | `PP + range × 1.0` |
| S1    | `PP - range × 0.382` |
| S2    | `PP - range × 0.618` |
| S3    | `PP - range × 1.0` |

**Ejecutar:**
```bash
cd listening_service
npm install
npm run dev
```

---

### 2. `detect_oportunity` — Detector de Oportunidades en Tiempo Real

Se conecta al stream `bookTicker` de **Binance Futures WebSocket** y monitorea el precio en tiempo real contra **los niveles de pivot de los 2 últimos días** cargados desde Supabase. Cuando el precio toca un nivel y rebota, registra una operación en la tabla `sim_trades`.

#### Lógica de detección

1. Al arrancar, carga los **2 registros más recientes** de `fib_pivot_daily` (`loadRecentPivots(2)`) y restaura los trades `OPEN` de sesiones anteriores (`restoreOpenTrades`).
2. En cada tick, evalúa `S1`, `S2`, `R1`, `R2` para **ambos días** simultáneamente.
3. Cada nivel se identifica unívocamente con la clave `${baseDay}:${level}` para evitar colisiones entre días.
4. **Flujo de señal:**
   - El precio se acerca a un nivel (dentro de `TOUCH_BUFFER_BPS` bps) → marcado como *toque*
   - El precio rebota `REBOUND_BPS` bps en la dirección esperada
   - Se confirma el rebote durante `CONFIRM_TICKS` ticks consecutivos → **se abre el trade**
5. Una vez abierto un trade, el nivel queda **bloqueado** (`lockedLevelKey`) para ese `baseDay:level` hasta que el trade se cierre, evitando señales duplicadas.
6. El trade se cierra automáticamente al alcanzar el TP o el SL. Se usa un flag `closing` para evitar dobles cierres en el mismo tick.

**Niveles monitoreados:**
- `S1`, `S2` → señal **LONG** (rebote alcista)
- `R1`, `R2` → señal **SHORT** (rebote bajista)

#### Cálculo de PnL y cantidad

| Campo | Descripción |
|-------|-------------|
| `qty_btc` | Cantidad de BTC operada (configurable via `QTY_BTC`) |
| `notional_in` | `qty × entryPrice` — valor en USDT al entrar |
| `notional_out` | `qty × exitPrice` — valor en USDT al salir |
| `pnl_usdt` | `(exitPrice − entryPrice) × qty` para LONG; inverso para SHORT |
| `pivot_base_day_used` | El `base_day` del pivot que generó la señal |

**Ejecutar:**
```bash
cd detect_oportunity
npm install
npm run dev
```

---

### 3. `front_market` — Dashboard de Mercado

Aplicación **React + Vite** que muestra en tiempo real:
- Gráfico de velas con **Lightweight Charts**
- **Dos sets de líneas de niveles Fibonacci** obtenidos de Supabase:
  - 🔶 **Ayer** — líneas `Dashed`, colores sólidos (R1, R2, R3, P, S1, S2, S3)
  - 🔸 **Anteayer** — líneas `Dotted`, colores semitransparentes (R1-2, R2-2, …, S3-2)
- Badge de precios de pivot para ambos días en la barra del gráfico
- Estadísticas del mercado vía WebSocket de Binance

**Ejecutar:**
```bash
cd front_market
npm install
npm run dev
```

---

## 🗄️ Base de Datos — Supabase

### Tablas requeridas

| Tabla | Descripción |
|-------|-------------|
| `fib_pivot_daily` | Niveles Fibonacci diarios calculados por `listening_service` |
| `sim_trades` | Operaciones abiertas/cerradas registradas por `detect_oportunity` |

### Campos relevantes de `sim_trades`

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `pivot_base_day` | date | Día del pivot que generó la señal |
| `level` | text | Nivel tocado (S1, S2, R1, R2) |
| `side` | text | LONG o SHORT |
| `entry_price` | numeric | Precio de entrada |
| `tp_price` | numeric | Precio de take profit |
| `sl_price` | numeric | Precio de stop loss |
| `exit_price` | numeric | Precio de cierre |
| `exit_reason` | text | TP o SL |
| `pnl_usdt` | numeric | PnL real en USDT (con qty) |
| `meta` | jsonb | Datos adicionales: `qty_btc`, `notional_in`, `notional_out`, `pivot_base_day_used`, etc. |

---

## ⚙️ Configuración

Cada servicio requiere un archivo `.env` en su raíz. Usa los `.env.example` como plantilla:

```bash
# Para cada servicio:
cp .env.example .env
# Luego edita .env con tus credenciales reales
```

### Variables por servicio

#### `listening_service/.env`
| Variable | Descripción |
|----------|-------------|
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave de servicio de Supabase (privilegios completos) |
| `SUPABASE_TABLE` | Nombre de la tabla de pivots (por defecto: `fib_pivot_daily`) |

#### `detect_oportunity/.env`
| Variable | Descripción | Valor por defecto |
|----------|-------------|-------------------|
| `SUPABASE_URL` | URL del proyecto Supabase | — |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave de servicio de Supabase | — |
| `SYMBOL_WS` | Símbolo para el WebSocket de Binance | `btcusdt` |
| `SYMBOL_DB` | Símbolo para guardar en BD | `BTCUSDT` |
| `INTERVAL` | Intervalo de velas | `1m` |
| `PIVOT_TABLE` | Tabla de pivots | `fib_pivot_daily` |
| `TRADES_TABLE` | Tabla de trades | `sim_trades` |
| `TOUCH_BUFFER_BPS` | Buffer de toque en puntos básicos | `2` |
| `REBOUND_BPS` | Rebote mínimo en puntos básicos | `6` |
| `CONFIRM_TICKS` | Ticks de confirmación consecutivos | `3` |
| `TP_PCT` | Take profit porcentual | `0.0015` (0.15%) |
| `SL_PCT` | Stop loss porcentual | `0.0015` (0.15%) |
| `QTY_BTC` | Cantidad de BTC por operación | `0.0001` |
| `MAX_OPEN_TRADES` | Máximo de trades abiertos simultáneos | `1` |
| `COOLDOWN_MS` | Tiempo mínimo entre señales del mismo nivel | — |

#### `front_market/.env`
| Variable | Descripción |
|----------|-------------|
| `VITE_SUPABASE_URL` | URL del proyecto Supabase |
| `VITE_SUPABASE_ANON_KEY` | Clave anon/pública de Supabase (**no uses la service role key aquí**) |

---

## 🚀 Stack Tecnológico

| Tecnología | Uso |
|-----------|-----|
| **Node.js** (ESM) | Runtime para `listening_service` y `detect_oportunity` |
| **React 18 + Vite** | Frontend del dashboard |
| **Supabase** | Base de datos PostgreSQL + cliente JS |
| **Binance Futures API** | Fuente de datos de mercado (REST + WebSocket) |
| **Lightweight Charts** | Librería de gráficos de velas |
| **ws** | Cliente WebSocket para Node.js |

---

## ⚠️ Advertencias

- Este sistema es una **simulación de trading** (`sim_trades`). No ejecuta órdenes reales en Binance.
- `QTY_BTC` define la cantidad de BTC por operación. Ajusta según el balance disponible y el margen del exchange.
