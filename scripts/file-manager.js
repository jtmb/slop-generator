#!/usr/bin/env node
/**
 * File Manager - Safe file operations wrapper
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { mkdir, rename } from 'fs/promises';

const ALLOWED_DIRS = ['apps', 'config'];

/**
 * Read a file with validation
 */
export function readFile(filePath) {
  const absolutePath = filePath.startsWith('/') ? filePath : `./${filePath}`;
  
  if (!existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }
  
  return readFileSync(absolutePath, 'utf-8');
}

/**
 * Write a file with validation
 */
export function writeFile(filePath, content) {
  const absolutePath = filePath.startsWith('/') ? filePath : `./${filePath}`;
  
  // Validate directory
  const dir = absolutePath.substring(0, absolutePath.lastIndexOf('/'));
  if (!ALLOWED_DIRS.some(d => dir.includes(d))) {
    throw new Error(`Invalid directory: ${dir}. Only 'apps' and 'config' are allowed.`);
  }
  
  writeFileSync(absolutePath, content, 'utf-8');
}

/**
 * Create a new app file in the apps directory
 */
export function createAppFile(appName, content) {
  const fileName = `${appName}.md`;
  const filePath = `apps/${fileName}`;
  
  writeFile(filePath, content);
  console.log(`Created: ${filePath}`);
}

/**
 * Update database file
 */
export function updateDatabase(content) {
  writeFile('db.md', content);
}

export default { readFile, writeFile, createAppFile, updateDatabase };
