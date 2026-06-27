#!/usr/bin/env node
/**
 * Cline API Client - Direct HTTP client for LM Studio API
 */

import axios from 'axios';
import { execSync } from 'child_process';

const DEFAULT_TIMEOUT = 30000;

/**
 * Execute a command using the Cline API (direct HTTP calls to LM Studio)
 */
export async function executeClineCommand(command, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  
  // Build the prompt for the agent
  const prompt = `You are an App Idea Generator Agent. Your task is to generate unique app ideas based on user input.

User Input: "${command}"

Rules:
1. Generate ONE unique app idea at a time
2. Include: App Name, Category, Problem Solved, Target Audience, Key Features (3-5), Monetization Strategy, Tech Stack Suggestions
3. Store the idea in apps/{app-name}.md format
4. Update db.md with the new idea entry
5. Wait for user confirmation before generating another idea

Respond with a markdown-formatted app idea.`;

  const apiBase = process.env.CLINE_API_BASE_URL || 'http://localhost:1234/v1';
  
  try {
    // Make API call to LM Studio
    const response = await axios.post(
      `${apiBase}/chat/completions`,
      {
        model: process.env.CLINE_MODEL || 'llama3.1:70b',
        messages: [
          {
            role: 'system',
            content: `You are an expert App Idea Generator Agent. You help users create innovative app ideas by analyzing their requests and generating comprehensive proposals including name, category, problem solved, target audience, key features, monetization strategy, and tech stack recommendations.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 2000,
        stream: false
      },
      {
        timeout: timeout,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    if (error.response) {
      throw new Error(`API Error (${error.response.status}): ${error.response.data.message || error.response.data}`);
    }
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      throw new Error(`Request timed out after ${timeout}ms`);
    }
    throw error;
  }
}

/**
 * Check if the API is accessible
 */
export async function checkAPI() {
  const apiBase = process.env.CLINE_API_BASE_URL || 'http://localhost:1234/v1';
  
  try {
    await axios.get(`${apiBase}/models`, { timeout: 5000 });
    return true;
  } catch (error) {
    console.error('API not accessible. Please ensure LM Studio is running.');
    return false;
  }
}

export default { executeClineCommand, checkAPI };