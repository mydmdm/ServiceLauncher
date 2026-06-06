#!/usr/bin/env node

// AppLauncher CLI
// A lightweight local service manager for Windows.
//
// Usage:
//   node bin/launcher.mjs init              Initialize .runtime/services.yaml template
//   node bin/launcher.mjs validate          Validate config and dependency graph
//   node bin/launcher.mjs start   [name]   Start one or all services
//   node bin/launcher.mjs stop    [name]   Stop one or all services
//   node bin/launcher.mjs restart [name]   Restart one or all services
//   node bin/launcher.mjs status           Show service status table
//   node bin/launcher.mjs logs    <name>   Tail logs for a service
//   node bin/launcher.mjs help             Show this help message

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, root, runtimeDir, logsDir } from '../lib/config.mjs';

const wrapperPath = path.join(root, 'lib', 'wrapper.mjs');

fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });

const INIT_TEMPLATE = `# AppLauncher local runtime config
# This file is intentionally local and should stay out of git.

ports:
  app: 3000
  api: 8080

services:
  - name: service-a
    cwd: /path/to/project-a
    deps: []
    build:                    # optional
      command: pnpm
      args: [build]
      # cwd: /path/to/project-a/build-tools
    launch:                   # required
      command: pnpm
      args: [start, --port, \${ports.app}]
      # cwd: /path/to/project-a
    env:
      NODE_ENV: development
      API_BASE_URL: http://127.0.0.1:\${ports.api}
    maxRestarts: 10
    restartDelay: 3000
    autorestart: true

  - name: service-b
    cwd: /path/to/project-b
    deps: [service-a]
    launch:
      command: python
      args: [-m, http.server, \${ports.api}]
`;

let servicesCache = null;
let graphCache = null;

function getServices() {
  if (servicesCache) return servicesCache;
  try {
    servicesCache = loadConfig();
    return servicesCache;
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

function getGraph() {
  if (graphCache) return graphCache;

  const services = getServices();
  const byName = new Map(services.map((s) => [s.name, s]));
  const dependents = new Map(services.map((s) => [s.name, []]));

  for (const svc of services) {
    for (const dep of svc.deps) {
      if (!byName.has(dep)) {
        console.error(`Unknown dependency "${dep}" referenced by "${svc.name}".`);
        process.exit(1);
      }
      dependents.get(dep).push(svc.name);
    }
  }

  const indegree = new Map(services.map((s) => [s.name, s.deps.length]));
  const queue = services.filter((s) => s.deps.length === 0).map((s) => s.name);
  const topo = [];

  while (queue.length > 0) {
    const name = queue.shift();
    topo.push(name);
    for (const child of dependents.get(name)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }

  if (topo.length !== services.length) {
    console.error('Dependency cycle detected in services config.');
    process.exit(1);
  }

  graphCache = { services, byName, dependents, topo };
  return graphCache;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStatus(name) {
  const file = path.join(runtimeDir, `${name}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function getServiceNames(nameArg) {
  const { byName, topo } = getGraph();

  if (nameArg) {
    if (!byName.has(nameArg)) {
      console.error(`Unknown service: "${nameArg}"`);
      console.error(`Available: ${topo.join(', ')}`);
      process.exit(1);
    }
    return [nameArg];
  }

  return topo;
}

function getStartOrder(nameArg) {
  const { byName, topo } = getGraph();

  if (!nameArg) return [...topo];

  const selected = new Set([nameArg]);
  const stack = [nameArg];
  while (stack.length > 0) {
    const current = stack.pop();
    const svc = byName.get(current);
    for (const dep of svc.deps) {
      if (!selected.has(dep)) {
        selected.add(dep);
        stack.push(dep);
      }
    }
  }

  return topo.filter((name) => selected.has(name));
}

function getStopOrder(nameArg) {
  const { dependents, topo } = getGraph();

  if (!nameArg) return [...topo].reverse();

  const selected = new Set([nameArg]);
  const queue = [nameArg];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dep of dependents.get(current)) {
      if (!selected.has(dep)) {
        selected.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...topo].reverse().filter((name) => selected.has(name));
}

function formatUptime(startedAt) {
  if (!startedAt) return '-';
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms < 0) return '-';
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return `${day}d ${hr % 24}h`;
  if (hr > 0) return `${hr}h ${min % 60}m`;
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad(str, len) {
  return String(str).padEnd(len);
}

// ── Commands ───────────────────────────────────────────────────────────────

function cmdInit(force = false) {
  const configPath = path.join(runtimeDir, 'services.yaml');
  fs.mkdirSync(runtimeDir, { recursive: true });

  if (fs.existsSync(configPath) && !force) {
    console.error(`Config already exists: ${configPath}`);
    console.error('Use "launcher init --force" to overwrite it.');
    process.exit(1);
  }

  fs.writeFileSync(configPath, INIT_TEMPLATE);
  console.log(`Created ${configPath}`);
  console.log('Next: edit services, then run "pnpm start".');
}

function cmdValidate() {
  const { services, topo } = getGraph();
  const ports = services[0]?.ports ?? {};

  console.log('Config OK');
  console.log(`Services: ${services.length}`);
  console.log(`Start order: ${topo.join(' -> ') || '(none)'}`);

  const portEntries = Object.entries(ports);
  if (portEntries.length > 0) {
    console.log(`Ports: ${portEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
}

async function cmdStart(nameArg) {
  const names = getStartOrder(nameArg);

  for (const name of names) {
    const status = readStatus(name);
    if (status && isProcessAlive(status.wrapperPid)) {
      console.log(`  ${name}  already running (PID ${status.wrapperPid})`);
      continue;
    }

    // Clean up stale status file
    const statusFile = path.join(runtimeDir, `${name}.json`);
    try { fs.unlinkSync(statusFile); } catch { /* ignore */ }

    // Redirect wrapper's own stdout/stderr to a wrapper log
    const wrapperLog = path.join(logsDir, `${name}-wrapper.log`);
    const wrapperFd = fs.openSync(wrapperLog, 'a');

    const child = spawn(process.execPath, [wrapperPath, name], {
      detached: true,
      stdio: ['ignore', wrapperFd, wrapperFd],
      cwd: root,
    });
    child.unref();
    fs.closeSync(wrapperFd);

    // Wait briefly for the wrapper to write its status file
    let started = false;
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      const s = readStatus(name);
      if (s && s.wrapperPid && isProcessAlive(s.wrapperPid)) {
        started = true;
        break;
      }
    }

    if (started) {
      const s = readStatus(name);
      console.log(`  ${name}  started (wrapper PID ${s.wrapperPid})`);
    } else {
      console.error(`  ${name}  failed to start — check logs/${name}-wrapper.log`);
    }
  }
}

async function cmdStop(nameArg) {
  const names = getStopOrder(nameArg);

  for (const name of names) {
    const status = readStatus(name);
    if (!status || !isProcessAlive(status.wrapperPid)) {
      console.log(`  ${name}  not running`);
      // Clean up stale file
      try { fs.unlinkSync(path.join(runtimeDir, `${name}.json`)); } catch { /* ignore */ }
      continue;
    }

    // Signal the wrapper to stop via control file
    const stopFile = path.join(runtimeDir, `${name}.stop`);
    fs.writeFileSync(stopFile, new Date().toISOString());

    // Wait for the wrapper to exit
    let stopped = false;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (!isProcessAlive(status.wrapperPid)) {
        stopped = true;
        break;
      }
    }

    if (!stopped) {
      // Force-kill the wrapper process tree
      console.log(`  ${name}  force-killing...`);
      try {
        const { execSync } = await import('node:child_process');
        execSync(`taskkill /T /F /PID ${status.wrapperPid}`, { stdio: 'ignore' });
      } catch { /* ignore */ }
      await sleep(500);
    }

    // Clean up
    try { fs.unlinkSync(stopFile); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(runtimeDir, `${name}.json`)); } catch { /* ignore */ }

    console.log(`  ${name}  stopped`);
  }
}

async function cmdRestart(nameArg) {
  const names = getServiceNames(nameArg);
  for (const name of names) {
    await cmdStop(name);
  }
  for (const name of names) {
    await cmdStart(name);
  }
}

function cmdStatus() {
  const services = getServices();
  const cols = { name: 18, status: 10, pid: 8, restarts: 4, uptime: 10, command: 30 };
  const header =
    pad('Service', cols.name) +
    pad('Status', cols.status) +
    pad('PID', cols.pid) +
    pad('↻', cols.restarts) +
    pad('Uptime', cols.uptime) +
    'Command';
  const separator = '─'.repeat(header.length + 10);

  console.log();
  console.log(header);
  console.log(separator);

  for (const app of services) {
    const s = readStatus(app.name);
    let status = 'stopped';
    let pid = '-';
    let restarts = '-';
    let uptime = '-';

    if (s && isProcessAlive(s.wrapperPid)) {
      status = s.status || 'running';
      pid = String(s.childPid || s.wrapperPid);
      restarts = String(s.restartCount ?? 0);
      uptime = formatUptime(s.startedAt);
    } else if (s) {
      status = s.status === 'errored' ? 'errored' : 'stopped';
    }

    const statusColor =
      status === 'running' ? '\x1b[32m' :
      status === 'building' ? '\x1b[36m' :
      status === 'errored' || status === 'build-failed' ? '\x1b[31m' :
      status === 'waiting' ? '\x1b[33m' :
      '\x1b[90m';
    const reset = '\x1b[0m';

    const cmd = `${app.launch.command} ${app.launch.args.join(' ')}`;
    const cmdTrunc = cmd.length > cols.command ? cmd.slice(0, cols.command - 3) + '...' : cmd;

    console.log(
      pad(app.name, cols.name) +
      statusColor + pad(status, cols.status) + reset +
      pad(pid, cols.pid) +
      pad(restarts, cols.restarts) +
      pad(uptime, cols.uptime) +
      cmdTrunc,
    );
  }

  console.log();
}

function cmdLogs(nameArg, follow = false) {
  if (!nameArg) {
    console.error('Usage: launcher logs <name> [--error] [--follow|-f]');
    process.exit(1);
  }

  const args = process.argv.slice(3);
  const showErr = args.includes('--error');
  const doFollow = follow || args.includes('-f') || args.includes('--follow');

  const logFile = showErr
    ? path.join(logsDir, `${nameArg}-error.log`)
    : path.join(logsDir, `${nameArg}-out.log`);

  if (!fs.existsSync(logFile)) {
    console.error(`No log file found: ${logFile}`);
    process.exit(1);
  }

  // Print last 50 lines
  const content = fs.readFileSync(logFile, 'utf-8');
  const lines = content.split('\n');
  const tail = lines.slice(-50);
  console.log(tail.join('\n'));

  if (!doFollow) return;

  // Follow mode: watch for new data
  let position = fs.statSync(logFile).size;
  console.log('\n--- Following (Ctrl+C to stop) ---\n');

  const watcher = fs.watch(logFile, () => {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > position) {
        const buf = Buffer.alloc(stat.size - position);
        const fd = fs.openSync(logFile, 'r');
        fs.readSync(fd, buf, 0, buf.length, position);
        fs.closeSync(fd);
        process.stdout.write(buf.toString());
        position = stat.size;
      }
    } catch {
      // ignore
    }
  });

  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });
}

function cmdHelp() {
  console.log(`
AppLauncher — Local service manager

Usage:
  launcher init              Initialize local .runtime/services.yaml template
                            Options: --force
  launcher validate          Validate config and dependency graph
  launcher start   [name]   Start one or all services
  launcher stop    [name]   Stop one or all services
  launcher restart [name]   Restart one or all services
  launcher status           Show service status table
  launcher logs    <name>   Tail logs for a service
                            Options: --error, -f/--follow
  launcher help             Show this help message

Services are defined in .runtime/services.yaml
`);
}

// ── Main ───────────────────────────────────────────────────────────────────
const [command, nameArg] = process.argv.slice(2);

switch (command) {
  case 'init':
    cmdInit(process.argv.slice(3).includes('--force'));
    break;
  case 'validate':
  case 'check':
    cmdValidate();
    break;
  case 'start':
    getServiceNames(nameArg);
    await cmdStart(nameArg);
    break;
  case 'stop':
    getServiceNames(nameArg);
    await cmdStop(nameArg);
    break;
  case 'restart':
    getServiceNames(nameArg);
    await cmdRestart(nameArg);
    break;
  case 'status':
  case 'st':
    cmdStatus();
    break;
  case 'logs':
  case 'log':
    cmdLogs(nameArg);
    break;
  case 'help':
  case '-h':
  case '--help':
    cmdHelp();
    break;
  default:
    if (command) {
      console.error(`Unknown command: "${command}"\n`);
    }
    cmdHelp();
    process.exit(command ? 1 : 0);
}
