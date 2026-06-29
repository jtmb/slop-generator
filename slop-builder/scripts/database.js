/**
 * Database Operations — Builder's db.md read/write functions.
 *
 * Tracks every project the builder has processed: slug, name, status, date.
 * Used for dedup (isAlreadyBuilt), retry targeting (getFailedProjects),
 * and crash recovery (getDbEntry).
 *
 * All functions accept an explicit dbPath parameter so they can be tested
 * with temp files without stubbing process-level constants.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

/**
 * Check if a slug has already been completed by the builder.
 * Reads the builder's own db.md and looks for a matching entry with
 * any "done" status (Complete, Tests Failed, Built (push failed), etc.).
 *
 * @param {string} slug
 * @param {string} dbPath
 * @returns {boolean}
 */
export function isAlreadyBuilt(slug, dbPath) {
  if (!existsSync(dbPath)) return false;

  const content = readFileSync(dbPath, 'utf-8');

  // Match entries with this slug that are already processed.
  // "Complete", "Complete (tests failed)", "Tests Failed", "Built (push failed)" all count as done.
  const entryRegex = new RegExp(
    `## Project #\\d+: .+\\n- \\*\\*Slug\\*\\*: \`${slug}\`\\n- \\*\\*Status\\*\\*: (Complete|Complete \\(tests failed\\)|Tests Failed|Built \\(push failed\\))`,
    'i'
  );

  return entryRegex.test(content);
}

/**
 * Count failed projects in db.md and return them sorted oldest-first.
 * A project is "failed" if its status indicates the build completed but
 * didn't result in a successful push (upload or tests failed).
 *
 * Failed statuses:
 *   - "Built (push failed, tests failed)"
 *   - "Built (push failed)"
 *   - "Complete (tests failed)" — retried (build succeeded but tests failed)
 *
 * @param {string} dbPath
 * @returns {Array<{ slug: string, name: string }>} Oldest-first. Empty if none or db.md missing.
 */
export function getFailedProjects(dbPath) {
  if (!existsSync(dbPath)) return [];

  const content = readFileSync(dbPath, 'utf-8');
  const lines = content.split('\n');
  const failed = [];
  let currentEntry = null;

  for (const line of lines) {
    // Start of a new project entry
    const entryMatch = line.match(/^## Project #(\d+): (.+)$/);
    if (entryMatch) {
      // Flush previous entry if it was failed
      if (currentEntry && currentEntry.failed) {
        failed.push({ slug: currentEntry.slug, name: currentEntry.name });
      }
      currentEntry = { name: entryMatch[2].trim(), slug: null, failed: false };
      continue;
    }

    if (!currentEntry) continue;

    // Capture slug
    const slugMatch = line.match(/^- \*\*Slug\*\*: `(.+)`$/);
    if (slugMatch) {
      currentEntry.slug = slugMatch[1];
      continue;
    }

    // Capture status — "push failed", "Tests Failed", and "Complete (tests failed)" are retryable
    const statusMatch = line.match(/^- \*\*Status\*\*: (.+)$/);
    if (statusMatch) {
      const status = statusMatch[1].trim();
      currentEntry.failed =
        status.includes('push failed') ||
        status === 'Tests Failed' ||
        status === 'Complete (tests failed)';
      continue;
    }
  }

  // Don't forget last entry
  if (currentEntry && currentEntry.failed) {
    failed.push({ slug: currentEntry.slug, name: currentEntry.name });
  }

  return failed;
}

/**
 * Update the builder's db.md with a new or updated project entry.
 * Creates the file (and parent directory) if it doesn't exist.
 * For existing entries, updates the Status line after the Slug line.
 *
 * @param {string} slug
 * @param {string} ideaName
 * @param {string} status
 * @param {string} dbPath
 */
export function updateDatabase(slug, ideaName, status, dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });

  let dbContent = '';
  if (existsSync(dbPath)) {
    dbContent = readFileSync(dbPath, 'utf-8');
  }

  // Check if entry already exists
  const entryRegex = new RegExp(`## Project #\\d+: .+\\n- \\*\\*Slug\\*\\*: \`${slug}\``);
  if (entryRegex.test(dbContent)) {
    // Update status line AFTER the slug line
    const lines = dbContent.split('\n');
    let inEntry = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`\`${slug}\``) && lines[i].startsWith('- **Slug**')) {
        inEntry = true;
        continue;
      }
      if (inEntry && lines[i].startsWith('- **Status**:')) {
        lines[i] = `- **Status**: ${status}`;
        break;
      }
      if (inEntry && lines[i].startsWith('## ')) {
        break; // Next entry — shouldn't happen, but safe
      }
    }
    dbContent = lines.join('\n');
  } else {
    // Count existing projects for next ID
    const countMatch = dbContent.match(/## Total Projects Built: (\d+)/);
    const nextId = countMatch ? parseInt(countMatch[1], 10) + 1 : 1;
    const date = new Date().toISOString().split('T')[0];

    const entry = [
      '',
      `## Project #${nextId}: ${ideaName}`,
      `- **Slug**: \`${slug}\``,
      `- **Status**: ${status}`,
      `- **Date Completed**: ${date}`,
      '',
    ].join('\n');

    if (countMatch) {
      dbContent = dbContent.replace(
        /## Total Projects Built: \d+/,
        `## Total Projects Built: ${nextId}`
      );
    } else {
      dbContent = `## Total Projects Built: ${nextId}\n\n`;
    }
    dbContent += entry;
  }

  writeFileSync(dbPath, dbContent);
}

/**
 * Look up a project's status from db.md.
 * Returns null if no entry found, or if the status indicates an incomplete/failed
 * push (these should be re-processed).
 *
 * @param {string} slug
 * @param {string} dbPath
 * @returns {string|null} Status string or null.
 */
export function getDbEntry(slug, dbPath) {
  if (!existsSync(dbPath)) return null;

  const content = readFileSync(dbPath, 'utf-8');
  const lines = content.split('\n');
  let inEntry = false;

  for (const line of lines) {
    if (line.includes(`\`${slug}\``) && line.startsWith('- **Slug**')) {
      inEntry = true;
      continue;
    }
    if (inEntry && line.startsWith('- **Status**')) {
      const status = line.replace('- **Status**: ', '').trim();
      // Any failed or incomplete status means the project never reached git push.
      // Return null so reconciliation can re-process and push it.
      if (/failed|incomplete/i.test(status)) {
        return null;
      }
      return status;
    }
    if (inEntry && line.startsWith('## ')) {
      break;
    }
  }

  return null;
}
