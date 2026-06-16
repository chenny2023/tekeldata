#!/bin/sh
# Entry point: if Cloudflare R2 backup is configured, run the app under litestream
# (continuous replication + restore-on-empty-volume for disaster recovery);
# otherwise start the app directly. No creds → identical behaviour to before.
set -e

: "${DB_PATH:=/app/server/data/wcoin.db}"
: "${BACKUP_R2_PATH:=wcoin-db}"
export BACKUP_R2_PATH

if [ -n "$BACKUP_R2_BUCKET" ] && [ -n "$BACKUP_R2_ACCESS_KEY_ID" ] && [ -n "$BACKUP_R2_SECRET_ACCESS_KEY" ]; then
  echo "[entrypoint] R2 backup ENABLED (bucket=$BACKUP_R2_BUCKET path=$BACKUP_R2_PATH)"
  if [ ! -f "$DB_PATH" ]; then
    echo "[entrypoint] no local DB at $DB_PATH — attempting restore from R2…"
    litestream restore -if-replica-exists -config /app/litestream.yml "$DB_PATH" \
      && echo "[entrypoint] restore complete" \
      || echo "[entrypoint] no replica to restore — starting fresh"
  fi
  exec litestream replicate -config /app/litestream.yml -exec "npm start"
else
  echo "[entrypoint] R2 backup disabled (no creds) — starting app directly"
  exec npm start
fi
