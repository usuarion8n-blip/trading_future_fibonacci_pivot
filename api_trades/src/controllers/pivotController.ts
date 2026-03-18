import { Request, Response } from 'express';
import { PivotService } from '../services/pivotService.js';

export class PivotController {
    static async getRecentPivots(req: Request, res: Response) {
        try {
            const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 2;
            const symbol = req.query.symbol as string | undefined;
            const interval = req.query.interval as string | undefined;
            
            const pivots = await PivotService.getRecentPivots(limit, symbol, interval);
            res.json({ success: true, count: pivots.length, data: pivots });
        } catch (err: any) {
            console.error('Error fetching pivots:', err);
            res.status(500).json({ success: false, message: 'Error fetching pivots', error: err.message });
        }
    }
}
