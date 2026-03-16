try {
    process.loadEnvFile();
} catch { }

export const config = {
    db: {
        url: process.env.DATABASE_URL,
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 5433,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres123',
        database: process.env.DB_NAME || 'mi_basedatos',
        tradesTable: process.env.TABLE_TRADES || 'sim_trades',
    },
    server: {
        port: process.env.PORT || 3000,
    }
};