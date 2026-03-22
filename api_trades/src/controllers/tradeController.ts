import { Request, Response } from 'express';
import { TradeService, TradeFilter } from '../services/tradeService.js';
import { config } from '../config/constants.js';

export class TradeController {
    
    // Parse common filters
    private static parseFilters(req: Request): TradeFilter {
        return {
            status: req.query.status as string,
            dateFilter: req.query.date as string,
            nivelFilter: req.query.level as string,
            symbol: req.query.symbol as string,
            strategy_name: req.query.strategy_name as string,
            service_name: req.query.service_name as string,
            page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
            pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined
        };
    }

    static async getTrades(req: Request, res: Response) {
        try {
            let tableName = config.db.tradesTable;
            if (req.path.includes('/sim_igual_tp')) {
                tableName = config.db.simTradesIgualTpTable;
            } else if (req.path.includes('/sim')) {
                tableName = config.db.simTradesTable;
            }
            const filters = TradeController.parseFilters(req);
            const { trades, totalCount } = await TradeService.getTrades(filters, tableName);
            
            res.json({
                success: true,
                count: totalCount,
                data: trades
            });
        } catch (err: any) {
            console.error('Error fetching trades:', err);
            res.status(500).json({ success: false, message: 'Error fetching trades', error: err.message });
        }
    }

    static async getStats(req: Request, res: Response) {
        try {
            let tableName = config.db.tradesTable;
            if (req.path.includes('/sim_igual_tp')) {
                tableName = config.db.simTradesIgualTpTable;
            } else if (req.path.includes('/sim')) {
                tableName = config.db.simTradesTable;
            }
            const filters = TradeController.parseFilters(req);
            const stats = await TradeService.getStats(filters, tableName);
            res.json({ success: true, count: stats.length, data: stats });
        } catch (err: any) {
            console.error('Error fetching stats:', err);
            res.status(500).json({ success: false, message: 'Error fetching stats', error: err.message });
        }
    }

    static async getStatuses(req: Request, res: Response) {
        try {
            let tableName = config.db.tradesTable;
            if (req.path.includes('/sim_igual_tp')) {
                tableName = config.db.simTradesIgualTpTable;
            } else if (req.path.includes('/sim')) {
                tableName = config.db.simTradesTable;
            }
            const statuses = await TradeService.getDistinctStatuses(tableName);
            res.json({ success: true, data: statuses });
        } catch (err: any) {
            console.error('Error fetching statuses:', err);
            res.status(500).json({ success: false, message: 'Error fetching statuses', error: err.message });
        }
    }

    static async createTrade(req: Request, res: Response) {
        try {
            let tableName = config.db.tradesTable;
            if (req.path.includes('/sim_igual_tp')) {
                tableName = config.db.simTradesIgualTpTable;
            } else if (req.path.includes('/sim')) {
                tableName = config.db.simTradesTable;
            }
            const tradeData = req.body;
            const newTrade = await TradeService.createTrade(tradeData, tableName);
            res.status(201).json({ success: true, data: newTrade });
        } catch (err: any) {
            console.error('Error creating trade:', err);
            res.status(500).json({ success: false, message: 'Error creating trade', error: err.message });
        }
    }

    static async getTradeById(req: Request, res: Response) {
        try {
            let tableName = config.db.tradesTable;
            if (req.path.includes('/sim_igual_tp')) {
                tableName = config.db.simTradesIgualTpTable;
            } else if (req.path.includes('/sim')) {
                tableName = config.db.simTradesTable;
            }
            const id = req.params.id as string;
            const trade = await TradeService.getTradeById(id, tableName);
            if (!trade) {
                return res.status(404).json({ success: false, message: 'Trade not found' });
            }
            res.json({ success: true, data: trade });
        } catch (err: any) {
            console.error('Error fetching trade by ID:', err);
            res.status(500).json({ success: false, message: 'Error fetching trade', error: err.message });
        }
    }

    static async updateTrade(req: Request, res: Response) {
        try {
            let tableName = config.db.tradesTable;
            if (req.path.includes('/sim_igual_tp')) {
                tableName = config.db.simTradesIgualTpTable;
            } else if (req.path.includes('/sim')) {
                tableName = config.db.simTradesTable;
            }
            const id = req.params.id as string;
            const updateData = req.body;
            const updatedTrade = await TradeService.updateTrade(id, updateData, tableName);
            
            if (!updatedTrade) {
                return res.status(404).json({ success: false, message: 'Trade not found' });
            }
            
            res.json({ success: true, data: updatedTrade });
        } catch (err: any) {
            console.error('Error updating trade:', err);
            res.status(500).json({ success: false, message: 'Error updating trade', error: err.message });
        }
    }
}
