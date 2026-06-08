import { Router, type IRouter } from "express";
import { requireAuth } from "../middleware/requireAuth";
import healthRouter from "./health";
import authRouter from "./auth";
import dashboardRouter from "./dashboard";
import batchesRouter from "./batches";
import workersRouter from "./workers";
import productsRouter from "./products";
import salaryRouter from "./salary";
import customersRouter from "./customers";
import salesRouter from "./sales";
import inventoryRouter from "./inventory";
import inventoryV2Router from "./inventory-v2";
import warehousesRouter from "./warehouses";
import salesProductsRouter from "./sales-products";
import debtsRouter from "./debts";

const router: IRouter = Router();

// ── Public routes (no auth required) ─────────────────────────────────────────
router.use(healthRouter);
router.use(authRouter);

// ── Auth wall: everything below requires a valid session ──────────────────────
router.use(requireAuth);

router.use(dashboardRouter);
router.use(batchesRouter);
router.use(workersRouter);
router.use(productsRouter);
router.use(salaryRouter);
router.use(customersRouter);
router.use(salesRouter);
router.use(inventoryRouter);
router.use(inventoryV2Router);
router.use(warehousesRouter);
router.use(salesProductsRouter);
router.use(debtsRouter);

export default router;
