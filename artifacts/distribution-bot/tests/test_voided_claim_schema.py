"""Maintenance voids are terminal, not sales/returns. Uses a loopback-only DB."""
import os
import re
from pathlib import Path
import unittest
from urllib.parse import urlparse
import psycopg2


class VoidedClaimSchemaTests(unittest.TestCase):
    def test_both_initializers_accept_voided_and_reject_positive_balance(self):
        url = os.environ["VEHICLE_TEST_DATABASE_ADMIN_URL"]
        self.assertIn(urlparse(url).hostname, ("127.0.0.1", "localhost", "::1"))
        root = Path(__file__).resolve().parents[3]
        paths = [root / "artifacts/distribution-bot/database/connection.py",
                 root / "scripts/src/init-distribution.ts"]
        with psycopg2.connect(url) as conn:
            with conn.cursor() as cur:
                cur.execute("CREATE TEMP TABLE claims(status text, remaining_quantity integer)")
                for path in paths:
                    source = path.read_text()
                    for name in ("vehicle_label_claims_status_check",
                                 "vehicle_label_claims_status_remaining_check"):
                        pattern = (r"ADD CONSTRAINT " + name + r"\s+CHECK\s*(\(.*?\));")
                        expression = re.search(pattern, source, re.S).group(1)
                        cur.execute(f"ALTER TABLE claims DROP CONSTRAINT IF EXISTS {name}")
                        cur.execute(f"ALTER TABLE claims ADD CONSTRAINT {name} CHECK {expression}")
                    cur.execute("INSERT INTO claims VALUES ('voided',0),('sold',0),('loaded',30)")
                    cur.execute("SAVEPOINT invalid")
                    with self.assertRaises(psycopg2.errors.CheckViolation):
                        cur.execute("INSERT INTO claims VALUES ('voided',30)")
                    cur.execute("ROLLBACK TO SAVEPOINT invalid")
                    cur.execute("DELETE FROM claims WHERE status<>'voided'")
                cur.execute("SELECT count(*) FROM claims WHERE status='voided'")
                self.assertEqual(cur.fetchone()[0], 2)
            conn.rollback()


if __name__ == "__main__":
    unittest.main()
