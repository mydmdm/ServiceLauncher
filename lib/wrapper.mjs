#!/usr/bin/env node

// Per-service wrapper process.
// Spawned in detached mode by the launcher. Manages a single service's
// lifecycle: build → launch, log, auto-restart, and graceful stop.

import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { findService, root, runtimeDir, logsDir } from './config.mjs';

// ── Resolve service ────────────────────────────────────────────────────────
const serviceName = process.argv[2];
if (!serviceName) {
  console.error('Usage: node wrapper.mjs <service-name>');
  process.exit(1);
}

const service = findService(serviceName);
if (!service) {
  console.error(`Service "${serviceName}" not found in config`);
  process.exit(1);
}

// Defaults
const maxRestarts = service.maxRestarts;
const restartDelay = service.restartDelay;
const autorestart = service.autorestart;
const STABLE_UPTIME_MS = 60_000; // reset restart counter after 60s stable

// ── Directories & files ────────────────────────────────────────────────────
fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });

const statusFile = path.join(runtimeDir, `${serviceName}.json`);
const stopFile = path.join(runtimeDir, `${serviceName}.stop`);
const outLogFile = path.join(logsDir, `${serviceName}-out.log`);
const errLogFile = path.join(logsDir, `${serviceName}-error.log`);

// ── State ──────────────────────────────────────────────────────────────────
let restartCount = 0;
let child = null;
let stopping = false;
let stableTimer = null;
let startedAt = null;

// ── Helpers ────────────────────────────────────────────────────────────────
function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function writeStatus(status, extra = {}) {
  const launchCmd = `${service.launch.command} ${service.launch.args.join(' ')}`;
  const data = {
    name: serviceName,
    wrapperPid: process.pid,
    childPid: child?.pid ?? null,
    status,
    startedAt,
    restartCount,
    updatedAt: new Date().toISOString(),
    command: launchCmd,
    cwd: service.launch.cwd,
    ...extra,
  };
  try {
    const tmpFile = statusFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, statusFile);
  } catch (e) {
    // Best-effort; don't crash the wrapper over a status write
  }
}

function appendLog(filePath, msg) {
  try {
    fs.appendFileSync(filePath, `[${timestamp()}] ${msg}\n`);
  } catch (e) {
    // ignore
  }
}

// ── Build step ─────────────────────────────────────────────────────────────
function runBuild() {
  return new Promise((resolve, reject) => {
    if (!service.build) return resolve();

    const buildCmd = `${service.build.command} ${service.build.args.join(' ')}`;
    appendLog(outLogFile, `--- Building "${serviceName}": ${buildCmd} ---`);
    writeStatus('building');

    const outStream = fs.createWriteStream(outLogFile, { flags: 'a' });
    const errStream = fs.createWriteStream(errLogFile, { flags: 'a' });

    const proc = spawn(service.build.command, service.build.args, {
      cwd: service.build.cwd,
      env: { ...process.env, ...service.env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    proc.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line) outStream.write(`[${timestamp()}] [build] ${line}\n`);
      }
    });

    proc.stderr.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line) errStream.write(`[${timestamp()}] [build] ${line}\n`);
      }
    });

    proc.on('error', (err) => {
      outStream.end();
      errStream.end();
      reject(err);
    });

    proc.on('exit', (code) => {
      outStream.end();
      errStream.end();
      if (code === 0) {
        appendLog(outLogFile, `--- Build succeeded ---`);
        resolve();
      } else {
        reject(new Error(`Build exited with code ${code}`));
      }
    });
  });
}

// ── Launch (child process management) ──────────────────────────────────────
async function startChild() {
  startedAt = new Date().toISOString();

  // Run build step first
  try {
    await runBuild();
  } catch (err) {
    appendLog(errLogFile, `--- Build failed: ${err.message} ---`);

    if (stopping) {
      writeStatus('stopped');
      cleanup();
      process.exit(0);
      return;
    }

    if (autorestart && restartCount < maxRestarts) {
      restartCount++;
      writeStatus('build-failed', { error: err.message, nextRestartIn: restartDelay });
      appendLog(
        outLogFile,
        `--- Retrying build in ${restartDelay}ms (attempt ${restartCount}/${maxRestarts}) ---`,
      );
      setTimeout(startChild, restartDelay);
    } else {
      writeStatus('errored', { error: err.message });
      cleanup();
      process.exit(1);
    }
    return;
  }

  // Check if stop was requested during build
  if (stopping) {
    writeStatus('stopped');
    cleanup();
    process.exit(0);
    return;
  }

  const outStream = fs.createWriteStream(outLogFile, { flags: 'a' });
  const errStream = fs.createWriteStream(errLogFile, { flags: 'a' });

  const launchCmd = `${service.launch.command} ${service.launch.args.join(' ')}`;
  appendLog(outLogFile, `--- Launching "${serviceName}": ${launchCmd} (restart #${restartCount}) ---`);

  try {
    child = spawn(service.launch.command, service.launch.args, {
      cwd: service.launch.cwd,
      env: { ...process.env, ...service.env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    appendLog(errLogFile, `Failed to spawn: ${err.message}`);
    writeStatus('errored', { error: err.message });
    process.exit(1);
  }

  writeStatus('running');

  child.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      if (line) outStream.write(`[${timestamp()}] ${line}\n`);
    }
  });

  child.stderr.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      if (line) errStream.write(`[${timestamp()}] ${line}\n`);
    }
  });

  // Reset restart counter after stable uptime
  stableTimer = setTimeout(() => {
    restartCount = 0;
    writeStatus('running');
  }, STABLE_UPTIME_MS);

  child.on('error', (err) => {
    appendLog(errLogFile, `Spawn error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    clearTimeout(stableTimer);
    outStream.end();
    errStream.end();

    appendLog(outLogFile, `--- "${serviceName}" exited (code=${code}, signal=${signal}) ---`);

    child = null;

    if (stopping) {
      writeStatus('stopped');
      cleanup();
      process.exit(0);
      return;
    }

    if (autorestart && restartCount < maxRestarts) {
      restartCount++;
      writeStatus('waiting', { nextRestartIn: restartDelay });
      appendLog(
        outLogFile,
        `--- Restarting in ${restartDelay}ms (attempt ${restartCount}/${maxRestarts}) ---`,
      );
      setTimeout(startChild, restartDelay);
    } else {
      writeStatus('errored', { lastExitCode: code });
      appendLog(
        errLogFile,
        `--- Exceeded max restarts (${maxRestarts}), giving up ---`,
      );
      cleanup();
      process.exit(1);
    }
  });
}

// ── Stop logic ─────────────────────────────────────────────────────────────
function stopChild() {
  if (stopping) return;
  stopping = true;
  clearInterval(stopPoll);

  if (!child) {
    writeStatus('stopped');
    cleanup();
    process.exit(0);
    return;
  }

  appendLog(outLogFile, `--- Stopping "${serviceName}" gracefully ---`);

  // Attempt graceful kill
  try {
    process.kill(child.pid);
  } catch (e) {
    // already dead
  }

  // Force-kill the process tree after 5 seconds
  const forceTimer = setTimeout(() => {
    if (child && !child.killed) {
      appendLog(outLogFile, `--- Force-killing "${serviceName}" process tree ---`);
      try {
        execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: 'ignore' });
      } catch (e) {
        // already dead
      }
    }
  }, 5000);

  // The child 'exit' handler will call cleanup and process.exit
  // but if it doesn't fire within 8s, force exit
  setTimeout(() => {
    clearTimeout(forceTimer);
    writeStatus('stopped');
    cleanup();
    process.exit(0);
  }, 8000);
}

function cleanup() {
  try {
    fs.unlinkSync(stopFile);
  } catch (e) {
    // ignore
  }
}

// ── Stop-file polling ──────────────────────────────────────────────────────
const stopPoll = setInterval(() => {
  try {
    if (fs.existsSync(stopFile)) {
      stopChild();
    }
  } catch (e) {
    // ignore
  }
}, 500);

// ── Signal handlers ────────────────────────────────────────────────────────
process.on('SIGTERM', stopChild);
process.on('SIGINT', stopChild);
process.on('uncaughtException', (err) => {
  appendLog(errLogFile, `Wrapper uncaught exception: ${err.stack}`);
  stopChild();
});

// ── Clean up stale stop file and start ─────────────────────────────────────
try {
  fs.unlinkSync(stopFile);
} catch (e) {
  // ignore
}

startChild();
