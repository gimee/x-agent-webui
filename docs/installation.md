# Install and run

`x-agent-webui` is built locally from the checked-out source. The Compose file does not
reference a prebuilt X-Agent-Webui image or a private Docker socket.

## Requirements

- Linux or macOS with Bash, `curl`, Python 3, Docker Engine, and Docker Compose v2.20+
- Docker daemon access for the current user
- Network access to GitHub during the source download and to package registries during the image build

The installer deliberately does **not** install Docker, change Docker authentication,
upgrade the host, remove existing directories, or delete Docker volumes.

## Curl install

```sh
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/gimee/x-agent-webui/main/install.sh | bash
```

Defaults:

- installation directory: `./x-agent-webui`
- host bind: `127.0.0.1`
- host port: `6060`
- container port: `6060`

Options are passed after `bash`:

```sh
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/gimee/x-agent-webui/main/install.sh | \
  bash -s -- --dir "$HOME/x-agent-webui" --port 6060 --bind 127.0.0.1
```

`--help` performs no network or filesystem operation. `--dir` must be new or empty;
the installer never overwrites a non-empty directory. `--port` is a numeric TCP port
from 1 through 65535. `--bind` is an IPv4 or IPv6 literal. Use loopback unless the
host firewall and HTTPS/reverse proxy are already configured.

The installer downloads `gimee/x-agent-webui` branch `main`, validates the archive
member types and required build files, writes a mode-0600 `.env`, runs
`docker compose config`, then builds with `docker compose build --pull`. It only
starts the service after the source build succeeds:

```text
docker compose up -d --no-build --wait --wait-timeout 180
```

If build or startup fails, the source directory and all existing Docker data remain.
Inspect the error from the installation directory; do not run `down -v` unless you
explicitly intend to remove volumes.

## Manual Compose run

```sh
cp .env.example .env
chmod 600 .env
# Keep X_AGENT_BIND=127.0.0.1 unless remote access is intentional.
docker compose -f compose.yaml --env-file .env config
docker compose -f compose.yaml --env-file .env build --pull
docker compose -f compose.yaml --env-file .env up -d --wait
```

The image is built from `Dockerfile` and the local source. The production recipe
retains the Hermes Agent base layer, Claude Code, Pi, agent-browser/Chrome, the
native-session patch, the memory-lock patch, and the PID1 supervisor. Private
maintenance tools and credentials are not installed.

## Persistent state and authentication

Compose uses four named volumes:

| Volume | Purpose |
| --- | --- |
| `hermes` | Hermes profiles, sessions, skills, memory, and gateway state |
| `webui` | X-Agent-Webui database, auth token, uploads, and application state |
| `claude` | Claude Code configuration and native sessions |
| `pi` | Pi configuration and native sessions |

Authentication remains enabled. `AUTH_DISABLED=0` is explicit in both the image and
Compose environment. The first user is bootstrapped in the local X-Agent-Webui database with
these upstream defaults:

```text
username: admin
password: 123456
```

This bootstrap account is the only initial login path; there is no open registration.
Log in once at the loopback URL, immediately change **both** the username and password,
and only then consider binding beyond loopback. The healthcheck requires
`/api/auth/status` to advertise password login and requires `/api/auth/me` to reject an
unauthenticated request. A non-loopback `--bind` only changes port publishing; it does
not make the deployment safe for the public internet. Configure a firewall and HTTPS/
a reverse proxy before remote access. No model/provider credential is bundled in this
repository.

## Operations

Run from the installation directory:

```sh
docker compose ps
docker compose logs -f webui
docker compose restart webui
docker compose stop
docker compose start
```

Updating is explicit: back up the four volumes, replace the source tree, run
`docker compose build --pull`, and then `docker compose up -d --no-build --wait`.
Do not use `docker compose down -v` for an update; it removes persistent data.
