/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  LIVE_MESSAGES,
  displayLiveMessage,
  liveMessage,
  liveText,
  type LiveMessageKey,
} from './messages.js';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['vendor', '__tests__', 'testing', 'manual'].includes(entry.name))
      return [];
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && file.endsWith('.ts') && !file.endsWith('.test.ts')
      ? [file]
      : [];
  });
}

describe('fixed display-text integrity', () => {
  it('uses count labels that remain grammatical for a single omitted item', () => {
    for (const key of [
      'subagents.deliveriesOmitted',
      'subagents.reportsOmitted',
      'subagents.sessionsOmitted',
      'subagents.morePermissions',
      'subagents.omitted',
    ] as const) {
      const text = liveText('en', key, { count: 1 });
      expect(text).toContain('1');
      expect(text).not.toMatch(
        /\b1 (?:older |more |other )?(?:instruction deliveries|reports|terminal sessions|pending requests|tasks)\b/u,
      );
    }
  });

  it('keeps one nonempty, well-formed string per supported language and key', () => {
    for (const [key, pair] of Object.entries(LIVE_MESSAGES)) {
      expect(Object.keys(pair).sort(), key).toEqual(['en', 'zh-CN']);
      for (const [language, text] of Object.entries(pair)) {
        // The read-only CLI report intentionally indents its detail rows.
        const displayText = key.startsWith('peers.doctor.')
          ? text.replace(/^ {2}/u, '')
          : text;
        expect(displayText.trim(), `${key}/${language}`).toBe(displayText);
        expect(text.length, `${key}/${language}`).toBeGreaterThan(0);
        expect(text, `${key}/${language}`).not.toContain('\uFFFD');
        expect(text, `${key}/${language}`).not.toContain('\r');
        expect(
          Array.from(text).some((c) => {
            const point = c.codePointAt(0)!;
            return point >= 0xd800 && point <= 0xdfff;
          }),
          `${key}/${language}`,
        ).toBe(false);
      }
    }
  });

  it('round-trips every key and all of its placeholders through the message bridge', () => {
    for (const key of Object.keys(LIVE_MESSAGES) as LiveMessageKey[]) {
      const names = [...LIVE_MESSAGES[key].en.matchAll(/\{(\w+)\}/g)].map(
        (m) => m[1]!,
      );
      const params = Object.fromEntries(
        names.map((name) => [name, '示例 / example']),
      );
      const encoded = liveMessage(key, params);
      for (const language of ['en', 'zh-CN'] as const) {
        expect(
          displayLiveMessage(language, encoded),
          `${key}/${language}`,
        ).toBe(liveText(language, key, params));
        expect(
          liveText(language, key, params),
          `${key}/${language}`,
        ).not.toMatch(/\{\w+\}/u);
      }
    }
  });

  it('does not silently shadow a key with a duplicate object property', () => {
    const source = readFileSync(
      new URL('./messages.ts', import.meta.url),
      'utf8',
    );
    const tree = ts.createSourceFile(
      'messages.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    let catalog: ts.ObjectLiteralExpression | undefined;
    const find = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(tree) === 'LIVE_MESSAGES' &&
        node.initializer
      ) {
        let expression = node.initializer;
        while (
          ts.isAsExpression(expression) ||
          ts.isSatisfiesExpression(expression) ||
          ts.isParenthesizedExpression(expression)
        )
          expression = expression.expression;
        if (ts.isObjectLiteralExpression(expression)) catalog = expression;
      }
      ts.forEachChild(node, find);
    };
    find(tree);
    expect(catalog).toBeDefined();
    const names = catalog!.properties.map((property) => {
      expect(ts.isPropertyAssignment(property)).toBe(true);
      const name = property.name!;
      return ts.isStringLiteralLike(name) ? name.text : name.getText(tree);
    });
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(Object.keys(LIVE_MESSAGES).sort());
  });

  it('resolves every static production call to liveText and liveMessage', () => {
    const roots = [
      fileURLToPath(new URL('../', import.meta.url)),
      fileURLToPath(
        new URL('../../../qwen-live-harness-host/src/', import.meta.url),
      ),
    ];
    const missing: string[] = [];
    let checked = 0;
    for (const file of roots.flatMap(sourceFiles)) {
      const tree = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const index =
            node.expression.text === 'liveText'
              ? 1
              : node.expression.text === 'liveMessage'
                ? 0
                : -1;
          const argument = index < 0 ? undefined : node.arguments[index];
          if (argument && ts.isStringLiteralLike(argument)) {
            checked++;
            if (!Object.hasOwn(LIVE_MESSAGES, argument.text)) {
              const { line } = tree.getLineAndCharacterOfPosition(
                argument.getStart(tree),
              );
              missing.push(`${file}:${line + 1} ${argument.text}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    expect(checked).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});
