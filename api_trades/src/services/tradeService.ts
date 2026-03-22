import { query } from '../config/database.js';
import { config } from '../config/constants.js';

export interface TradeFilter {
    status?: string;
    dateFilter?: string; // 'HOY', '1S', '1M', '1A'
    nivelFilter?: string; // 'VWAP', 'PIVOTS'
    symbol?: string;
    strategy_name?: string;
    service_name?: string;
    page?: number;
    pageSize?: number;
}

export class TradeService {

    private static buildWhereClause(filters: TradeFilter) {
        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        if (filters.status && filters.status !== 'ALL') {
            conditions.push(`status = $${paramIndex++}`);
            params.push(filters.status);
        }

        if (filters.dateFilter && filters.dateFilter !== 'ALL') {
            const now = new Date();
            if (filters.dateFilter === 'HOY') now.setHours(0, 0, 0, 0);
            else if (filters.dateFilter === '1S') now.setDate(now.getDate() - 7);
            else if (filters.dateFilter === '1M') now.setMonth(now.getMonth() - 1);
            else if (filters.dateFilter === '1A') now.setFullYear(now.getFullYear() - 1);

            conditions.push(`entry_ts >= $${paramIndex++}`);
            params.push(now.toISOString());
        }

        if (filters.nivelFilter && filters.nivelFilter !== 'ALL') {
            if (filters.nivelFilter === 'VWAP') {
                conditions.push(`level = $${paramIndex++}`);
                params.push('VWAP');
            } else if (filters.nivelFilter === 'PIVOTS') {
                conditions.push(`level IN ('R1', 'R2', 'R3', 'S1', 'S2', 'S3')`);
            }
        }

        if (filters.symbol) {
            conditions.push(`symbol = $${paramIndex++}`);
            params.push(filters.symbol);
        }

        if (filters.strategy_name) {
            conditions.push(`strategy_name = $${paramIndex++}`);
            params.push(filters.strategy_name);
        }

        if (filters.service_name) {
            conditions.push(`service_name = $${paramIndex++}`);
            params.push(filters.service_name);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        return { whereClause, params, paramIndex };
    }

    static async getTrades(filters: TradeFilter = {}, tableName: string = config.db.tradesTable) {
        let { whereClause, params, paramIndex } = this.buildWhereClause(filters);

        let sql = `SELECT * FROM ${tableName} ${whereClause} ORDER BY entry_ts DESC`;

        if (filters.page !== undefined && filters.pageSize !== undefined) {
            const offset = filters.page * filters.pageSize;
            sql += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
            params.push(filters.pageSize, offset);
        }

        // Get total count
        const countSql = `SELECT COUNT(*) FROM ${tableName} ${whereClause}`;
        const [result, countResult] = await Promise.all([
            query(sql, params),
            query(countSql, params.slice(0, filters.page !== undefined ? params.length - 2 : params.length))
        ]);

        return {
            trades: result.rows,
            totalCount: parseInt(countResult.rows[0].count, 10)
        };
    }

    static async getStats(filters: TradeFilter = {}, tableName: string = config.db.tradesTable) {
        const { whereClause, params } = this.buildWhereClause(filters);
        const sql = `SELECT id, status, pnl_usdt, meta FROM ${tableName} ${whereClause} ORDER BY entry_ts ASC`;
        const result = await query(sql, params);
        return result.rows;
    }

    static async getDistinctStatuses(tableName: string = config.db.tradesTable) {
        const sql = `SELECT DISTINCT status FROM ${tableName} WHERE status IS NOT NULL`;
        const result = await query(sql);
        return result.rows.map(r => r.status);
    }

    static async createTrade(tradeData: any, tableName: string = config.db.tradesTable) {
        const columns = Object.keys(tradeData);
        const values = Object.values(tradeData);

        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`;

        const result = await query(sql, values);
        return result.rows[0];
    }

    static async getTradeById(id: string | number, tableName: string = config.db.tradesTable) {
        const sql = `SELECT * FROM ${tableName} WHERE id = $1`;
        const result = await query(sql, [id]);
        return result.rows[0];
    }

    static async updateTrade(id: string | number, updateData: any, tableName: string = config.db.tradesTable) {
        const columns = Object.keys(updateData);
        const values = Object.values(updateData);

        if (columns.length === 0) return null;

        const setClause = columns.map((col, i) => `${col} = $${i + 1}`).join(', ');
        const sql = `UPDATE ${tableName} SET ${setClause} WHERE id = $${values.length + 1} RETURNING *`;

        const result = await query(sql, [...values, id]);
        return result.rows[0];
    }
}
