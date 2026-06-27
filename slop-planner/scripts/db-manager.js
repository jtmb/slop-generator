#!/usr/bin/env node
/**
 * Database Manager - Track generated app ideas
 */

import { readFileSync, writeFileSync } from 'fs';

const DB_FILE = 'db.md';

/**
 * Initialize database file if it doesn't exist
 */
export function initDatabase() {
  const defaultContent = `# App Idea Database
*Last Updated: ${new Date().toISOString().split('T')[0]}*

## Total Ideas Generated: 0

---

## (No ideas generated yet)

*Use this file to track all app ideas. Before generating a new idea, review this database to ensure uniqueness.*
`;

  if (!readFileSync(DB_FILE, 'utf-8')) {
    writeFileSync(DB_FILE, defaultContent);
    console.log('Initialized database');
  }
}

/**
 * Read existing database content
 */
export function readDatabase() {
  try {
    return readFileSync(DB_FILE, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read ${DB_FILE}: ${error.message}`);
  }
}

/**
 * Add a new idea entry to the database
 */
export function addIdeaEntry(appName, category, filePath, status = 'Idea Generated') {
  const content = readDatabase();
  
  // Parse existing ideas count
  const totalMatch = content.match(/## Total Ideas Generated: (\d+)/);
  let totalIdeas = totalMatch ? parseInt(totalMatch[1]) : 0;
  
  // Update total count
  const updatedContent = content.replace(
    /## Total Ideas Generated: \d+/g,
    `## Total Ideas Generated: ${totalIdeas + 1}`
  );
  
  // Add new entry
  const newEntry = `\n## Idea #${totalIdeas + 1}: ${appName}
- **File Path**: \`\`\`apps/${filePath}\`\`\`
- **Category**: ${category}
- **Status**: ${status}
- **Date Added**: ${new Date().toISOString().split('T')[0]}`;

  writeFileSync(DB_FILE, updatedContent + newEntry);
  console.log(`Added idea: ${appName} to database`);
}

export default { initDatabase, readDatabase, addIdeaEntry };
