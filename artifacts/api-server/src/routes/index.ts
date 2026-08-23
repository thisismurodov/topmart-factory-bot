import { Router, type IRouter } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireAuthOrInternalKey } from "../middleware/requireAuthOrInternalKey";
import healthRouter from "./health";
import authRouter from "./auth";
import aiRouter from "./ai";
import dashboardRouter from "./dashboard";
import batchesRouter from "./batches";
import productionLabelsRouter from "./production-labels";
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
import distributionRouter, { distributionSuggestionsRouter } from "./distribution";
import fieldRouter from "./field";
import vehicleDistributionRouter from "./vehicle-distribution";
import vehicleHandoffRouter from "./vehicle-distribution/handoff-router";
import vehicleReplenishmentRouter from "./vehicle-distribution/replenishment-router";

const router: IRouter = Router();

// ── Public routes (no auth required) ─────────────────────────────────────────
router.use(healthRouter);
router.use(authRouter);

// ── Field Assistant (delivery agent Mini App) — Telegram initData auth ────────
// O'z autentifikatsiyasi bor (X-Telegram-Init-Data), shuning uchun BARCHA auth
// wall'lardan (requireAuthOrInternalKey ham path'siz mount bo'lgani uchun hamma
// so'rovga qo'llanadi) OLDIN mount qilinadi. fieldAuth faqat /field/* yo'llariga
// qo'llanadi.
router.use(fieldRouter);

// ── AI routes — Bearer session (dashboard) OR x-internal-key (bot) ────────────
router.use(requireAuthOrInternalKey, aiRouter);

// ── Ombor routes — Bearer session (dashboard) OR x-internal-key (bot) ─────────
// Bot needs container correction (POST /ombor/adjust); dashboard still uses session.
router.use(requireAuthOrInternalKey, omborRouter);

// ── Savdo tavsiyalari — Bearer session (dashboard) OR x-internal-key (savdo bot)
// Savdo bot agentlarga kun boshida AI tavsiyalarni ko'rsatadi (?ai=1&agentId=...).
router.use(requireAuthOrInternalKey, distributionSuggestionsRouter);

// ── Vehicle handoff (F3) — dedicated auth wall (admin Bearer OR bot key) ──────
// Mounted BEFORE the global requireAuth wall behind its own middleware so the
// warehouse bot can drive the handoff lifecycle with x-vehicle-distribution-bot-key
// while admins use a Bearer session. The actor is always assigned server-side.
router.use(vehicleHandoffRouter);
router.use(vehicleReplenishmentRouter);

// ── Auth wall: everything below requires a valid session ──────────────────────
router.use(requireAuth);

router.use(dashboardRouter);
router.use(batchesRouter);
router.use(productionLabelsRouter);
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
router.use(vehicleDistributionRouter);

export default router;
