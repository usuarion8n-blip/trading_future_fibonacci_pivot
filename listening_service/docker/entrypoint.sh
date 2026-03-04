#!/bin/sh
set -e

# ✅ Recomendado: correr cuando el día anterior ya “cerró”
# Por defecto: 00:05 UTC
: "${CRON_SCHEDULE:=5 0 * * *}"
: "${CRON_COMMAND:=node src/index.js}"

echo "CRON_SCHEDULE=$CRON_SCHEDULE"
echo "CRON_COMMAND=$CRON_COMMAND"

# Log directo a docker logs
printf '%s cd /app && %s >> /proc/1/fd/1 2>> /proc/1/fd/2\n' \
  "$CRON_SCHEDULE" "$CRON_COMMAND" > /etc/crontabs/trader

exec crond -f -l 8 -L /dev/stdout -u trader