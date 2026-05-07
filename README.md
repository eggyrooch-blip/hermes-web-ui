<p align="center">
  <strong>Hermes Web UI</strong>
  <a href="./README_zh.md">中文</a>
</p>

<p align="center">
  A full-featured web dashboard for <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a>.<br/>
  Manage AI chat sessions, monitor usage & costs, configure platform channels,<br/>
  schedule cron jobs, browse skills — all from a clean, responsive web interface.
</p>

<p align="center">
  <code>npm install -g hermes-web-ui && hermes-web-ui start</code>
</p>

<p align="center">
  <img src="https://github.com/EKKOLearnAI/hermes-web-ui/blob/main/packages/client/src/assets/image1.png" alt="Hermes Web UI Demo" width="680"/>
</p>

<p align="center">
  <img src="https://github.com/EKKOLearnAI/hermes-web-ui/blob/main/packages/client/src/assets/image2.png" alt="Hermes Web UI Demo" width="680"/>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hermes-web-ui"><img src="https://img.shields.io/npm/v/hermes-web-ui?style=flat-square&color=blue" alt="npm version"/></a>
  <a href="https://github.com/EKKOLearnAI/hermes-web-ui/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/hermes-web-ui?style=flat-square" alt="license"/></a>
  <a href="https://github.com/EKKOLearnAI/hermes-web-ui/stargazers"><img src="https://img.shields.io/github/stars/EKKOLearnAI/hermes-web-ui?style=flat-square" alt="stars"/></a>
</p>

---

## Features

### AI Chat

- Real-time streaming via SSE with async run support
- Multi-session management — create, rename, delete, switch between sessions
- **Self-built session database** — local SQLite storage with automatic sync from Hermes state.db on first startup
- Session grouping by source (Telegram, Discord, Slack, etc.) with collapsible accordion
- Active session indicator — live sessions pin to top with spinner icon
- Sessions sorted by latest message time
- Markdown rendering with syntax highlighting and code copy
- Tool call detail expansion (arguments / result)
- File upload support
- File download support — download user-uploaded files and agent-generated files across local, Docker, SSH, and Singularity backends
- Session search — Ctrl+K global search across all conversations
- Global model selector — discovers models from `~/.hermes/auth.json` credential pool
- Per-session model display badge and context token usage

### Platform Channels

Unified configuration for **8 platforms** in one page:

| Platform      | Features                                                               |
| ------------- | ---------------------------------------------------------------------- |
| Telegram      | Bot token, mention control, reactions, free-response chats             |
| Discord       | Bot token, mention, auto-thread, reactions, channel allow/ignore lists |
| Slack         | Bot token, mention control, bot message handling                       |
| WhatsApp      | Enable/disable, mention control, mention patterns                      |
| Matrix        | Access token, homeserver, auto-thread, DM mention threads              |
| Feishu (Lark) | App ID / Secret, mention control                                       |
| WeChat        | QR code login (scan in browser, auto-save credentials)                 |
| WeCom         | Bot ID / Secret                                                        |

- Credential management writes to `~/.hermes/.env`
- Channel behavior settings write to `~/.hermes/config.yaml`
- Auto gateway restart on config change
- Per-platform configured/unconfigured status detection

### Usage Analytics

- Total token usage breakdown (input / output)
- Session count with daily average
- Estimated cost tracking & cache hit rate
- Model usage distribution chart
- 30-day daily trend (bar chart + data table)

### Scheduled Jobs

- Create, edit, pause, resume, delete cron jobs
- Trigger immediate execution
- Cron expression quick presets

### Model Management

- Auto-discover models from credential pool (`~/.hermes/auth.json`)
- Fetch available models from each provider endpoint (`/v1/models`)
- Add, update, and delete providers (preset & custom OpenAI-compatible)
- OpenAI Codex & Nous Portal OAuth login
- Provider URL auto-detection for non-v1 API versions (e.g. `/v4`)
- Provider-level model grouping with default model switching

### Multi-Profile & Gateway

- Create, rename, delete, and switch between Hermes profiles
- Clone existing profile or import from archive (`.tar.gz`)
- Export profile for backup or sharing
- Multi-gateway management — start, stop, and monitor gateway per profile
- Auto port conflict resolution
- Profile-scoped configuration and cache isolation

### File Browser

- Browse files on remote backends (local, Docker, SSH, Singularity)
- Upload, download, rename, copy, move, and delete files
- Create directories
- View file content with syntax highlighting

### Group Chat

- Multi-agent chat rooms with real-time messaging via Socket.IO
- @mention routing — mention an agent to trigger a contextual reply
- Context compression — automatic conversation summarization when history exceeds token threshold
- Typing status and reply progress indicators
- Room creation, deletion, and invite code management
- Agent management — add/remove agents from rooms with per-agent profiles
- SQLite message persistence
- Mobile responsive with collapsible sidebar

### Skills & Memory

- Browse and search installed skills
- View skill details and attached files
- User notes and profile management

### Logs

- View agent / gateway / error logs
- Filter by log level, log file, and keyword
- Structured log parsing with HTTP access log highlighting

### Authentication

- Token-based auth (auto-generated on first run or set via `AUTH_TOKEN` env var)
- Optional username/password login — set via settings page after initial token auth
- Auth can be disabled with `AUTH_DISABLED=1`

### Settings

- Display (streaming, compact mode, reasoning, cost display)
- Agent (max turns, timeout, tool enforcement)
- Memory (enable/disable, char limits)
- Session reset (idle timeout, scheduled reset)
- Privacy (PII redaction)
- Model settings (default model & provider)
- API server configuration

### Web Terminal

- Integrated terminal powered by node-pty and @xterm/xterm
- Multi-session support — create, switch between, and close terminal sessions
- Real-time keyboard input and PTY output streaming via WebSocket
- Window resize support

---

## Quick Start

### npm (Recommended)

```bash
npm install -g hermes-web-ui
hermes-web-ui start
```

Open **http://localhost:8648**

### One-line Setup (Auto-detect OS)

Automatically installs Node.js (if missing) and hermes-web-ui on Debian/Ubuntu/macOS:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/EKKOLearnAI/hermes-web-ui/main/scripts/setup.sh)
```

### WSL

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/EKKOLearnAI/hermes-web-ui/main/scripts/setup.sh)
hermes-web-ui start
```

> WSL auto-detects and uses `hermes gateway run` for background startup (no launchd/systemd).

### Docker Compose

Run Web UI together with Hermes Agent:

```bash
# Use pre-built image (Recommended)
WEBUI_IMAGE=ekkoye8888/hermes-web-ui:latest docker compose up -d hermes-agent hermes-webui

# Or build from source
docker compose up -d --build hermes-agent hermes-webui

docker compose logs -f hermes-webui
```

Open **http://localhost:6060**

- Persistent Hermes data is stored in `./hermes_data`
- Web UI auth token is stored in `./hermes_data/hermes-web-ui/.token`
- On first run with auth enabled, the token is printed to container logs
- All runtime settings are environment-variable driven in `docker-compose.yml`

For detailed notes and troubleshooting, see [`docs/docker.md`](./docs/docker.md).

### CLI Commands

| Command                           | Description                        |
| --------------------------------- | ---------------------------------- |
| `hermes-web-ui start`             | Start in background (daemon mode)  |
| `hermes-web-ui start --port 9000` | Start on custom port               |
| `hermes-web-ui stop`              | Stop background process            |
| `hermes-web-ui restart`           | Restart background process         |
| `hermes-web-ui status`            | Check if running                   |
| `hermes-web-ui update`            | Update to latest version & restart |
| `hermes-web-ui -v`                | Show version number                |
| `hermes-web-ui -h`                | Show help message                  |

### Auto Configuration

On startup the BFF server automatically:

- Validates `~/.hermes/config.yaml` and fills missing `api_server` fields
- Backs up original config to `config.yaml.bak` if modified
- Detects and starts the gateway if needed
- Resolves port conflicts (kills stale processes)
- Opens browser on successful startup

---

## Development

```bash
git clone https://github.com/EKKOLearnAI/hermes-web-ui.git
cd hermes-web-ui
npm install
npm run dev
```

- Frontend: http://localhost:5173
- BFF Server: http://localhost:8648 (proxies to Hermes on 8642)

```bash
npm run build   # outputs to dist/
```

## Architecture

```
Browser → BFF (Koa, :8648) → Hermes Gateway (:8642)
                ↓
           Hermes CLI (sessions, logs, version)
                ↓
           ~/.hermes/config.yaml  (channel behavior)
           ~/.hermes/auth.json    (credential pool)
           Tencent iLink API      (WeChat QR login)
```

The frontend is designed with **multi-agent extensibility** — all Hermes-specific code is namespaced under `hermes/` directories (API, components, views, stores), making it straightforward to add new agent integrations alongside.

The BFF layer handles API proxy (with path rewriting), SSE streaming, file upload and download (multi-backend: local/Docker/SSH/Singularity), session CRUD via CLI, config/credential management, WeChat QR login, model discovery, skills/memory management, log reading, and static file serving.

## Operations

`hermes-web-ui` exits with code 1 on any uncaught exception so a process supervisor can restart it into a known-good state. Run it under one of:

- **Docker / docker-compose** — the bundled `docker-compose.yml` already sets `restart: unless-stopped` and a `/health` healthcheck on the `hermes-webui` service. The same `HEALTHCHECK` is baked into the `Dockerfile`, so swarm/k8s deployments get it for free.
- **systemd** — use `Restart=always` plus `RestartSec=2`. Point `StandardOutput`/`StandardError` at the journal; the BFF's own log file already lives at `~/.hermes-web-ui/logs/server.log`.
- **launchd (macOS)** — set `KeepAlive=true` on the LaunchAgent plist.
- **pm2** — `pm2 start dist/server/index.js --name hermes-web-ui --max-memory-restart 1G`.

Health endpoint: `GET /health` returns 200 once the HTTP listener is up. It is registered before the auth middleware so probes don't need a token.

Logs: pino sync destination at `~/.hermes-web-ui/logs/server.log`, auto-rotated at 3 MB. The pino redact configuration strips `Authorization` headers, `?token=` query strings, and any `*.access_token` / `*.refresh_token` / `*.api_key` field from log entries.

Security knobs (default values shown):

- `AUTH_DISABLED=` — leave empty in production. Only `1` / `true` / `yes` / `on` disable auth; `false` / `0` / any other value keeps auth on.
- `HERMES_TERMINAL_ENABLED=` — set to `1` to opt in to the WebSocket terminal. Default is off because anyone reaching the upgrade endpoint with a valid auth context gets an interactive shell with the BFF process's privileges.
- `CORS_ORIGINS=` — empty defaults to same-origin. Set to a comma-separated allowlist (`https://app.example.com,https://admin.example.com`) or `*` (legacy, opt-in) to relax.
- `HERMES_UPSTREAM_HOSTS=` — comma-separated extension to the proxy host allowlist. The default `127.0.0.1`, `::1`, `localhost` is enough for the bundled docker-compose setup.

## Localization

8 locales live under `packages/client/src/i18n/locales/`: `en`, `zh`, `de`, `es`, `fr`, `ja`, `ko`, `pt`. Run `npm run i18n:check` to compare every locale's leaf-key set against `en.ts` (the reference) and exit non-zero on divergence. Wire it into your CI once the existing baseline drift is reconciled — the script ships immediately so contributors can verify their patches do not introduce new divergence.

## Tech Stack

**Frontend:** Vue 3 + TypeScript + Vite + Naive UI + Pinia + Vue Router + vue-i18n + SCSS + markdown-it + highlight.js

**Backend:** Koa 2 (BFF server) + node-pty (web terminal)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=EKKOLearnAI/hermes-web-ui&type=Date)](https://star-history.com/#EKKOLearnAI/hermes-web-ui&Date)

<!-- If the chart above doesn't load, visit https://star-history.com/#EKKOLearnAI/hermes-web-ui -->

## Sponsor

如果你觉得这个项目对你有帮助，欢迎支持我：

<a href="https://ifdian.net/a/ekko8888"><img src="https://img.shields.io/badge/Sponsor-%E7%88%B1%E5%8F%91%E7%94%B5-orange?style=flat-square" alt="Sponsor"/></a>

## License

[MIT](./LICENSE)
