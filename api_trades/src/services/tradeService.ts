import { query } from '../config/database.js';
import { config } from '../config/constants.js';

export class TradeService {
    static async getAllTrades() {
        const sql = `SELECT * FROM ${config.db.tradesTable} ORDER BY entry_ts DESC`;
        const result = await query(sql);
        return result.rows;
    }
}
