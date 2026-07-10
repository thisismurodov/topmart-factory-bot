import { Router, type IRouter } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireAuthOrInternalKey } from "../middleware/requireAuthOrInternalKey";
import healthRouter from "./health";
import authRouter from "./auth";
import aiRouter from "./ai";
import dashboardRouter from "./dashboard";
import batchesRouter from "./batches";
import workersRouter from "./workers";
import productsRouter from "./products";
import salaryRouter from "./salary";
import payrollRouter from "./payroll";
import customersRouter from "./customers";
import salesRouter from "./sales";
import inventoryRouter from "./inventory";
import inventoryV2Router from "./inventory-v2";
import warehousesRouter from "./warehouses";
import salesProductsRouter from "./sales-products";
import debtsRouter from "./debts";
import reportsRouter from "./reports";
import exchangeRateRouter from "./exchange-rate";
import rawMaterialsRouter from "./raw-materials";
import productMaterialsRouter from "./product-materials";
import packerProductAssignmentsRouter from "./packer-product-assignments";
import omborRouter from "./ombor";
import auditRouter from "./audit";
import distributionRouter from "./distribution";

const router: IRouter = Router();

// ── Public routes (no auth required) ─────────────────────────────────────────
router.use(healthRouter);
router.use(authRouter);

// ── AI routes — Bearer session (dashboard) OR x-internal-key (bot) ────────────
router.use(requireAuthOrInternalKey, aiRouter);

// ── Ombor routes — Bearer session (dashboard) OR x-internal-key (bot) ─────────
// Bot needs container correction (POST /ombor/adjust); dashboard still uses session.
router.use(requireAuthOrInternalKey, omborRouter);

// ── Auth wall: everything below requires a valid session ──────────────────────
router.use(requireAuth);

router.use(dashboardRouter);
router.use(batchesRouter);
router.use(workersRouter);
router.use(productsRouter);
router.use(salaryRouter);
router.use(payrollRouter);
router.use(customersRouter);
router.use(salesRouter);
router.use(inventoryRouter);
router.use(inventoryV2Router);
router.use(warehousesRouter);
router.use(salesProductsRouter);
router.use(debtsRouter);
router.use(reportsRouter);
router.use(exchangeRateRouter);
router.use(rawMaterialsRouter);
router.use(productMaterialsRouter);
router.use(packerProductAssignmentsRouter);
router.use(auditRouter);
router.use(distributionRouter);

export default router;
