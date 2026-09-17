/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MEMORY_TOOLS, MEMORY_TOOL_NAMES } from './tools.js';

interface TestSchema {
  description?: string;
  properties?: Record<string, TestSchema>;
}

describe('Memory tool definitions', () => {
  const retrieve = MEMORY_TOOLS.find(
    (tool) => tool.function.name === 'omniretrieve',
  )!;
  const bio = MEMORY_TOOLS.find((tool) => tool.function.name === 'omnibio')!;

  it('preserves both tools and their silent pre-answer continuation contract', () => {
    expect(MEMORY_TOOLS.map((tool) => tool.function.name)).toEqual([
      'omniretrieve',
      'omnibio',
    ]);
    expect([...MEMORY_TOOL_NAMES]).toEqual(['omniretrieve', 'omnibio']);
    for (const tool of MEMORY_TOOLS) {
      expect(tool.type).toBe('function');
      expect(tool.continuesResponse).toBe(true);
      expect(tool.function.description).toContain(
        'Send this call BEFORE you answer, on its own with no text around it',
      );
    }
    expect(bio.function.description).toContain(
      'write every entry in the third person about the user',
    );
    expect(bio.function.description).toContain(
      'user_profile and recent are read-only',
    );
    expect(bio.function.description).toContain(
      "Don't record what the memory sections already contain",
    );
  });

  it('keeps operation structure in the nested schema instead of flattening it into description prose', () => {
    const operations = (bio.function.parameters as TestSchema).properties?.[
      'operations'
    ];
    expect(bio.function.description).not.toContain(
      'The operations object takes',
    );
    expect(operations?.description).toBe(
      'The operations to perform on personalized_user_memories.',
    );
  });

  it('declares the nested mutation types and only the required fields without extra operation limits', () => {
    expect(bio.function.parameters).toEqual({
      type: 'object',
      properties: {
        operations: {
          type: 'object',
          description: expect.any(String),
          properties: {
            add: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              description: expect.any(String),
            },
            update: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: {
                    type: 'integer',
                    minimum: 0,
                    description: expect.any(String),
                  },
                  content: {
                    type: 'string',
                    minLength: 1,
                    description: expect.any(String),
                  },
                },
                required: ['index', 'content'],
                additionalProperties: false,
              },
              description: expect.any(String),
            },
            delete: {
              type: 'array',
              items: { type: 'integer', minimum: 0 },
              description: expect.any(String),
            },
          },
          additionalProperties: false,
        },
      },
      required: ['operations'],
      additionalProperties: false,
    });
  });

  it('keeps retrieval sources explicit and the two-number time window optional', () => {
    expect(retrieve.function.parameters).toEqual({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          description: expect.any(String),
        },
        source: {
          type: 'string',
          enum: ['dialogue', 'env'],
          description: expect.any(String),
        },
        time_range: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: expect.any(String),
        },
      },
      required: ['query', 'source'],
      additionalProperties: false,
    });
  });
});
