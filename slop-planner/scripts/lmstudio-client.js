#!/usr/bin/env node
/**
 * LM Studio Client - HTTP client for LM Studio OpenAI-compatible API
 */

import axios from 'axios';

const DEFAULT_TIMEOUT = 30000;

/**
 * Create LM Studio client instance
 */
export function createLMStudioClient(baseUrl = process.env.CLINE_API_BASE_URL) {
  return {
    baseUrl: baseUrl || 'http://localhost:1234/v1',
    
    /**
     * Send chat completion request to LM Studio
     */
    async chat(messages, options = {}) {
      const config = {
        method: 'POST',
        url: `${this.baseUrl}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: options.timeout || DEFAULT_TIMEOUT,
        ...options.config,
      };

      try {
        const response = await axios(config);
        return response.data;
      } catch (error) {
        if (error.response) {
          console.error('LM Studio API error:', error.response.status, error.response.data);
        } else if (error.request) {
          console.error('LM Studio connection failed - is LM Studio running?', error.message);
        } else {
          console.error('LM Studio error:', error.message);
        }
        throw error;
      }
    },
    
    /**
     * Stream chat completion from LM Studio
     */
    async streamChat(messages, options = {}) {
      const config = {
        method: 'POST',
        url: `${this.baseUrl}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: options.timeout || DEFAULT_TIMEOUT,
        params: {
          stream: true,
        },
      };

      try {
        const response = await axios(config);
        
        if (response.data.choices && response.data.choices.length > 0) {
          return response.data.choices[0].delta.content;
        }
        return '';
      } catch (error) {
        throw error;
      }
    },
  };
}

export default createLMStudioClient;
