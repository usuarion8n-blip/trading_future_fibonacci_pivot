import { Router } from 'express';
import { PivotController } from '../controllers/pivotController.js';

const router = Router();

router.get('/pivots/recent', PivotController.getRecentPivots);

export default router;
