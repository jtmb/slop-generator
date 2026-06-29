/**
 * Agent Management — Cline CLI lifecycle functions.
 *
 * Handles provider configuration, stale hub-daemon cleanup, and async
 * Cline process spawning with heartbeat logging and timeout handling.
 */
import { spawn } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import logger from '../lib/logger.js';

/**
 * Configure Cline provider by writing providers.json to ~/.cline/data/settings/.
 * Same pattern as slop-planner.
 *
 * @param {string} provider — Provider name (e.g., "lmstudio")
 * @param {string} baseUrl — API base URL (e.g., "http://host.docker.internal:1234/v1")
 * @param {string} model — Model identifier (e.g., "qwen/qwen3.5-9b")
 */
export function configureProvider(provider, baseUrl, model) {
  const clineDir = path.join(homedir(), '.cline', 'data', 'settings');
  mkdirSync(clineDir, { recursive: true });

  const providersConfig = {
    version: 1,
    lastUsedProvider: 'lmstudio',
    providers: {
      lmstudio: {
        settings: {
          provider: 'lmstudio',
          model,
          baseUrl
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

  logger.info({ provider, endpoint: baseUrl, model }, 'Provider configured');
}

/**
 * Kill any stale Cline hub daemon processes.
 * The hub daemon caches session state and rejects hooks from new Cline instances,
 * causing "hook dispatch failed" errors and 5-minute timeouts on every call.
 * Killing it before each run forces a fresh session each time.
 */
export function killHubDaemons() {
  try {
    const procDirs = readdirSync('/proc').filter(d => /^\d+$/.test(d));
    for (const pidStr of procDirs) {
      try {
        const cmdline = readFileSync(`/proc/${pidStr}/cmdline`, 'utf-8').replace(/\0/g, ' ');
        if (cmdline.includes('hub-daemon')) {
          process.kill(parseInt(pidStr, 10), 'SIGKILL');
          logger.info({ pid: parseInt(pidStr, 10) }, 'Killed stale Cline hub daemon');
        }
      } catch (_) {
        // Process exited between listing and reading — ignore
      }
    }
  } catch (_) {
    // /proc not available — ignore (Windows or locked-down container)
  }
}

/**
 * Run a single Cline command with heartbeat logging during execution.
 * Uses async spawn so Node's event loop stays alive — Pino logs flush in
 * real time and the 60s heartbeat proves the process isn't stuck.
 *
 * Cline stdout/stderr is streamed to Pino at trace/debug level so you can
 * see every tool call and model response as it happens.
 *
 * @param {string} prompt — The full prompt to pass to Cline
 * @param {string} provider — Provider name for -P flag (e.g., "lmstudio")
 * @returns {Promise<string>} Cline's stdout on success
 */
export function runCline(prompt, provider) {
  return new Promise((resolve, reject) => {
    killHubDaemons();

    // -t 900: 15-minute timeout — ample for complex tasks now that Cline can
    //          use write_to_file natively (no more node -e double-escaping).
    // --retries 8: modest Cline-level retries — JS wrapper has its own retry
    //              logic via buildTaskRetryPrompt().
    // --thinking high: better code quality than default medium.
    // -c /app: explicit working directory.
    const args = ['-P', provider, '--json', '--auto-approve', 'true', '--thinking', 'high', '-c', '/app', '-t', '900', '--retries', '8', prompt];
    logger.info({ promptPreview: prompt.substring(0, 80) }, 'Cline started');

    const child = spawn('cline', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let lastOutput = '';  // Last meaningful line for heartbeat context

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      const lines = text.trim().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          lastOutput = line.length > 200 ? line.substring(0, 200) + '…' : line;
        }
      }
      logger.debug({ clineOut: text.substring(0, 500) }, 'Cline output');
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (text.trim()) {
        logger.warn({ clineErr: text.substring(0, 300) }, 'Cline stderr');
      }
    });

    const startTime = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const lineCount = stdout.split('\n').filter(l => l.trim()).length;
      logger.info({
        elapsedSec: elapsed,
        lineCount,
        lastOutput: lastOutput.substring(0, 200) || '(no output yet)'
      }, 'Cline still running');
    }, 60000);

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      clearInterval(heartbeat);
      reject(new Error('Cline timed out after 16 minutes'));
    }, 960000); // 1 min safety margin beyond Cline's 15-min timeout

    child.on('close', (code) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);

      if (code !== 0) {
        const msg = stderr.trim() || stdout.trim() || `Exit code ${code}`;
        reject(new Error(msg));
      } else {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const lineCount = stdout.split('\n').filter(l => l.trim()).length;
        logger.info({ elapsedSec: elapsed, lineCount }, 'Cline finished');
        resolve(stdout);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      reject(err);
    });
  });
}
