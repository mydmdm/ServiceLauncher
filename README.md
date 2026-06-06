# AppLauncher

Lightweight local process/service launcher for development projects. Manages build & launch
lifecycle, auto-restart, and logging — no pm2 required.

## Example Services

| Name | CWD | Build | Launch |
|------|-----|-------|--------|
| `service-a` | `/path/to/project-a` | `pnpm build` | `pnpm start` |
| `service-b` | `/path/to/project-b` | — | `python -m http.server 9000` |

## Commands

```powershell
# Initialize local runtime config template (first-time setup)
pnpm run init
pnpm run init -- --force   # overwrite existing template

# Validate config (ports, refs, deps, cycles)
pnpm run validate

# Start all services (build → launch)
pnpm start
pnpm start -- service-a      # single service

# Stop
pnpm stop
pnpm stop -- service-a

# Restart (stop → build → launch)
pnpm restart
pnpm restart -- service-a

# Status table
pnpm run status

# Tail logs
pnpm run logs -- service-a
pnpm run logs -- service-a --error   # error log
pnpm run logs -- service-a -f        # follow mode
```

Or call the launcher directly:

```powershell
node bin/launcher.mjs init|validate|start|stop|restart|status|logs [name]
```

## Recommended First Run

1. Run `pnpm run init` (or `node bin/launcher.mjs init`) once.
2. Edit `.runtime/services.yaml` with your local services.
3. Run `pnpm run validate`.
4. Run `pnpm start`.

## Configuration

Use `init` to create `.runtime/services.yaml` if it does not exist, then edit it:

```yaml
ports:
  app: 3000
  api: 8080

services:
  - name: service-a
    cwd: /path/to/project-a
    deps: []
    build:                    # optional — runs before each launch
      command: pnpm
      args: [build]
      cwd: /path/to/project-a/build-tools   # optional override
    launch:                   # required — long-running process
      command: pnpm
      args: [start, --port, ${ports.app}]
      cwd: /path/to/project-a               # optional override
    env:
      API_BASE_URL: http://127.0.0.1:${ports.api}
      NODE_ENV: development
    maxRestarts: 10           # max consecutive restart attempts
    restartDelay: 3000        # ms between restarts
    autorestart: true

  - name: service-b
    cwd: /path/to/project-b
    deps: [service-a]
    launch:
      command: python
      args: [-m, http.server, ${ports.api}]
```

### Dependency Behavior

1. Start order follows dependencies (topological order).
2. `start <name>` also starts required dependencies of that service.
3. `stop <name>` also stops dependent services first.
4. Cyclic dependencies are rejected at load time.

### Port References

Use `${ports.name}` in `args`, `env`, and other string fields.
Unknown references and duplicate port values are rejected at load time.

## How It Works

Each service runs in its own **wrapper process** (`lib/wrapper.mjs`):
1. Runs `build` command to completion (if configured)
2. Spawns `launch` command as a long-running child
3. Logs stdout/stderr to `logs/<name>-out.log` and `logs/<name>-error.log`
4. Auto-restarts on crash (build → launch again) up to `maxRestarts` times
5. Restart counter resets after 60s of stable uptime

Runtime state is stored in `.runtime/` (PID files, status JSON).
Stop is graceful (control-file signal → 5s timeout → force kill).
