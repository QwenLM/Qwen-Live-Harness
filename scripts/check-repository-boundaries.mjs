import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const rootPackage = json('package.json');
assert.equal(rootPackage.name, 'qwen-live-harness-workspace');
assert.deepEqual(rootPackage.workspaces, ['packages/qwen-live-harness']);
for (const name of ['qwen-live-harness', 'qwen-live-harness-host']) {
  const pkg = json(`packages/${name}/package.json`);
  assert.equal(
    pkg.name,
    name,
    `${name}: package identity must match its directory`,
  );
  if (name === 'qwen-live-harness') {
    assert.deepEqual(pkg.bin, { 'qwen-live-harness': 'dist/index.js' });
  }
  assert.equal(
    pkg.version,
    rootPackage.version,
    `${name} must ship the paired version`,
  );
  for (const [dependency, version] of Object.entries(pkg.dependencies ?? {})) {
    assert(
      !/^(file:|link:|workspace:)/u.test(version),
      `${name}: local runtime dependency ${dependency}`,
    );
    assert(
      !/^@qwen-code\/(sdk|qwen-code|qwen-code-core|acp-bridge)$/u.test(
        dependency,
      ),
      `${name}: bundled harness dependency ${dependency}`,
    );
  }
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'release', '.git'].includes(entry.name))
      return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

for (const directory of ['packages', 'scripts', 'integration-tests']) {
  for (const path of walk(join(root, directory))) {
    if (!/\.(?:[cm]?[jt]sx?)$/u.test(path)) continue;
    const source = readFileSync(path, 'utf8');
    const imports = [];
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        imports.push(node.moduleSpecifier.text);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require')) &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        imports.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const specifier of imports) {
      assert(
        !isAbsolute(specifier),
        `${relative(root, path)}: absolute source import`,
      );
      assert(
        !/^@qwen-code\/(qwen-code|qwen-code-core|acp-bridge)(?:\/|$)/u.test(
          specifier,
        ),
        `${relative(root, path)}: internal Qwen Code import ${specifier}`,
      );
      if (specifier.startsWith('.')) {
        const resolved = resolve(dirname(path), specifier);
        const rel = relative(root, resolved);
        assert(
          rel !== '..' &&
            !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`),
          `${relative(root, path)}: source import leaves repository`,
        );
        assert(
          !/packages\/(?:cli|core|sdk-typescript|electron)\//u.test(
            resolved.replaceAll('\\', '/'),
          ),
          `${relative(root, path)}: import requires Qwen Code checkout`,
        );
      }
    }
  }
}
const sdkManifest = import.meta.resolve('@qwen-code/sdk/package.json');
assert(
  !realpathSync(fileURLToPath(sdkManifest)).includes('sdk-typescript'),
  'SDK must come from registry, not a sibling workspace',
);
console.log(
  'Repository boundaries OK: standalone packages, published SDK, paired version.',
);
