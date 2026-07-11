import { is, SQL } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// check-schema-drift.ts (factory) va check-distribution-drift.ts (distribution)
// uchun umumiy normalizatsiya yordamchilari.

// Drizzle getSQLType() → information_schema.columns.data_type normalizatsiyasi
export function normalizeType(sqlType: string): string {
  const t = sqlType.toLowerCase().replace(/\(.*\)/, "").trim();
  switch (t) {
    case "serial":
    case "int":
    case "int4":
      return "integer";
    case "bigserial":
    case "int8":
      return "bigint";
    case "bool":
      return "boolean";
    case "decimal":
      return "numeric";
    case "timestamptz":
    case "timestamp with time zone":
      return "timestamp with time zone";
    case "timestamp":
      return "timestamp without time zone";
    case "varchar":
    case "character varying":
      return "character varying";
    default:
      return t;
  }
}

export const NUMERIC_TYPES = new Set([
  "integer",
  "bigint",
  "smallint",
  "numeric",
  "double precision",
  "real",
]);

// information_schema.columns.column_default → kanonik shakl.
// Misollar: `'UZS'::text` → `'UZS'`, `0.00` → `0`, `now()` → `now()`,
// `nextval('..._seq'::regclass)` → `nextval`, `true` → `true`.
export function normalizeRuntimeDefault(raw: string | null): string | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (/^nextval\(/i.test(s)) return "nextval";
  // `::type` cast qo'shimchalarini olib tashlash (masalan `'UZS'::character varying`)
  s = s.replace(/::"?[a-z_][a-z0-9_ ]*"?(\(\s*\d+(\s*,\s*\d+)?\s*\))?/gi, "").trim();
  while (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();
  const lower = s.toLowerCase();
  if (lower === "now()" || lower === "current_timestamp") return "now()";
  if (lower === "true") return "true";
  if (lower === "false") return "false";
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return `'${s.slice(1, -1).replace(/''/g, "'")}'`;
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return lower;
}

// Drizzle ustunining default'i → xuddi shu kanonik shakl.
export function normalizeDrizzleDefault(c: Column): string | null {
  const sqlType = c.getSQLType().toLowerCase();
  if (sqlType.startsWith("serial") || sqlType.startsWith("bigserial")) return "nextval";
  if (!c.hasDefault) return null;
  const d = c.default;
  // $defaultFn / $onUpdate — faqat ilova darajasida, DB default emas
  if (d === undefined) return null;
  if (is(d, SQL)) {
    return normalizeRuntimeDefault(new PgDialect().sqlToQuery(d).sql);
  }
  if (typeof d === "boolean") return d ? "true" : "false";
  if (typeof d === "number") return String(d);
  if (typeof d === "string") {
    // Raqamli ustunlarda Drizzle default satr bo'ladi (`.default("0")`)
    if (NUMERIC_TYPES.has(normalizeType(sqlType)) && /^-?\d+(\.\d+)?$/.test(d)) {
      return String(Number(d));
    }
    return `'${d}'`;
  }
  return String(d);
}

export function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}
