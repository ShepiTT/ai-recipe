#!/usr/bin/env node
/**
 * 提交前的密钥扫描。
 *
 * 被 .git/hooks/pre-commit 调用，扫的是**暂存区里的内容**（不是工作树），
 * 所以哪怕用 `git add -f` 强行加了被忽略的文件，一样会被拦下来。
 *
 * 手动跑：node scripts/check-secrets.js          （扫暂存区）
 *         node scripts/check-secrets.js --all    （扫全部历史，推之前自查用）
 */
const { execSync } = require('child_process');

const RULES = [
  { name: 'OpenAI / DeepSeek 风格密钥', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: '阿里云 AccessKey', re: /LTAI[A-Za-z0-9]{12,}/ },
  { name: '微信 AppSecret 疑似赋值', re: /WX_SECRET\s*=\s*[A-Za-z0-9]{16,}/ },
  { name: '密码哈希/盐的真实值', re: /"password(Hash|Salt)"\s*:\s*"[0-9a-f]{16,}"/ },
  { name: '48 位会话 token', re: /"[0-9a-f]{48}"\s*:/ },
];

/** 这些文件永远不该进版本库，出现即拦截 */
const BLOCKED_PATHS = [
  /^\.env$/,
  /^\.env\.local$/,
  /^src\/data\/db\.json$/,
  /^project\.private\.config\.json$/,
];

/** 说明文档里会写 sk-xxxx 这类示例，不该误报 */
const PLACEHOLDER = /sk-(xxx|test-|your|abc|REAL|ATTACKER|例)/i;

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 1e8 });
  } catch (e) {
    return e.stdout || '';
  }
}

const scanAll = process.argv.includes('--all');
const problems = [];

if (scanAll) {
  // 全历史扫描：遍历所有 blob 对象
  const revs = sh('git rev-list --all').trim().split('\n').filter(Boolean);
  for (const { name, re } of RULES) {
    // git grep 的 -E 用 POSIX 语法，把 JS 正则源码转过去够用
    const out = sh(`git grep -InE "${re.source.replace(/"/g, '\\"')}" ${revs.join(' ')}`);
    for (const line of out.split('\n').filter(Boolean)) {
      if (PLACEHOLDER.test(line)) continue;
      problems.push({ rule: name, where: line.slice(0, 160) });
    }
  }
} else {
  // 暂存区扫描
  const staged = sh('git diff --cached --name-only --diff-filter=ACMR').split('\n').filter(Boolean);

  for (const file of staged) {
    for (const re of BLOCKED_PATHS) {
      if (re.test(file)) problems.push({ rule: '该文件禁止提交', where: file });
    }
  }

  for (const file of staged) {
    if (BLOCKED_PATHS.some((re) => re.test(file))) continue;
    const content = sh(`git show ":${file}"`);
    if (!content) continue;
    content.split('\n').forEach((line, i) => {
      if (PLACEHOLDER.test(line)) return;
      for (const { name, re } of RULES) {
        const m = line.match(re);
        if (m) problems.push({ rule: name, where: `${file}:${i + 1}  …${m[0].slice(0, 12)}…` });
      }
    });
  }
}

if (!problems.length) {
  console.log(`✅ 密钥扫描通过（${scanAll ? '全部历史' : '暂存区'}）`);
  process.exit(0);
}

console.error('\n❌ 检测到疑似密钥，提交已阻止：\n');
for (const p of problems) console.error(`   [${p.rule}] ${p.where}`);
console.error(`
处理办法：
  · 误报    → git commit --no-verify 跳过（确认真的是示例再用）
  · 真密钥  → git restore --staged <文件>，把密钥挪进 .env 或 db.json
             这两个文件已在 .gitignore 里，不会被提交
`);
process.exit(1);
