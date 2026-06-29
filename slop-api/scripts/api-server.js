#!/usr/bin/env node
/**
 * API Server — Independent microservice with its own data store.
 *
 * Stores app ideas in its own /app/data/db.md and /app/data/apps/*.md.
 * slop-planner POSTs ideas here after generation.
 * slop-builder GETs random ideas to build.
 *
 * Environment variables (all optional with sensible defaults):
 *   API_PORT       — HTTPS port (default: 3443)
 *   API_KEY        — Pre-shared key to exchange for JWT (default: random UUID, logged)
 *   JWT_SECRET     — JWT signing secret (default: random UUID, logged)
 *   JWT_EXPIRY     — Token lifetime (default: 1h)
 *
 * Files:
 *   api-server.js  — Config, cert generation, Express app, routes, startup (this file)
 *   parsers.js     — Markdown parsers for db.md, apps/*.md, projects-db.md
 *   storage.js     — Write operations (writeAppFile, appendToDatabase, appendProjectToDb)
 *   middleware.js   — JWT authentication middleware
 */

import { createServer } from 'https';
import { readFileSync, existsSync, mkdirSync, renameSync, createReadStream } from 'fs';
import { spawnSync } from 'child_process';
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';
import logger from '../lib/logger.js';
import { parseDatabase, parseAppFile, parseProjectsDb } from './parsers.js';
import { writeAppFile, appendToDatabase, appendProjectToDb } from './storage.js';
import { createAuthMiddleware } from './middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.API_PORT || '3443', 10);
const API_KEY = process.env.API_KEY || crypto.randomUUID();
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomUUID();
const JWT_EXPIRY = process.env.JWT_EXPIRY || '1h';

// API owns its own data directory — no shared volumes with other services
const DATA_DIR = path.join(APP_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.md');
const APPS_DIR = path.join(DATA_DIR, 'apps');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const PROJECTS_DB_PATH = path.join(DATA_DIR, 'projects-db.md');

const CERTS_DIR = '/tmp/api-certs';
const CERT_PATH = path.join(CERTS_DIR, 'cert.pem');
const KEY_PATH = path.join(CERTS_DIR, 'key.pem');

// ---------------------------------------------------------------------------
// Self-signed TLS certificate generation
// ---------------------------------------------------------------------------

/**
 * Generate a self-signed TLS cert + key via openssl if not already present.
 * Stored in /tmp/api-certs/ (ephemeral, regenerated on container restart).
 */
function ensureCertificates() {
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
    return { cert: CERT_PATH, key: KEY_PATH };
  }

  mkdirSync(CERTS_DIR, { recursive: true });

  logger.info('Generating self-signed TLS certificate');
  const result = spawnSync('openssl', [
    'req', '-x509',
    '-newkey', 'rsa:2048',
    '-keyout', KEY_PATH,
    '-out', CERT_PATH,
    '-days', '365',
    '-nodes',
    '-subj', '/CN=slop-api/O=Slop Generator/C=US',
  ], { encoding: 'utf-8' });

  if (result.status !== 0) {
    logger.fatal({ stderr: result.stderr }, 'Failed to generate TLS certificate');
    throw new Error(
      `Failed to generate TLS certificate:\n${result.stderr}`
    );
  }

  logger.info({ certDir: CERTS_DIR }, 'Self-signed certificate created');
  return { cert: CERT_PATH, key: KEY_PATH };
}

// ---------------------------------------------------------------------------
// Project upload (multer)
// ---------------------------------------------------------------------------

/**
 * Multer instance for project uploads (tar.gz archives).
 * Stores to memory; written to disk by the route handler.
 */
const projectUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
});

// ---------------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Request logging middleware — logs method, path, status, and duration for every request
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
    }, 'request');
  });
  next();
});

// Create the JWT auth middleware with the configured secret
const authMiddleware = createAuthMiddleware(JWT_SECRET);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Health check — no auth required. */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/** Exchange API key for a JWT token. */
app.post('/api/v1/auth/token', (req, res) => {
  const { api_key } = req.body || {};

  if (!api_key) {
    return res.status(400).json({
      error: { code: 'MISSING_API_KEY', message: 'Request body must include api_key' },
    });
  }

  if (api_key !== API_KEY) {
    logger.warn('Invalid API key rejected');
    return res.status(401).json({
      error: { code: 'INVALID_API_KEY', message: 'The provided API key is invalid' },
    });
  }

  const token = jwt.sign(
    { sub: 'api-user', iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY },
  );

  logger.info('Token issued');
  res.json({ token, expiresIn: JWT_EXPIRY });
});

/** List all ideas (summary only). Auth required. */
app.get('/api/v1/ideas', authMiddleware, (_req, res) => {
  const ideas = parseDatabase(DB_PATH);
  res.json({ count: ideas.length, ideas });
});

/** Get a random idea with full details. Auth required. */
app.get('/api/v1/ideas/random', authMiddleware, (_req, res) => {
  const ideas = parseDatabase(DB_PATH);

  if (ideas.length === 0) {
    return res.status(404).json({
      error: { code: 'NO_IDEAS', message: 'No ideas exist in the database yet' },
    });
  }

  const pick = ideas[Math.floor(Math.random() * ideas.length)];
  const details = parseAppFile(pick.slug, APPS_DIR);

  res.json({ ...pick, details });
});

/** Get a specific idea by slug. Auth required. */
app.get('/api/v1/ideas/:slug', authMiddleware, (req, res) => {
  const { slug } = req.params;
  const details = parseAppFile(slug, APPS_DIR);

  if (!details) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: `No idea found with slug "${slug}"` },
    });
  }

  const ideas = parseDatabase(DB_PATH);
  const meta = ideas.find(i => i.slug === slug);
  res.json({ ...(meta || { slug, name: details.name }), details });
});

/**
 * POST /api/v1/ideas — Ingest a new app idea from slop-planner.
 *
 * Idempotent: returns 409 Conflict if the slug already exists.
 * Returns 201 Created with a Location header on success.
 */
app.post('/api/v1/ideas', authMiddleware, (req, res) => {
  const idea = req.body || {};

  if (!idea.slug) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Request body must include slug' },
    });
  }

  if (!idea.name) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Request body must include name' },
    });
  }

  // Sanitize slug: lowercase, replace spaces/underscores with hyphens, strip non-alnum+dash
  const slug = idea.slug
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  // Check for existing slug (idempotency)
  const filePath = path.join(APPS_DIR, `${slug}.md`);
  if (existsSync(filePath)) {
    return res.status(409).json({
      error: { code: 'CONFLICT', message: `Idea with slug "${slug}" already exists` },
    });
  }

  // Write the app markdown file and update the database
  idea.slug = slug;
  writeAppFile(idea, APPS_DIR);
  appendToDatabase(idea, DATA_DIR, DB_PATH, parseDatabase);

  logger.info({ slug, name: idea.name }, 'Ingested new idea');

  res.status(201)
    .set('Location', `/api/v1/ideas/${slug}`)
    .json({ slug, name: idea.name, status: 'created' });
});

/**
 * GET /api/v1/ideas/:slug/raw — Return the raw markdown content of an idea.
 * Used by the orchestrator to write idea files into the git repo.
 */
app.get('/api/v1/ideas/:slug/raw', authMiddleware, (req, res) => {
  const { slug } = req.params;
  const filePath = path.join(APPS_DIR, `${slug}.md`);

  if (!existsSync(filePath)) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: `No idea found with slug "${slug}"` },
    });
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
  } catch (err) {
    logger.error({ err, slug }, 'Failed to read idea file for raw endpoint');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to read idea file' },
    });
  }
});

/**
 * POST /api/v1/projects — Ingest a completed project (tar.gz archive) from builder.
 *
 * Multipart/form-data: slug (text), name (text), status (text), project (file).
 * Idempotent: returns 409 Conflict if slug already exists with same status.
 * Returns 201 Created with project metadata on success.
 */
app.post('/api/v1/projects', authMiddleware, projectUpload.single('project'), (req, res) => {
  const { slug, name, status } = req.body;
  const file = req.file;

  if (!slug) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'slug field is required' },
    });
  }
  if (!name) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'name field is required' },
    });
  }
  if (!file) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'project file is required' },
    });
  }

  // Sanitize slug
  const cleanSlug = slug
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  // Idempotency check — project already uploaded?
  const existing = parseProjectsDb(PROJECTS_DB_PATH).find(p => p.slug === cleanSlug);
  if (existing) {
    return res.status(409).json({
      error: { code: 'CONFLICT', message: `Project with slug "${cleanSlug}" already exists` },
      existing: { slug: existing.slug, name: existing.name, status: existing.status },
    });
  }

  // Write the tar.gz file to disk
  mkdirSync(PROJECTS_DIR, { recursive: true });
  const tmpPath = path.join(PROJECTS_DIR, `${cleanSlug}.tar.gz.tmp`);
  const finalPath = path.join(PROJECTS_DIR, `${cleanSlug}.tar.gz`);

  try {
    writeFileSync(tmpPath, file.buffer);
    renameSync(tmpPath, finalPath);
  } catch (err) {
    logger.error({ err, slug: cleanSlug }, 'Failed to write project archive');
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to save project archive' },
    });
  }

  // Update project registry
  const projectStatus = status || 'Complete';
  appendProjectToDb({ slug: cleanSlug, name, status: projectStatus }, DATA_DIR, PROJECTS_DB_PATH, parseProjectsDb);

  logger.info({ slug: cleanSlug, name, size: file.size }, 'Ingested new project');

  res.status(201)
    .set('Location', `/api/v1/projects/${cleanSlug}`)
    .json({ slug: cleanSlug, name, status: projectStatus, size: file.size });
});

/**
 * GET /api/v1/projects — List all completed projects from the project registry.
 */
app.get('/api/v1/projects', authMiddleware, (_req, res) => {
  const projects = parseProjectsDb(PROJECTS_DB_PATH);
  res.json({ count: projects.length, projects });
});

/**
 * GET /api/v1/projects/:slug — Get metadata for a single project.
 */
app.get('/api/v1/projects/:slug', authMiddleware, (req, res) => {
  const { slug } = req.params;
  const projects = parseProjectsDb(PROJECTS_DB_PATH);
  const project = projects.find(p => p.slug === slug);

  if (!project) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: `No project found with slug "${slug}"` },
    });
  }

  const archivePath = path.join(PROJECTS_DIR, `${slug}.tar.gz`);
  const size = existsSync(archivePath)
    ? readFileSync(archivePath).length
    : 0;

  res.json({ ...project, size });
});

/**
 * GET /api/v1/projects/:slug/download — Stream the project tar.gz archive.
 * Used by the orchestrator to pull project files for git push.
 */
app.get('/api/v1/projects/:slug/download', authMiddleware, (req, res) => {
  const { slug } = req.params;
  const archivePath = path.join(PROJECTS_DIR, `${slug}.tar.gz`);

  if (!existsSync(archivePath)) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: `No project archive found for slug "${slug}"` },
    });
  }

  res.set('Content-Type', 'application/gzip');
  res.set('Content-Disposition', `attachment; filename="${slug}.tar.gz"`);

  const stream = createReadStream(archivePath);
  stream.on('error', (err) => {
    logger.error({ err, slug }, 'Failed to stream project archive');
    if (!res.headersSent) {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to stream project archive' },
      });
    }
  });
  stream.pipe(res);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Only start the server when executed directly (not imported for tests)
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('api-server.js') ||
  process.argv[1].endsWith('api-server')
);

if (isMainModule) {
  // Log configuration state so operators know the key to use
  if (!process.env.API_KEY) {
    logger.warn('No API_KEY set — auto-generated (set API_KEY in .env for persistence)');
  }
  if (!process.env.JWT_SECRET) {
    logger.warn('No JWT_SECRET set — auto-generated (tokens invalid on restart, set JWT_SECRET for persistence)');
  }

  // Ensure data directories exist
  mkdirSync(APPS_DIR, { recursive: true });
  mkdirSync(PROJECTS_DIR, { recursive: true });

  // Ensure TLS certificates exist, then start the server
  const { cert, key } = ensureCertificates();
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, app);

  server.listen(PORT, () => {
    logger.info({ port: PORT, dataDir: DATA_DIR }, 'HTTPS server listening');
  });

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

export { app, parseDatabase, parseAppFile, parseProjectsDb, writeAppFile, appendToDatabase, appendProjectToDb, authMiddleware };
