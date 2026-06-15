import { Router, type IRouter } from "express";
import { requireAuth } from "../middleware/requireAuth";
import healthRouter from "./health";
import authRouter from "./auth";
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

export default router;
