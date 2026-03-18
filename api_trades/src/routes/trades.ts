import { Router } from 'express';
import { TradeController } from '../controllers/tradeController.js';

const router = Router();

router.get('/trades/statuses', TradeController.getStatuses);
router.get('/trades/stats', TradeController.getStats);
router.get('/trades', TradeController.getTrades);
router.get('/trades/:id', TradeController.getTradeById);
router.post('/trades', TradeController.createTrade);
router.put('/trades/:id', TradeController.updateTrade);

export default router;
