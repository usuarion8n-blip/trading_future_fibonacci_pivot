#!/bin/sh
set -e

: "${CRON_SCHEDULE:=5 0 * * *}"
: "${CRON_COMMAND:=node src/index.js}"

echo "CRON_SCHEDULE=$CRON_SCHEDULE"
echo "CRON_COMMAND=$CRON_COMMAND"
echo "DATE_NOW=$(date -Iseconds)"

# IMPORTANTE: newline al final
# Enviar salida del job a stdout/stderr del contenedor (docker logs)
printf '%s cd /app && %s >> /proc/1/fd/1 2>> /proc/1/fd/2\n' \
  "$CRON_SCHEDULE" "$CRON_COMMAND" > /etc/crontabs/trader

echo "==== /etc/crontabs/trader ===="
cat /etc/crontabs/trader
echo "=============================="

# Arranca crond en foreground, con logs a stdout
exec crond -f -l 8 -L /dev/stdout