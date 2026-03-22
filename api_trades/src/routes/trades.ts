import { Router } from 'express';
import { TradeController } from '../controllers/tradeController.js';

const router = Router();

router.get('/trades/statuses', TradeController.getStatuses);
router.get('/trades/stats', TradeController.getStats);
router.get('/trades/sim/statuses', TradeController.getStatuses);
router.get('/trades/sim/stats', TradeController.getStats);

router.get('/trades/sim', TradeController.getTrades);
router.get('/trades/sim/:id', TradeController.getTradeById);
router.post('/trades/sim', TradeController.createTrade);
router.put('/trades/sim/:id', TradeController.updateTrade);

router.get('/trades', TradeController.getTrades);
router.get('/trades/:id', TradeController.getTradeById);
router.post('/trades', TradeController.createTrade);
router.put('/trades/:id', TradeController.updateTrade);

export default router;
