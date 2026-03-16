import { Router } from 'express';
import { TradeController } from '../controllers/tradeController.js';

const router = Router();

router.get('/trades', TradeController.getTrades);

export default router;
