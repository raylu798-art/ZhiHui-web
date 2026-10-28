#!/bin/bash
# macOS ships Bash 3.2; keep this script compatible with it.
set -euo pipefail
umask 077
MAC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
dc() { docker compose --project-name "${ZHIHUI_MAC_PROJECT:-zhihui-macmini}" --file "$MAC_DIR/compose.yml" "$@"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
command -v docker >/dev/null || die 'Install and open Docker Desktop for Mac (Apple silicon) first.'
docker info >/dev/null 2>&1 || die 'Start Docker Desktop, wait until it is ready, then retry.'
docker compose version >/dev/null
case "${1:-start}" in
  start)
    image="${ZHIHUI_MAC_IMAGE:-zhihui-web:0.6.6-web.5-arm64}"
    architecture="${ZHIHUI_MAC_PLATFORM:-linux/arm64}"
    architecture="${architecture#linux/}"
    actual="$(docker image inspect --format '{{.Architecture}}' "$image" 2>/dev/null || true)"
    if [ "$actual" != "$architecture" ]; then dc build app; fi
    dc run --rm --no-deps -T initialize
    dc up -d --no-build --pull never app
    for attempt in $(seq 1 60); do
      if dc exec -T app curl --fail --silent --max-time 2 http://127.0.0.1:8810/api/v1/health >/dev/null 2>&1; then
        printf 'Ready: %s\n' "${ZHIHUI_PUBLIC_URL:-http://127.0.0.1:8810}"
        exit 0
      fi
      sleep 2
    done
    die 'Health check timed out; run: bash web/macmini/manage.sh logs'
    ;;
  admin)
    [ -t 0 ] || die 'Run admin from an interactive Terminal; passwords are read without echo.'
    IFS= read -r -s -p 'Set admin password (at least 12 characters): ' admin_password; printf '\n'
    [ "${#admin_password}" -ge 12 ] || die 'Password must have at least 12 characters.'
    IFS= read -r -s -p 'Repeat password: ' repeated_password; printf '\n'
    [ "$admin_password" = "$repeated_password" ] || die 'Passwords do not match.'
    printf '%s\n' "$admin_password" | dc run --rm --no-deps -T app create-admin --username admin
    unset admin_password repeated_password
    ;;
  stop) dc stop app ;;
  restart) dc restart app ;;
  status) dc ps ;;
  logs) dc logs --tail 80 app ;;
  backup)
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    dc run --rm --no-deps -T app backup --output "/backup/backup-$stamp"
    printf 'Backup stored in Docker backup volume: backup-%s\n' "$stamp"
    printf 'Copy it outside Docker with: docker compose -p %s -f "%s/compose.yml" cp app:/backup/backup-%s ./backup-%s\n' "${ZHIHUI_MAC_PROJECT:-zhihui-macmini}" "$MAC_DIR" "$stamp" "$stamp"
    ;;
  export-key)
    [ "$#" -eq 2 ] || die 'Usage: bash web/macmini/manage.sh export-key /private/location/master_key'
    [ ! -e "$2" ] && [ ! -L "$2" ] || die 'Destination already exists; will not overwrite.'
    (set -C; dc run --rm --no-deps -T --entrypoint cat app /run/secrets/master_key > "$2")
    chmod 600 "$2"
    echo 'Master key exported privately. Keep it separate from data backups.'
    ;;
  *) die 'Usage: manage.sh start | admin | stop | restart | status | logs | backup | export-key FILE' ;;
esac
