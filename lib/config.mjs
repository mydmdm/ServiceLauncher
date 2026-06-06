// Shared config loader — reads .runtime/services.yaml and resolves paths.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require_ = createRequire(import.meta.url);
const yaml = require_('js-yaml');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const root = path.resolve(__dirname, '..');
export const runtimeDir = path.join(root, '.runtime');
export const logsDir = path.join(root, 'logs');

const PORT_REF_RE = /\$\{ports\.([a-zA-Z0-9_-]+)\}/g;

function fail(message) {
  throw new Error(`[config] ${message}`);
}

function interpolateString(value, ports) {
  return value.replace(PORT_REF_RE, (_, key) => {
    if (!(key in ports)) {
      fail(`Unknown port reference: ports.${key}`);
    }
    return String(ports[key]);
  });
}

function interpolateValue(value, ports) {
  if (typeof value === 'string') return interpolateString(value, ports);
  if (Array.isArray(value)) return value.map((v) => interpolateValue(v, ports));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolateValue(v, ports)]),
    );
  }
  return value;
}

function normalizePorts(rawPorts) {
  if (rawPorts == null) return {};
  if (!rawPorts || typeof rawPorts !== 'object' || Array.isArray(rawPorts)) {
    fail('Top-level "ports" must be a mapping object.');
  }

  const seenValues = new Map();
  const ports = {};

  for (const [name, value] of Object.entries(rawPorts)) {
    const port = Number(value);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      fail(`ports.${name} must be an integer between 1 and 65535.`);
    }
    if (seenValues.has(port)) {
      fail(`Duplicate port value ${port} for "${name}" and "${seenValues.get(port)}".`);
    }
    seenValues.set(port, name);
    ports[name] = port;
  }

  return ports;
}

function normalizeCommandStep(stepName, rawStep, serviceName, baseCwd) {
  if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
    fail(`services[${serviceName}].${stepName} must be an object.`);
  }
  if (!rawStep.command || typeof rawStep.command !== 'string') {
    fail(`services[${serviceName}].${stepName}.command is required.`);
  }

  const args = rawStep.args ?? [];
  if (!Array.isArray(args)) {
    fail(`services[${serviceName}].${stepName}.args must be an array.`);
  }

  const stepCwd = rawStep.cwd ? path.resolve(root, rawStep.cwd) : baseCwd;

  return {
    command: String(rawStep.command),
    args: args.map((a) => String(a)),
    cwd: stepCwd,
  };
}

export function loadConfig() {
  const configPath = path.join(runtimeDir, 'services.yaml');
  if (!fs.existsSync(configPath)) {
    fail(
      `Missing ${configPath}. Run "pnpm run init" (or "node bin/launcher.mjs init") first.`,
    );
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const doc = yaml.load(raw) ?? {};

  const ports = normalizePorts(doc.ports);

  if (!Array.isArray(doc.services)) {
    fail('Top-level "services" must be an array.');
  }

  const names = new Set();
  const services = doc.services.map((rawSvc) => {
    const svc = interpolateValue(rawSvc ?? {}, ports);
    const name = String(svc.name ?? '').trim();
    if (!name) fail('Every service must define a non-empty "name".');
    if (names.has(name)) fail(`Duplicate service name: "${name}".`);
    names.add(name);

    const baseCwd = svc.cwd ? path.resolve(root, svc.cwd) : root;
    const deps = svc.deps ?? [];
    if (!Array.isArray(deps)) {
      fail(`services[${name}].deps must be an array.`);
    }

    const env = svc.env ?? {};
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
      fail(`services[${name}].env must be an object.`);
    }

    return {
      name,
      deps: deps.map((d) => String(d)),
      cwd: baseCwd,
      build: svc.build
        ? normalizeCommandStep('build', svc.build, name, baseCwd)
        : null,
      launch: normalizeCommandStep('launch', svc.launch, name, baseCwd),
      env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])),
      maxRestarts: svc.maxRestarts ?? 10,
      restartDelay: svc.restartDelay ?? 3000,
      autorestart: svc.autorestart ?? true,
      ports,
    };
  });

  const known = new Set(services.map((s) => s.name));
  for (const svc of services) {
    for (const dep of svc.deps) {
      if (!known.has(dep)) {
        fail(`Service "${svc.name}" depends on unknown service "${dep}".`);
      }
    }
  }

  return services;
}

export function findService(name) {
  const services = loadConfig();
  return services.find((s) => s.name === name) ?? null;
}
