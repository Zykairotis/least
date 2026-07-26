import assert from 'node:assert/strict';
import { assertLeastReleaseEnvironment, LEAST_ROOT } from './release-guard.mjs';

const release = assertLeastReleaseEnvironment({ cwd: LEAST_ROOT, env: {} });
assert.equal(release.name, 'least');
assert.throws(() => assertLeastReleaseEnvironment({ cwd: '/tmp', env: {} }), /Least root/);
assert.throws(() => assertLeastReleaseEnvironment({ cwd: LEAST_ROOT, env: { npm_package_json: '/tmp/package.json' } }), /another package/);
console.log('release-guard-unit: ok');
