#!/usr/bin/env bash
# Install the public source archive; never install Docker or remove user data.
set -euo pipefail

usage() {
    printf '%s\n' \
        'Usage: bash install.sh [--dir PATH] [--port PORT] [--bind IP] [--help]' \
        '' \
        '  --dir PATH   New or empty installation directory (default: ./x-agent-webui)' \
        '  --port PORT  Host HTTP port, 1-65535 (default: 6060)' \
        '  --bind IP    Host IPv4/IPv6 address (default: 127.0.0.1)' \
        '  --help       Show help without downloading or starting anything' \
        '' \
        'Requires Bash, curl, Python 3, Docker Engine and Docker Compose v2.' \
        'Downloads gimee/x-agent-webui main and builds locally with Compose.' \
        'No prebuilt X-Agent-Webui image, Docker installation, upgrades or data deletion.'
}

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Defer all work until the complete piped script has been parsed.
main() {
install_dir=./x-agent-webui
port=6060
bind=127.0.0.1
while (($#)); do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --dir|--port|--bind)
            (($# >= 2)) && [[ -n $2 && $2 != --* ]] || die "$1 requires a value"
            case "$1" in
                --dir) install_dir=$2 ;;
                --port) port=$2 ;;
                --bind) bind=$2 ;;
            esac
            shift 2 ;;
        *) die "Unknown argument: $1 (see --help)" ;;
    esac
done

for command in curl python3 docker mktemp mkdir rm; do
    command -v "$command" >/dev/null 2>&1 || die "Missing dependency: $command. Install prerequisites yourself; this script never installs Docker."
done
# Validate before network calls or filesystem changes. Never evaluate user input.
python3 - "$port" "$bind" "$install_dir" <<'PY'
import ipaddress, re, sys
port, bind, directory = sys.argv[1:]
if not re.fullmatch(r'[1-9][0-9]{0,4}', port) or not 1 <= int(port) <= 65535:
    sys.exit('Error: --port must be an integer from 1 to 65535 (no leading zeros)')
try:
    ipaddress.ip_address(bind)
    if '%' in bind:
        raise ValueError('zone identifier not supported')
except ValueError:
    sys.exit('Error: --bind must be an IPv4 or IPv6 literal without a zone identifier')
if not directory or any(ord(c) < 32 or ord(c) == 127 for c in directory):
    sys.exit('Error: --dir must be a non-empty path without control characters')
PY
install_dir=$(python3 - "$install_dir" <<'PY'
from pathlib import Path
import os, sys
p = Path(os.path.abspath(sys.argv[1]))
if p.is_symlink() or (p.exists() and (not p.is_dir() or any(p.iterdir()))):
    sys.exit('Error: refusing to overwrite a non-empty directory, file or symlink: ' + str(p))
print(p)
PY
)
compose_version=$(docker compose version --short 2>/dev/null) || die 'Docker Compose v2 is required (docker compose).'
python3 - "$compose_version" <<'PY'
import re, sys
m = re.match(r'^v?(\d+)\.(\d+)\.(\d+)', sys.argv[1].strip())
if not m or tuple(map(int, m.groups())) < (2, 20, 0):
    sys.exit('Error: Docker Compose v2.20.0 or newer is required for health-wait support')
PY
server_version=$(docker info --format '{{.ServerVersion}}' 2>/dev/null) || die 'Cannot contact the Docker daemon. Start Docker and check your access.'
# Some Docker clients return rc=0 with an empty value when the daemon is absent.
[[ $server_version =~ ^[0-9]+\.[0-9]+ ]] || die 'Docker daemon returned no valid server version. Start Docker and check your access.'

if [[ $bind != 127.0.0.1 && $bind != ::1 ]]; then
    printf 'WARNING: --bind %s publishes the login page beyond loopback. Authentication is enabled but the initial credentials are the public defaults; this is not a secure public deployment by itself. Configure firewall and HTTPS, then change the username and password before allowing remote access.\n' "$bind" >&2
fi
umask 077
staging=$(mktemp -d "${TMPDIR:-/tmp}/x-agent-install.XXXXXXXX")
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
archive_url=https://github.com/gimee/x-agent-webui/archive/refs/heads/main.tar.gz
printf 'Downloading source from %s\n' "$archive_url"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 20 --max-time 600 --retry 3 --output "$staging/source.tar.gz" "$archive_url"

# Treat archive names as data: no traversal, links, devices or overwrite of local state.
# Only this private staging directory is cleaned up; installed files/volumes are never deleted.
python3 - "$staging/source.tar.gz" "$install_dir" <<'PY'
from pathlib import Path, PurePosixPath
import hashlib, os, shutil, sys, tarfile
archive, target = Path(sys.argv[1]), Path(sys.argv[2])
with tarfile.open(archive, 'r:gz') as source:
    entries = source.getmembers()
    files = {}
    for member in entries:
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'x-agent-webui-main':
            sys.exit('Error: unsafe or unexpected archive path')
        if not (member.isfile() or member.isdir()):
            sys.exit('Error: archive links and special files are not accepted')
        relative = Path(*path.parts[1:])
        if member.isfile():
            if relative == Path('.') or relative in files:
                sys.exit('Error: duplicate or invalid archive member')
            files[relative] = member
    required = {'Dockerfile', 'compose.yaml', '.env.example', 'package.json', 'package-lock.json'}
    if not required.issubset({str(p) for p in files}):
        sys.exit('Error: archive is missing required source/build files')
    if any(p.parts[0] in {'.env', '.git'} for p in files):
        sys.exit('Error: source archive contains local configuration')
    # Recheck after downloading, so a concurrent local write is not overwritten.
    if target.is_symlink() or (target.exists() and (not target.is_dir() or any(target.iterdir()))):
        sys.exit('Error: installation directory changed or is not empty; refusing overwrite')
    target.mkdir(parents=True, exist_ok=True)
    for relative, member in files.items():
        out = target / relative
        out.parent.mkdir(parents=True, exist_ok=True)
        with source.extractfile(member) as src, out.open('xb') as dst:
            shutil.copyfileobj(src, dst)
        out.chmod(member.mode & 0o777)
project = 'x-agent-' + hashlib.sha256(str(target.resolve()).encode()).hexdigest()[:12]
print('Source extracted to ' + str(target))
(target / '.env').write_text('COMPOSE_PROJECT_NAME=' + project + '\n', encoding='utf-8')
(target / '.env').chmod(0o600)
PY
printf 'X_AGENT_PORT=%s\nX_AGENT_BIND=%s\n' "$port" "$bind" >> "$install_dir/.env"
# The dedicated env file and explicit compose file keep unrelated shell defaults out.
unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_PROJECT_NAME X_AGENT_PORT X_AGENT_BIND
compose=(docker compose --project-directory "$install_dir" --env-file "$install_dir/.env" -f "$install_dir/compose.yaml")
"${compose[@]}" config --quiet
if ! "${compose[@]}" build --pull; then
    die "Source build failed. Files and data were kept in $install_dir; fix the error and run docker compose build there."
fi
if ! "${compose[@]}" up -d --no-build --wait --wait-timeout 180; then
    die "Startup/health verification failed. Files and volumes were kept. Run docker compose logs in $install_dir."
fi
url_host=$bind
[[ $bind != *:* ]] || url_host="[$bind]"
printf '\nInstallation started and Compose health checks passed.\nURL: http://%s:%s\nDirectory: %s\n' "$url_host" "$port" "$install_dir"
printf 'Complete the login and model/provider setup in X-Agent-Webui. No model credentials are bundled.\n'
printf 'Manage it from that directory with: docker compose ps | logs | stop | start\n'
}

main "$@"
