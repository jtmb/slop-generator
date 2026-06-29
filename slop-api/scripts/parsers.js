/**
 * API Parsers — Read & parse markdown data files into structured objects.
 *
 * Handles both idea files (db.md + apps/*.md) and project files (projects-db.md).
 * All functions are synchronous, reading from disk on demand.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import logger from '../lib/logger.js';

/**
 * Parse all idea entries from db.md into structured objects.
 * Each entry has: id, name, filePath, slug, category, status, dateAdded.
 *
 * @param {string} dbPath — Absolute path to db.md
 * @returns {Array<{id: number, name: string, filePath: string, slug: string, category: string, status: string, dateAdded: string}>}
 */
function parseDatabase(dbPath) {
  if (!existsSync(dbPath)) return [];

  let content;
  try {
    content = readFileSync(dbPath, 'utf-8');
  } catch (err) {
    logger.error({ err, dbPath }, 'Failed to read database file');
    return [];
  }
  const entries = [];

  const entryRegex = /## Idea #(\d+): (.+)\n- \*\*File Path\*\*: `(.+?)`\n- \*\*Category\*\*: (.+)\n- \*\*Status\*\*: (.+)\n- \*\*Date Added\*\*: (.+)/g;

  let match;
  while ((match = entryRegex.exec(content)) !== null) {
    const filePath = match[3].trim();
    entries.push({
      id: parseInt(match[1], 10),
      name: match[2].trim(),
      filePath,
      slug: path.basename(filePath, '.md'),
      category: match[4].trim(),
      status: match[5].trim(),
      dateAdded: match[6].trim(),
    });
  }

  return entries;
}

/**
 * Parse a single app idea markdown file into structured JSON.
 * Detects section types by heading and applies appropriate parsing.
 *
 * @param {string} slug — The slug/filename (without .md extension)
 * @param {string} appsDir — Absolute path to the apps directory
 * @returns {object|null} — Parsed idea or null if file doesn't exist
 */
function parseAppFile(slug, appsDir) {
  const filePath = path.join(appsDir, `${slug}.md`);

  if (!existsSync(filePath)) return null;

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.error({ err, filePath }, 'Failed to read app file');
    return null;
  }

  const titleMatch = content.match(/^# (.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : slug;

  const sections = content.split(/\n(?=## )/);
  const result = { name: title, slug };

  for (const section of sections) {
    const headingMatch = section.match(/^## (.+)/m);
    if (!headingMatch) continue;

    const heading = headingMatch[1].trim();
    const body = section.replace(/^## .+\n?/, '').trim();
    if (!body) continue;

    switch (heading) {
      case 'Overview':
        result.overview = body;
        break;
      case 'Problem Solved':
        result.problemSolved = body;
        break;
      case 'Target Audience':
        result.targetAudience = parseBulletList(body);
        break;
      case 'Key Features':
        result.keyFeatures = parseKeyFeatures(body);
        break;
      case 'Monetization Strategy':
        result.monetization = parseStrategyList(body);
        break;
      case 'Tech Stack Suggestions':
        result.techStack = parseTechStack(body);
        break;
      case 'Implementation Plan':
        result.implementationPlan = body;
        break;
      case 'Status':
        result.progress = parseProgressChecklist(body);
        break;
    }
  }

  return result;
}

/** Parse lines starting with - or * into a string array. */
function parseBulletList(text) {
  const items = text.split('\n').filter(line => /^\s*[-*]\s/.test(line));
  return items.length > 0
    ? items.map(line => line.replace(/^\s*[-*]\s+/, '').trim())
    : [text];
}

/** Parse numbered key features like "1. **Title**: Description". */
function parseKeyFeatures(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const features = [];

  for (const line of lines) {
    const match = line.match(/^\d+\.\s+\*\*(.+?)\*\*(?::\s*(.*)|$)/);
    if (match) {
      features.push({
        title: match[1].trim(),
        description: match[2]?.trim() || '',
      });
    }
  }

  return features.length > 0 ? features : [text];
}

/** Parse bullet or numbered strategy/monetization list. */
function parseStrategyList(text) {
  const items = text.split('\n').filter(
    line => /^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)
  );
  return items.length > 0
    ? items.map(line => line.replace(/^\s*[-*\d]+\.?\s+/, '').trim())
    : [text];
}

/** Parse tech stack bullet list into key-value pairs. */
function parseTechStack(text) {
  const result = {};
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*:\s*(.*)/);
    if (match) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, '_');
      result[key] = match[2].trim();
    }
  }

  return Object.keys(result).length > 0 ? result : text.trim();
}

/** Parse the Status checklist section into boolean flags. */
function parseProgressChecklist(text) {
  const result = {};
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/^\s*-\s*\[([ x])\]\s+(.+)/i);
    if (match) {
      const key = match[2].trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
      result[key] = match[1] === 'x';
    }
  }

  return Object.keys(result).length > 0 ? result : text.trim();
}

/**
 * Parse all project entries from projects-db.md into structured objects.
 * Each entry: id, name, slug, status, dateCompleted.
 *
 * @param {string} projectsDbPath — Absolute path to projects-db.md
 * @returns {Array<{id: number, name: string, slug: string, status: string, dateCompleted: string}>}
 */
function parseProjectsDb(projectsDbPath) {
  if (!existsSync(projectsDbPath)) return [];

  let content;
  try {
    content = readFileSync(projectsDbPath, 'utf-8');
  } catch (err) {
    logger.error({ err, path: projectsDbPath }, 'Failed to read projects database');
    return [];
  }

  const entries = [];
  const entryRegex = /## Project #(\d+): (.+)\n- \*\*Slug\*\*: `(.+?)`\n- \*\*Status\*\*: (.+)\n- \*\*Date Completed\*\*: (.+)/g;

  let match;
  while ((match = entryRegex.exec(content)) !== null) {
    entries.push({
      id: parseInt(match[1], 10),
      name: match[2].trim(),
      slug: match[3].trim(),
      status: match[4].trim(),
      dateCompleted: match[5].trim(),
    });
  }

  return entries;
}

export {
  parseDatabase,
  parseAppFile,
  parseBulletList,
  parseKeyFeatures,
  parseStrategyList,
  parseTechStack,
  parseProgressChecklist,
  parseProjectsDb,
};
