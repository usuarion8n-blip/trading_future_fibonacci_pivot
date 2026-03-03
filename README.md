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
                                                 │  lee pivots
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

Obtiene las últimas 6 velas diarias completas de **Binance Futures REST API** y calcula los niveles de pivot Fibonacci diarios para el símbolo configurado. Guarda los resultados en la tabla `fib_pivot_daily` de Supabase mediante upsert.

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

Se conecta al stream `bookTicker` de **Binance Futures WebSocket** y monitorea el precio en tiempo real contra los niveles de pivot cargados desde Supabase. Cuando el precio toca un nivel y rebota, registra una operación simulada en la tabla `sim_trades`.

**Lógica de detección:**
1. El precio se acerca a un nivel (dentro de `TOUCH_BUFFER_BPS` puntos básicos) → se marca como *toque*
2. El precio rebota `REBOUND_BPS` puntos básicos en la dirección correcta
3. Se confirma el rebote durante `CONFIRM_TICKS` ticks consecutivos → **se abre la operación**
4. La operación se cierra automáticamente al alcanzar el `TP_USDT` o `SL_USDT`

**Niveles monitoreados:**
- `S1`, `S2` → señal **LONG** (rebote alcista)
- `R1`, `R2` → señal **SHORT** (rebote bajista)

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
- Líneas de niveles Pivot (PP, R1, R2, S1, S2) obtenidas de Supabase
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
| `TOUCH_BUFFER_BPS` | Buffer de toque en puntos básicos | `2` |
| `REBOUND_BPS` | Rebote mínimo en puntos básicos | `6` |
| `CONFIRM_TICKS` | Ticks de confirmación | `3` |
| `TP_USDT` | Take profit en USDT | `200` |
| `SL_USDT` | Stop loss en USDT | `100` |

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

- **Nunca subas tu archivo `.env` al repositorio.** Contiene claves secretas de Supabase.
- Este sistema es una **simulación de trading** (`sim_trades`). No ejecuta órdenes reales en Binance.
- La `service_role_key` de Supabase tiene privilegios completos — solo úsala en los servicios de backend.
