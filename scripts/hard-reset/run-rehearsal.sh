#!/usr/bin/env bash
# =============================================================================
# TOPMART HARD RESET — KLONDA REPETITSIYA
# Prod dump'ini vaqtinchalik klon bazaga tiklaydi, GO skriptini KLONDA to'liq
# ishga tushiradi, natijani tekshiradi va klonni o'chiradi.
# PROD OPERATSION JADVALLARIGA HECH QANDAY YOZUV QILMAYDI.
# Ishlatish: bash scripts/hard-reset/run-rehearsal.sh <dump-fayl>
# =============================================================================
set -euo pipefail

PG18=/nix/store/vwph78y8l4q6fndzmd9yqgc4rln6583g-postgresql-18.6/bin
DUMP="${1:?dump fayl yoli kerak}"
[ -f "$DUMP" ] || { echo "XATO: dump topilmadi: $DUMP"; exit 1; }

BASE="${RAILWAY_DATABASE_URL%%\?*}"
QS="${RAILWAY_DATABASE_URL:${#BASE}}"
REHDB="reset_rehearsal_$(date +%s)_$$"
REH_URL="${BASE%/*}/${REHDB}${QS}"

cleanup() {
  psql "$RAILWAY_DATABASE_URL" -qc "DROP DATABASE IF EXISTS ${REHDB} WITH (FORCE);" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

echo "=== REPETITSIYA: klon baza ${REHDB} yaratilmoqda ==="
psql "$RAILWAY_DATABASE_URL" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE ${REHDB};"

echo "=== Dump klonga tiklanmoqda ==="
"$PG18/pg_restore" --no-owner --no-acl -j 8 -d "$REH_URL" "$DUMP" 2>/tmp/rehearsal_restore_err.log \
  || { echo "RESTORE OGOHLANTIRISHLARI (oxirgi 20 qator):"; tail -20 /tmp/rehearsal_restore_err.log; }

echo "=== Klon sanity: asosiy jadvallar ==="
psql "$REH_URL" -tA -F' | ' -c "SELECT 'KLON', (SELECT count(*) FROM stock_movements), (SELECT count(*) FROM batches), (SELECT count(*) FROM wip_movements), (SELECT count(*) FROM inventory), (SELECT count(*) FROM sales), (SELECT count(*) FROM distribution.savdolar);"

echo ""
echo "=== GO SKRIPTI (KLONDA!) ==="
psql "$REH_URL" -v ON_ERROR_STOP=1 -f scripts/hard-reset/reset-go.sql

echo ""
echo "=== VERIFY (KLONDA) ==="
psql "$REH_URL" -v ON_ERROR_STOP=1 -f scripts/hard-reset/verify.sql

echo ""
echo "=== REPETITSIYA YAKUNLANDI — klon o'chirilmoqda ==="
