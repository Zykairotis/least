import { parsePermissionRule, evaluateRules, ruleApplies } from '../dist/permissionRules.js';

/** Assertion helper */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── Parse tests ─────────────────────────────────────────────────

// 1. Valid parse
{
  const rule = parsePermissionRule('Bash(npm run build)');
  assert(rule.kind === 'Bash', `expected Bash kind, got ${rule.kind}`);
  assert(rule.pattern === 'npm run build', `expected pattern "npm run build", got "${rule.pattern}"`);
}

// 2. Tool rule
{
  const rule = parsePermissionRule('Tool(read_many)');
  assert(rule.kind === 'Tool', `expected Tool kind, got ${rule.kind}`);
}

// 3. Invalid parse
{
  try {
    parsePermissionRule('invalid');
    assert(false, 'expected parse failure');
  } catch (e) {
    assert(e.message.includes('Invalid'), `expected invalid error, got: ${e.message}`);
  }
}

// ── ruleApplies tests ───────────────────────────────────────────

// 4. Tool(bash) blocks bash tool
{
  const rule = parsePermissionRule('Tool(bash)');
  assert(ruleApplies(rule, 'bash', {}), 'Tool(bash) should apply to bash');
  assert(!ruleApplies(rule, 'read', {}), 'Tool(bash) should not apply to read');
}

// 5. Bash(command) matches exact command
{
  const rule = parsePermissionRule('Bash(npm run build)');
  assert(ruleApplies(rule, 'bash', { command: 'npm run build' }), 'exact bash match');
  assert(!ruleApplies(rule, 'bash', { command: 'npm run test' }), 'no match for different command');
}

// 6. Bash(command *) matches prefix
{
  const rule = parsePermissionRule('Bash(npm run build *)');
  assert(ruleApplies(rule, 'bash', { command: 'npm run build --prod' }), 'prefix bash match');
  assert(!ruleApplies(rule, 'bash', { command: 'npm run build' }), 'prefix requires trailing args');
  assert(!ruleApplies(rule, 'bash', { command: 'npm run test' }), 'wrong prefix does not match');
}

// 7. Read(path) matches read tool with path
{
  const rule = parsePermissionRule('Read(.env)');
  assert(ruleApplies(rule, 'read', { path: '.env' }), 'Read(.env) applies to read .env');
  assert(ruleApplies(rule, 'read_many', { paths: ['.env'] }), 'Read(.env) applies to read_many with .env in paths');
  assert(!ruleApplies(rule, 'bash', { command: 'pwd' }), 'Read(.env) does not apply to bash');
}

// 8. Edit(src/**) matches edit on src file
{
  const rule = parsePermissionRule('Edit(src/**)');
  assert(ruleApplies(rule, 'edit', { path: 'src/main.ts' }), 'Edit(src/**) applies to edit src/main.ts');
  assert(!ruleApplies(rule, 'edit', { path: 'README.md' }), 'Edit(src/**) does not apply to README.md');
}

// ── evaluateRules tests ─────────────────────────────────────────

// 9. Deny wins over allow
{
  const deny = [parsePermissionRule('Bash(curl *)')];
  const allow = [parsePermissionRule('Bash(curl https://trusted.example.com)')];
  const result = evaluateRules({ deny, allow, toolName: 'bash', toolInput: { command: 'curl https://trusted.example.com' } });
  assert(result.decision === 'deny', `expected deny, got ${result.decision}`);
}

// 10. Ask wins over allow
{
  const ask = [parsePermissionRule('Bash(npm run deploy *)')];
  const allow = [parsePermissionRule('Bash(npm run deploy prod)')];
  const result = evaluateRules({ ask, allow, toolName: 'bash', toolInput: { command: 'npm run deploy prod' } });
  assert(result.decision === 'ask', `expected ask, got ${result.decision}`);
}

// 11. Allow works
{
  const allow = [parsePermissionRule('Bash(npm run build)')];
  const result = evaluateRules({ allow, toolName: 'bash', toolInput: { command: 'npm run build' } });
  assert(result.decision === 'allow', `expected allow, got ${result.decision}`);
}

// 12. No match returns allow with fallback reason
{
  const result = evaluateRules({ toolName: 'bash', toolInput: { command: 'something' } });
  assert(result.decision === 'allow', `expected allow fallback, got ${result.decision}`);
  assert(result.reason?.includes('fallback'), `expected fallback reason, got ${result.reason}`);
}

// 13. Read(.env) works as deny
{
  const deny = [parsePermissionRule('Read(.env)')];
  const result = evaluateRules({ deny, toolName: 'read', toolInput: { path: '.env' } });
  assert(result.decision === 'deny', `expected deny on .env read, got ${result.decision}`);
}

// 14. Tool(bash) deny blocks bash regardless of Bash rule
{
  const toolDeny = [parsePermissionRule('Tool(bash)')];
  const bashAllow = [parsePermissionRule('Bash(pwd)')];
  const result = evaluateRules({ deny: toolDeny, allow: bashAllow, toolName: 'bash', toolInput: { command: 'pwd' } });
  assert(result.decision === 'deny', `expected deny from Tool(bash) rule, got ${result.decision}`);
}

console.log('✓ permissions unit tests passed');
