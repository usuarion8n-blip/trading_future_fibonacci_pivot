import { query } from '../config/database.js';
import { config } from '../config/constants.js';

export class PivotService {
    static async getRecentPivots(limit = 2) {
        const sql = `SELECT pp, r1, r2, r3, s1, s2, s3 FROM ${config.db.pivotsTable} ORDER BY run_ts DESC LIMIT $1`;
        const result = await query(sql, [limit]);
        return result.rows;
    }
}
