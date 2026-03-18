import { query } from '../config/database.js';
import { config } from '../config/constants.js';

export class PivotService {
    static async getRecentPivots(limit = 2, symbol?: string, interval?: string) {
        let sql = `SELECT base_day, pp, r1, r2, r3, s1, s2, s3, symbol, interval, run_ts FROM ${config.db.pivotsTable}`;
        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        if (symbol) {
            conditions.push(`symbol = $${paramIndex++}`);
            params.push(symbol);
        }

        if (interval) {
            conditions.push(`interval = $${paramIndex++}`);
            params.push(interval);
        }

        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        sql += ` ORDER BY base_day DESC LIMIT $${paramIndex}`;
        params.push(limit);

        const result = await query(sql, params);
        return result.rows;
    }
}
