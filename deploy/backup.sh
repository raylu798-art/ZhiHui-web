#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$ROOT"
if [[ "${ZHIHUI_DEPLOY_LOCK_HELD:-0}" != 1 ]]; then
  exec 9>"$ROOT/.deploy.lock"
  flock -n 9 || { echo 'Deployment/backup is already running.' >&2; exit 1; }
fi
[[ -f "$ROOT/.env" && -f "$ROOT/compose.yml" ]] || { echo 'No activated Web configuration.' >&2; exit 1; }
[[ -d "$ROOT/backups" && ! -L "$ROOT/backups" ]] || { echo 'Backup root must be a real directory.' >&2; exit 1; }
BACKUP_ROOT="$(realpath -- "$ROOT/backups")"
[[ "$BACKUP_ROOT" == "$ROOT/backups" ]] || { echo 'Backup directory escapes deployment root.' >&2; exit 1; }
NAME="backup-$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$BACKUP_ROOT/$NAME" ]] || { echo 'Backup destination exists; retry later.' >&2; exit 1; }
# Backend uses SQLite online snapshot + integrity_check and a SHA-256 manifest,
# then copies owned audio assets. Never copy a live sqlite/WAL set with cp/tar.
docker compose --project-directory "$ROOT" --file "$ROOT/compose.yml" --env-file "$ROOT/.env" \
  exec -T app /usr/local/bin/zhihui-web backup --output "/backup/$NAME"
[[ -s "$BACKUP_ROOT/$NAME/manifest.json" ]] || { echo 'Backup manifest missing; retain evidence and investigate.' >&2; exit 1; }
python3 - "$BACKUP_ROOT/$NAME" <<'PY'
import hashlib,json,pathlib,sqlite3,sys
root=pathlib.Path(sys.argv[1]).resolve()
json.loads((root/'manifest.json').read_text())
def inside_backup(path):
    # Path.is_relative_to is unavailable on Alibaba Cloud Linux 3's Python 3.6.
    try:
        path.resolve().relative_to(root)
    except ValueError:
        return False
    return True

databases=list(root.rglob('*.sqlite'))+list(root.rglob('*.db'))
assert databases,'No database snapshots found'
for db in databases:
    assert inside_backup(db)
    with sqlite3.connect(db.as_uri()+'?mode=ro',uri=True) as c:
        assert c.execute('PRAGMA integrity_check').fetchall()==[('ok',)], f'Corrupt backup: {db.name}'
files={}
for p in root.rglob('*'):
    if not p.is_file(): continue
    assert not p.is_symlink() and inside_backup(p)
    h=hashlib.sha256()
    with p.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
    files[str(p.relative_to(root))]=h.hexdigest()
(root/'verified.json').write_text(json.dumps({'integrity':'ok','sha256':files},indent=2)+'\n')
PY
# Keep at least seven full days; only remove verified backup directories inside
# this validated root. Incomplete backups remain for investigation.
while IFS= read -r -d '' obsolete; do
  [[ -f "$obsolete/verified.json" && ! -L "$obsolete" ]] || continue
  [[ "$(realpath -- "$obsolete")" == "$BACKUP_ROOT"/backup-* ]] || exit 1
  rm -rf -- "$obsolete"
done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'backup-*' -mtime +7 -print0)
echo "Verified Web backup: $NAME. Master key is excluded; preserve its separate offline copy."
