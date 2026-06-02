import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import dashboardRouter from "./dashboard";
import batchesRouter from "./batches";
import workersRouter from "./workers";
import productsRouter from "./products";
import salaryRouter from "./salary";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(dashboardRouter);
router.use(batchesRouter);
router.use(workersRouter);
router.use(productsRouter);
router.use(salaryRouter);

export default router;
