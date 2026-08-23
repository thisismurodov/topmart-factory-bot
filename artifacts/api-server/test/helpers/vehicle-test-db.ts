// ─────────────────────────────────────────────────────────────────────────────
// Isolated admin/provisioning URL for the vehicle-distribution test harnesses.
//
// SECURITY / ISOLATION CONTRACT
// -----------------------------
// These harnesses CREATE and DROP databases and swap the app's runtime
// DATABASE_URL / RAILWAY_DATABASE_URL to a throwaway child DB. To guarantee
// they can NEVER accidentally provision against, or drop a database on, the
// live/runtime cluster, the admin connection is taken EXCLUSIVELY from a
// dedicated variable:
//
//     VEHICLE_TEST_DATABASE_ADMIN_URL
//
// There is deliberately NO fallback to RAILWAY_DATABASE_URL or DATABASE_URL for
// the admin/provisioning connection. If the variable is absent the harness
// fails closed at module load. The only URLs derived from this admin URL are
// per-test CHILD databases (same host/credentials, different db name); the app
// runtime URLs, when set during a test, are ALWAYS such a derived child URL —
// never an inherited runtime value.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the isolated admin/provisioning URL. Fails closed (throws) when
 * VEHICLE_TEST_DATABASE_ADMIN_URL is not set. Explicitly does NOT consult
 * RAILWAY_DATABASE_URL or DATABASE_URL.
 */
export function requireVehicleTestAdminUrl(): string {
  const url = process.env.VEHICLE_TEST_DATABASE_ADMIN_URL;
  if (!url || url.trim() === "") {
    throw new Error(
      "VEHICLE_TEST_DATABASE_ADMIN_URL must be set to an ISOLATED admin/provisioning " +
        "Postgres URL to run the vehicle-distribution test harnesses. These tests " +
        "create/drop databases and must never use the runtime RAILWAY_DATABASE_URL / " +
        "DATABASE_URL. Point it at a throwaway local cluster, e.g. " +
        "postgresql://postgres@127.0.0.1:<port>/postgres.",
    );
  }
  if (!isLoopback(url)) {
    throw new Error(
      "VEHICLE_TEST_DATABASE_ADMIN_URL must use a local loopback host " +
        "(127.0.0.1, localhost, or ::1)",
    );
  }
  return url;
}

/**
 * Derive a child-database URL (same host/credentials as the admin URL, a
 * different database name). This is the ONLY URL these harnesses are permitted
 * to assign to the app runtime DATABASE_URL / RAILWAY_DATABASE_URL.
 */
export function childDbUrl(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** True when the URL points at a local loopback host (no TLS expected). */
export function isLoopback(url: string): boolean {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  return (
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === ""
  );
}

/**
 * SSL config appropriate for a connection string. Local loopback clusters (the
 * expected isolated target) do not offer TLS, so SSL is disabled there; any
 * non-loopback host uses relaxed verification. Returns `false` or a pg ssl
 * options object.
 */
export function sslFor(url: string): false | { rejectUnauthorized: false } {
  return isLoopback(url) ? false : { rejectUnauthorized: false };
}

/**
 * DB env vars for the distribution-bot child process pointed at a throwaway
 * child DB. The bot enables `sslmode=require` whenever RAILWAY_DATABASE_URL is
 * present, so for a local (loopback) trust cluster we set ONLY DATABASE_URL to
 * keep the bot in non-SSL mode; for a remote isolated cluster we set both so the
 * bot uses TLS. Either way the value is a derived child URL, never a runtime one.
 */
export function botDbEnv(childUrl: string): Record<string, string> {
  if (isLoopback(childUrl)) {
    return { DATABASE_URL: childUrl };
  }
  return { RAILWAY_DATABASE_URL: childUrl, DATABASE_URL: childUrl };
}
