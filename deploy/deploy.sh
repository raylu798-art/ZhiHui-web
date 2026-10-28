#!/usr/bin/env bash
# Only operates inside this script's directory. Never accesses license-server.
set -Eeuo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$ROOT"
usage() { echo 'Usage: deploy.sh preflight | stage RELEASE_ID | activate RELEASE_ID | rollback | status'; }
die() { printf '%s\n' "$*" >&2; exit 1; }
for tool in docker python3 curl flock; do command -v "$tool" >/dev/null || die "Missing prerequisite: $tool"; done
exec 9>"$ROOT/.deploy.lock"
flock -n 9 || die 'Another deployment/backup is running.'
ensure_site_config() {
  [[ ! -L "$ROOT/.env.site" ]] || die 'Site configuration must not be a symlink.'
  # Preserve an existing site configuration across stage/activate/rollback.
  if [[ ! -e "$ROOT/.env.site" ]]; then
    (set -o noclobber; : > "$ROOT/.env.site")
  fi
  [[ -f "$ROOT/.env.site" ]] || die 'Site configuration must be a regular file.'
}
release_dir() {
  [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+-web\.[0-9]+$ ]] || die 'Invalid release ID.'
  [[ -d "$ROOT/releases/$1" && ! -L "$ROOT/releases/$1" ]] || die 'Upload a real release directory first.'
  printf '%s/releases/%s\n' "$ROOT" "$1"
}
field() { python3 - "$1" "$2" <<'PY'
import json,sys
with open(sys.argv[1],encoding='utf-8-sig') as f: value=json.load(f)
for key in sys.argv[2].split('.'): value=value[key]
print(value)
PY
}
verify_release() {
  local dir="$1"
  VERIFIED_CONFIG_ID="$(python3 - "$dir" <<'PY'
import hashlib,json,pathlib,re,sys,tarfile
p=pathlib.Path(sys.argv[1]); m=json.loads((p/'release-manifest.json').read_text(encoding='utf-8-sig'))
assert re.fullmatch(r'\d+\.\d+\.\d+',m['productVersion'])
assert isinstance(m['webBuild'],int) and m['webBuild']>0
assert m['releaseId']==f"{m['productVersion']}-web.{m['webBuild']}"==p.name
assert m['image']==f"zhihui-web:{m['releaseId']}"
assert re.fullmatch(r'sha256:[0-9a-f]{64}',m['imageId'])
if 'imageConfigId' in m:
    assert re.fullmatch(r'sha256:[0-9a-f]{64}',m['imageConfigId'])
assert re.fullmatch(r'[0-9a-f]{64}',m['sourceSha256'])
assert m['databaseSchemaVersion']==1, 'Schema migration requires a separately reviewed migration/restore procedure'
assert m['imageArchive']=='image.tar'
assert re.fullmatch(r'[0-9a-f]{64}',m['desktop']['sha256'])
h=hashlib.sha256()
with (p/'image.tar').open('rb') as f:
    for block in iter(lambda:f.read(8*1024*1024),b''): h.update(block)
assert h.hexdigest()==m['imageSha256'], 'Image archive hash mismatch'
assert (p/'compose.yml').is_file()
with tarfile.open(str(p/'image.tar'),mode='r:') as archive:
    def read_json_member(name):
        path=pathlib.PurePosixPath(name)
        assert name and not path.is_absolute() and str(path)==name and '..' not in path.parts and '\\' not in name and not re.search(r'[:\x00-\x1f\x7f]',name), 'Unsafe archive member path'
        members=[entry for entry in archive.getmembers() if str(pathlib.PurePosixPath(entry.name))==name]
        assert len(members)==1 and members[0].name==name, 'Missing or duplicate archive member'
        member=members[0]
        assert member.isfile() and 0 < member.size <= 1024*1024, 'Archive JSON member must be a bounded regular file'
        raw=archive.extractfile(member).read()
        return raw,json.loads(raw.decode('utf-8'))
    _,entries=read_json_member('manifest.json')
    assert isinstance(entries,list), 'Invalid Docker archive manifest'
    matching=[entry for entry in entries if isinstance(entry,dict) and isinstance(entry.get('RepoTags'),list) and m['image'] in entry['RepoTags']]
    assert len(matching)==1 and matching[0]['RepoTags'].count(m['image'])==1, 'Image tag is absent or ambiguous in archive'
    config_name=matching[0]['Config']
    assert isinstance(config_name,str), 'Invalid config member'
    raw,config=read_json_member(config_name)
    config_id='sha256:'+hashlib.sha256(raw).hexdigest()
    if 'imageConfigId' in m:
        assert config_id==m['imageConfigId'], 'Image config digest mismatch'
    assert config.get('os')=='linux' and config.get('architecture')=='amd64', 'Unexpected image platform'
    labels=config.get('config',{}).get('Labels',{})
    assert labels.get('org.opencontainers.image.revision')==m['sourceSha256'], 'Archived source label mismatch'
    assert labels.get('org.opencontainers.image.version')==m['releaseId'], 'Archived release label mismatch'
print(config_id)
PY
  )"
}
verify_loaded_image() {
  local dir="$1" image
  image="$(field "$dir/release-manifest.json" image)"
  # Engines with a classic image store expose the config digest, while the
  # containerd image store may expose the manifest/index digest from imageId.
  # Both identities are anchored to the verified archive; never hash inspect JSON.
  docker image inspect "$image" | python3 -c '
import json,sys
images=json.load(sys.stdin)
assert isinstance(images,list) and len(images)==1, "Expected one loaded image"
image=images[0]
assert image["Id"] in (sys.argv[1],sys.argv[2]), "Loaded image ID mismatch"
assert image.get("Os")=="linux" and image.get("Architecture")=="amd64", "Loaded platform mismatch"
labels=image.get("Config",{}).get("Labels",{})
assert labels.get("org.opencontainers.image.revision")==sys.argv[3], "Loaded source label mismatch"
assert labels.get("org.opencontainers.image.version")==sys.argv[4], "Loaded release label mismatch"
' "$VERIFIED_CONFIG_ID" "$(field "$dir/release-manifest.json" imageId)" "$(field "$dir/release-manifest.json" sourceSha256)" "$(field "$dir/release-manifest.json" releaseId)"
}
wait_health() {
  local port="$1" version="$2" build="$3" body
  for _ in $(seq 1 30); do
    if body="$(curl --fail --silent --max-time 2 "http://127.0.0.1:$port/api/v1/health")"; then
      if printf '%s' "$body" | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["ok"] is True and r["version"]==sys.argv[1] and str(r["build"])==sys.argv[2]' "$version" "$build" 2>/dev/null; then return 0; fi
    fi
    sleep 2
  done
  return 1
}
smoke() {
  local port="$1" code
  # Consume the complete body: grep -q can close early and make curl fail with
  # SIGPIPE under pipefail on larger exported pages.
  curl --fail --silent --max-time 5 "http://127.0.0.1:$port/" | grep -i '<html' >/dev/null || return 1
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "http://127.0.0.1:$port/api/v1/meetings")"
  [[ "$code" == 401 ]] || return 1
}
write_env() {
  local dir="$1" tmp="$ROOT/.env.next"
  ensure_site_config
  printf 'ZHIHUI_IMAGE=%s\nZHIHUI_BUILD=%s\n' "$(field "$dir/release-manifest.json" image)" "$(field "$dir/release-manifest.json" webBuild)" > "$tmp"
  mv -- "$tmp" "$ROOT/.env"
  cp -- "$dir/compose.yml" "$ROOT/compose.yml"
}
compose() { docker compose --project-directory "$ROOT" --file "$ROOT/compose.yml" --env-file "$ROOT/.env" "$@"; }
set_current() { printf '%s\n' "$1" > "$ROOT/.current.next"; mv -- "$ROOT/.current.next" "$ROOT/current"; }
restore_release() {
  local id="$1" dir
  dir="$(release_dir "$id")"
  verify_release "$dir" || return 1
  verify_loaded_image "$dir" || return 1
  write_env "$dir"
  compose up -d --no-build --pull never --force-recreate
  wait_health 8810 "$(field "$dir/release-manifest.json" productVersion)" "$(field "$dir/release-manifest.json" webBuild)" && smoke 8810
}
case "${1:-}" in
  preflight)
    ensure_site_config
    docker info >/dev/null
    docker compose version
    python3 --version
    free -m
    df -h "$ROOT"
    echo 'Require >= 1.3 GiB available RAM and >= 5 GiB free disk before first start.'
    echo 'Verify DNS, ICP, TLS and existing license health separately; this command changes none of them.'
    ;;
  stage)
    ensure_site_config
    id="${2:-}"; dir="$(release_dir "$id")"
    verify_release "$dir"
    [[ -s "$ROOT/secrets/master_key" ]] || die 'Initialize a master key before staging; see DEPLOY.md.'
    docker load --input "$dir/image.tar" >/dev/null
    image="$(field "$dir/release-manifest.json" image)"
    verify_loaded_image "$dir"
    [[ ! -e "$ROOT/staging/$id" ]] || die 'Staging directory exists; use a fresh build ID or inspect/remove it manually.'
    mkdir -p -- "$ROOT/staging/$id"; chown 10001:10001 "$ROOT/staging/$id"
    candidate="zhihui-web-stage-${id//./-}"
    cleanup() { docker rm -f "$candidate" >/dev/null 2>&1 || true; }
    trap cleanup EXIT
    docker run -d --name "$candidate" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
      --memory 1g --memory-swap 1g --cpus 1.5 --pids-limit 128 --tmpfs /tmp:rw,size=128m \
      --publish 127.0.0.1:18810:8810 --mount "type=bind,src=$ROOT/staging/$id,dst=/var/lib/zhihui-web" \
      --mount "type=bind,src=$ROOT/secrets/master_key,dst=/run/secrets/master_key,readonly" \
      --env "ZHIHUI_BUILD=$(field "$dir/release-manifest.json" webBuild)" \
      --env-file "$ROOT/.env.site" \
      --env ZHIHUI_PUBLIC_URL=https://zhihui.helms.wiki "$image" >/dev/null
    wait_health 18810 "$(field "$dir/release-manifest.json" productVersion)" "$(field "$dir/release-manifest.json" webBuild)" || die 'Candidate health failed.'
    smoke 18810 || die 'Candidate smoke checks failed.'
    sha256sum "$dir/release-manifest.json" > "$dir/.staged"
    echo "Staged $id using isolated empty data; production data was not mounted."
    ;;
  activate)
    id="${2:-}"; dir="$(release_dir "$id")"; verify_release "$dir"
    [[ -f "$dir/.staged" ]] || die 'Stage candidate first.'
    sha256sum --check --status "$dir/.staged" || die 'Manifest changed after staging.'
    previous=''
    if [[ -f "$ROOT/current" ]]; then
      previous="$(cat "$ROOT/current")"
      [[ "$previous" != "$id" ]] || die 'Release is already active.'
      olddir="$(release_dir "$previous")"
      [[ "$(field "$olddir/release-manifest.json" databaseSchemaVersion)" == "$(field "$dir/release-manifest.json" databaseSchemaVersion)" ]] || die 'Incompatible database schema; explicit migration procedure required.'
      # Online SQLite backup; no cp of a running WAL database.
      ZHIHUI_DEPLOY_LOCK_HELD=1 "$ROOT/backup.sh"
    fi
    [[ ! -L "$ROOT/data" && ! -L "$ROOT/backups" ]] || die 'Data and backup directories must not be symlinks.'
    mkdir -p "$ROOT/data" "$ROOT/backups"; chown 10001:10001 "$ROOT/data" "$ROOT/backups"
    if ! restore_release "$id"; then
      if [[ -n "$previous" ]]; then
        restore_release "$previous" || die "Candidate failed AND automatic Web rollback failed. Inspect containers; verified backups remain in $ROOT/backups."
      else
        compose stop || true
      fi
      die 'Candidate activation failed; previous Web restored (or first-start container stopped).'
    fi
    if [[ -n "$previous" ]]; then printf '%s\n' "$previous" > "$ROOT/previous"; fi
    set_current "$id"
    echo "Activated $id. Verify HTTPS/browser/cloud flow. Desktop update files were untouched."
    ;;
  rollback)
    [[ -f "$ROOT/current" ]] || die 'No active Web release recorded.'
    if [[ ! -f "$ROOT/previous" ]]; then
      ZHIHUI_DEPLOY_LOCK_HELD=1 "$ROOT/backup.sh"
      compose stop
      mv -- "$ROOT/current" "$ROOT/first-release-stopped"
      echo 'First Web release stopped; data preserved. No prior Web release exists.'
      exit 0
    fi
    old="$(cat "$ROOT/current")"; target="$(cat "$ROOT/previous")"
    ZHIHUI_DEPLOY_LOCK_HELD=1 "$ROOT/backup.sh"
    restore_release "$target" || die 'Web rollback failed; preserve data and inspect logs.'
    set_current "$target"; printf '%s\n' "$old" > "$ROOT/previous"
    echo "Rolled Web back to $target; no database replacement or desktop updater change."
    ;;
  status)
    if [[ -f "$ROOT/current" ]]; then cat "$ROOT/current"; compose ps; else echo 'Web not activated.'; fi
    ;;
  *) usage; exit 2 ;;
esac
