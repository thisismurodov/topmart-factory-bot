#!/usr/bin/env bash
# =============================================================================
# TOPMART HARD RESET — REAL IJRO (PROD!)
# FAQAT owner «RESET GO» bergandan keyin ishga tushiriladi.
# Himoya: CONFIRM_RESET_GO=YES muhit o'zgaruvchisi talab qilinadi.
# Bosqichlar: yangi dump → GO skripti (bitta tranzaksiya) → verify.
# =============================================================================
set -euo pipefail

if [ "${CONFIRM_RESET_GO:-}" != "YES" ]; then
  echo "RAD ETILDI: CONFIRM_RESET_GO=YES o'rnatilmagan."
  echo "Bu skript faqat owner aniq «RESET GO» bergandan keyin ishga tushiriladi:"
  echo "  CONFIRM_RESET_GO=YES bash scripts/hard-reset/run-reset-go.sh"
  exit 1
fi

PG18=/nix/store/vwph78y8l4q6fndzmd9yqgc4rln6583g-postgresql-18.6/bin
TS=$(date +%Y%m%d_%H%M%S)
mkdir -p backups/pre-reset

DUMP="backups/pre-reset/topmart_pre_reset_GO_${TS}.dump"
echo "=== PHASE 0: yangi to'liq dump → ${DUMP} ==="
"$PG18/pg_dump" -Fc -f "$DUMP" "$RAILWAY_DATABASE_URL"
TOC=$("$PG18/pg_restore" --list "$DUMP" | grep -cE 'TABLE DATA')
echo "Dump tayyor: $(ls -lh "$DUMP" | awk '{print $5}'), TABLE DATA=${TOC}"
[ "$TOC" -ge 60 ] || { echo "XATO: dump chala ko'rinadi (TABLE DATA=${TOC})"; exit 1; }

echo ""
echo "=== GO SKRIPTI (PROD, bitta tranzaksiya) ==="
psql "$RAILWAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/hard-reset/reset-go.sql

echo ""
echo "=== VERIFY (PROD) ==="
psql "$RAILWAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/hard-reset/verify.sql

echo ""
echo "=== HARD RESET YAKUNLANDI. Rollback nuqtasi: ${DUMP} ==="
