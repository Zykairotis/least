import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LEAST_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const EXPECTED_NAME = 'least';
const EXPECTED_REPOSITORY = 'git+https://github.com/Zykairotis/least.git';

function canonical(value) {
  try { return realpathSync(value); } catch { return resolve(value); }
}

export function assertLeastReleaseEnvironment({ cwd = process.cwd(), env = process.env } = {}) {
  const actual = canonical(cwd);
  if (actual !== LEAST_ROOT) throw new Error(`Release commands must run from Least root (${LEAST_ROOT}); current directory is ${actual}.`);
  if (env.INIT_CWD && canonical(env.INIT_CWD) !== LEAST_ROOT) throw new Error('INIT_CWD points outside Least release root.');
  const packagePath = resolve(LEAST_ROOT, 'package.json');
  if (env.npm_package_json && canonical(env.npm_package_json) !== canonical(packagePath)) throw new Error('npm is bound to another package.json.');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (pkg.name !== EXPECTED_NAME) throw new Error(`Expected package name ${EXPECTED_NAME}; found ${pkg.name ?? '(missing)'}.`);
  if (pkg.repository?.url !== EXPECTED_REPOSITORY) throw new Error('Repository metadata does not match canonical Least repository.');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')) throw new Error('package.json version is invalid.');
  return { root: LEAST_ROOT, name: pkg.name, version: pkg.version };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const release = assertLeastReleaseEnvironment();
    console.log(`Least release guard: ${release.name}@${release.version}`);
  } catch (error) {
    console.error(`[release guard] ${error.message}`);
    process.exitCode = 1;
  }
}
