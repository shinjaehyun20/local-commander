import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256File(relPath) {
  const full = path.join(root, relPath);
  assert.ok(fs.existsSync(full), `Missing manifest-tracked file: ${relPath}`);
  return createHash('sha256').update(fs.readFileSync(full)).digest('hex');
}

test('SOURCE_MANIFEST.json matches every tracked source and test file SHA-256', () => {
  const manifestPath = path.join(root, 'SOURCE_MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(Array.isArray(manifest.copiedSource) && manifest.copiedSource.length > 0);

  for (const entry of manifest.copiedSource) {
    const actual = sha256File(entry.path);
    assert.equal(
      actual,
      entry.repositorySha256,
      `SHA-256 mismatch for ${entry.path}: expected ${entry.repositorySha256}, got ${actual}`
    );
    if (entry.preservedExactly) {
      assert.equal(
        entry.repositorySha256,
        entry.sourceSha256,
        `preservedExactly=true but repositorySha256 != sourceSha256 for ${entry.path}`
      );
    } else {
      assert.ok(
        typeof entry.change === 'string' && entry.change.length > 0,
        `Modified manifest entry ${entry.path} must document its change reason`
      );
    }
  }

  if (manifest.testContractFixture?.path) {
    assert.equal(
      sha256File(manifest.testContractFixture.path),
      manifest.testContractFixture.sha256,
      `SHA-256 mismatch for testContractFixture ${manifest.testContractFixture.path}`
    );
  }
});
