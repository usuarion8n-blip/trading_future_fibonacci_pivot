import { Request, Response } from 'express';
import { TradeService } from '../services/tradeService.js';

export class TradeController {
    static async getTrades(req: Request, res: Response) {
        try {
            const trades = await TradeService.getAllTrades();
            res.json({
                success: true,
                count: trades.length,
                data: trades
            });
        } catch (err: any) {
            console.error('Error fetching trades:', err);
            res.status(500).json({
                success: false,
                message: 'Error fetching trades',
                error: err.message
            });
        }
    }
}
