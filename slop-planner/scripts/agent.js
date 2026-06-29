/**
 * Agent Management — Cline CLI lifecycle functions for the Planner.
 *
 * Handles provider configuration and synchronous Cline process spawning.
 * Uses spawnSync (not spawn) — the planner runs small, focused prompts
 * that don't need streaming or heartbeat monitoring.
 *
 * All functions read config from environment variables when called
 * without explicit arguments (backward-compatible with tests).
 */
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import settings from '../config/settings.json' with { type: 'json' };
import logger from '../lib/logger.js';

// Default config from environment (overridable via explicit args)
const DEFAULT_PROVIDER = process.env.CLINE_PROVIDER || 'lmstudio';
const DEFAULT_BASE_URL = process.env.CLINE_API_BASE_URL || 'http://host.docker.internal:1234/v1';
const DEFAULT_MODEL = process.env.CLINE_MODEL || 'qwen/qwen3.5-9b';

/**
 * Configure Cline provider by writing providers.json to ~/.cline/data/settings/.
 *
 * Reads provider/model/baseUrl from environment when called without args
 * (backward-compatible with tests and main loop).
 *
 * @param {string} [provider] — Provider name (default: CLINE_PROVIDER env)
 * @param {string} [baseUrl] — API base URL (default: CLINE_API_BASE_URL env)
 * @param {string} [model] — Model identifier (default: CLINE_MODEL env)
 */
export function configureProvider(provider, baseUrl, model) {
  const p = provider || DEFAULT_PROVIDER;
  const url = baseUrl || DEFAULT_BASE_URL;
  const m = model || DEFAULT_MODEL;

  const clineDir = path.join(homedir(), '.cline', 'data', 'settings');
  mkdirSync(clineDir, { recursive: true });

  const providersConfig = {
    version: 1,
    lastUsedProvider: 'lmstudio',
    providers: {
      lmstudio: {
        settings: {
          provider: 'lmstudio',
          model: m,
          baseUrl: url
        },
        updatedAt: new Date().toISOString(),
        tokenSource: 'manual'
      }
    }
  };

  writeFileSync(
    path.join(clineDir, 'providers.json'),
    JSON.stringify(providersConfig, null, 2)
  );

  logger.info({ provider: p, endpoint: url, model: m }, 'Provider configured');
}

/**
 * Run a single Cline command synchronously and return stdout.
 *
 * Uses spawnSync with argument array to avoid shell quoting issues.
 * --json ensures tool output is not truncated (non-json mode reports "ok"
 * instead of actual command output, causing false errors).
 *
 * @param {string} prompt — The full prompt to pass to Cline
 * @param {string} [provider] — Provider name for -P flag (default: CLINE_PROVIDER env)
 * @param {number} [timeoutMs] — Timeout in ms (default: settings.timeout_ms || 600000)
 * @returns {string} Cline's stdout
 */
export function runCline(prompt, provider, timeoutMs) {
  const p = provider || DEFAULT_PROVIDER;
  const timeout = timeoutMs || settings.timeout_ms || 600000;
  const args = ['-P', p, '--json', '--retries', '20', prompt];
  logger.info({ promptPreview: prompt.substring(0, 80) }, 'Cline started');

  const result = spawnSync('cline', args, {
    encoding: 'utf-8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const msg = result.stderr?.trim() || result.stdout?.trim() || `Exit code ${result.status}`;
    throw new Error(msg);
  }

  logger.info('Cline finished');
  return result.stdout;
}
