/**
 * Database Operations — Planner db.md parsing and app file reading.
 *
 * The planner maintains its own independent db.md tracking generated ideas.
 * This module handles parsing both the database and individual app files
 * into structured objects for the API client to post.
 *
 * Also manages .posted-slugs.json — a tracker of which ideas have already
 * been sent to slop-api, preventing redundant API calls across restarts.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import logger from '../lib/logger.js';

// Track which slugs have already been posted to avoid redundant API calls
let postedSlugs = new Set();

/**
 * Parse a planner app markdown file into the JSON shape expected by POST /api/v1/ideas.
 *
 * The planner's Cline agent writes files with sections:
 *   # Name, ## Overview, ## Problem Solved, ## Target Audience,
 *   ## Key Features, ## Monetization Strategy, ## Tech Stack Suggestions,
 *   ## Implementation Plan
 *
 * @param {string} filePath — Absolute path to the app .md file
 * @returns {object|null} Parsed idea object, or null if invalid
 */
export function parsePlannerAppFile(filePath) {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Title is the first # heading
  const name = (lines.find(l => l.startsWith('# ')) || '').replace(/^# /, '').trim();
  if (!name) return null;

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Extract sections between ## headings
  const getSection = (heading) => {
    const startIdx = lines.findIndex(l => l.toLowerCase().startsWith(`## ${heading.toLowerCase()}`));
    if (startIdx === -1) return '';
    let endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith('## '));
    if (endIdx === -1) endIdx = lines.length;
    return lines.slice(startIdx + 1, endIdx).join('\n').trim();
  };

  const overview = getSection('Overview');
  const problemSolved = getSection('Problem Solved');
  const targetAudienceRaw = getSection('Target Audience');
  const keyFeaturesRaw = getSection('Key Features');
  const monetizationRaw = getSection('Monetization Strategy');
  const techStackRaw = getSection('Tech Stack Suggestions');
  const implementationPlanRaw = getSection('Implementation Plan');

  // Parse target audience as array of strings (comma-separated or newline-separated)
  const targetAudience = targetAudienceRaw
    ? targetAudienceRaw.split(/[,\n]/).map(s => s.replace(/^[-*\d.]+\s*/, '').trim()).filter(Boolean)
    : [];

  // Parse key features — numbered items or bullet points
  const keyFeatures = keyFeaturesRaw
    ? keyFeaturesRaw.split('\n')
        .filter(l => /^[\d]+\.|^[-*]/.test(l.trim()))
        .map(l => {
          const cleaned = l.replace(/^[\d]+\.\s*\*?\*?|^[-*]\s+/, '').trim();
          // Split bold title from description: **Title**: description
          const match = cleaned.match(/^\*{0,2}([^*:]+?)\*{0,2}:\s*(.*)/);
          if (match) {
            return { title: match[1].trim(), description: match[2].trim() };
          }
          return { title: cleaned, description: '' };
        })
    : [];

  // Parse monetization as array of strings
  const monetization = monetizationRaw
    ? monetizationRaw.split('\n')
        .filter(l => /^[\d]+\.|^[-*]/.test(l.trim()))
        .map(l => l.replace(/^[\d]+\.\s*|^[-*]\s+/, '').trim())
        .filter(Boolean)
    : [];

  // Parse tech stack into key-value pairs from bullet list (e.g. "- **Frontend**: React")
  const techStack = {};
  if (techStackRaw) {
    const techLines = techStackRaw.split('\n').filter(l => /^[-*]/.test(l.trim()));
    for (const line of techLines) {
      const match = line.match(/[-*]\s*\*{0,2}([^*:]+?)\*{0,2}:\s*(.*)/);
      if (match) {
        techStack[match[1].trim()] = match[2].trim();
      }
    }
  }

  return {
    slug,
    name,
    overview,
    problemSolved,
    targetAudience,
    keyFeatures,
    monetization,
    techStack,
    implementationPlan: implementationPlanRaw,
    dateAdded: new Date().toISOString().split('T')[0],
  };
}

/**
 * Parse the planner's db.md to extract all idea entries as structured objects.
 *
 * The planner db uses this format:
 *   ## Idea #N: Name
 *   - **File Path**: `apps/slug.md`
 *   - **Category**: ...
 *   - **Status**: Idea Generated
 *   - **Date Added**: YYYY-MM-DD
 *
 * @returns {Array<{slug: string, name: string, filePath: string, category: string, status: string, dateAdded: string}>}
 */
export function parsePlannerDb() {
  const dbPath = '/app/db.md';
  if (!existsSync(dbPath)) return [];

  const content = readFileSync(dbPath, 'utf-8');
  const ideas = [];
  const blocks = content.split(/^## Idea #\d+:/m);

  for (const block of blocks) {
    const nameMatch = block.match(/^\s*(.+)/m);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();
    const filePathMatch = block.match(/\*\*File Path\*\*:\s*`?([^`\n]+)`?/);
    const categoryMatch = block.match(/\*\*Category\*\*:\s*(.+)/);
    const statusMatch = block.match(/\*\*Status\*\*:\s*(.+)/);
    const dateMatch = block.match(/\*\*Date Added\*\*:\s*(.+)/);

    const fullPath = filePathMatch ? `/app/${filePathMatch[1].trim()}` : null;
    const slugFromPath = filePathMatch
      ? filePathMatch[1].replace(/^apps\//, '').replace(/\.md$/, '')
      : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    ideas.push({
      slug: slugFromPath,
      name,
      filePath: fullPath,
      category: (categoryMatch?.[1] || '').trim(),
      status: (statusMatch?.[1] || '').trim(),
      dateAdded: (dateMatch?.[1] || '').trim(),
    });
  }

  return ideas;
}

/**
 * Load the posted-slugs tracker from disk.
 * Prevents re-posting ideas that were already sent to slop-api.
 *
 * @param {string} [postedSlugsPath='/app/.posted-slugs.json'] — Override path for testing
 */
export function loadPostedSlugs(postedSlugsPath = '/app/.posted-slugs.json') {
  try {
    if (existsSync(postedSlugsPath)) {
      const data = JSON.parse(readFileSync(postedSlugsPath, 'utf-8'));
      postedSlugs = new Set(data.slugs || []);
      logger.info({ count: postedSlugs.size }, 'Loaded posted-slugs tracker');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load posted-slugs tracker — starting fresh');
    postedSlugs = new Set();
  }
}

/**
 * Persist the posted-slugs tracker to disk.
 * Runs after each postIdeasToApi cycle.
 *
 * @param {string} [postedSlugsPath='/app/.posted-slugs.json'] — Override path for testing
 */
export function savePostedSlugs(postedSlugsPath = '/app/.posted-slugs.json') {
  try {
    writeFileSync(postedSlugsPath, JSON.stringify({ slugs: [...postedSlugs] }, null, 2));
  } catch (err) {
    logger.warn({ err }, 'Failed to save posted-slugs tracker');
  }
}

/**
 * Get the current posted slugs set (for use by api-client).
 *
 * @returns {Set<string>}
 */
export function getPostedSlugs() {
  return postedSlugs;
}
