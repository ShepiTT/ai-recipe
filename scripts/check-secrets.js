#!/usr/bin/env node
/**
 * 提交前的密钥扫描。
 *
 * 被 .git/hooks/pre-commit 调用，扫的是**暂存区里的内容**（不是工作树），
 * 所以哪怕用 `git add -f` 强行加了被忽略的文件，一样会被拦下来。
 *
 * 手动跑：node scripts/check-secrets.js          （扫暂存区）
 *         node scripts/check-secrets.js --all    （扫全部历史，推之前自查用）
 *
 * 注意：一律用 execFileSync + 参数数组调 git，不要拼 shell 字符串。
 * Windows 下 execSync 走 cmd.exe，正则里的特殊字符和中文路径都会把命令搞坏，
 * 命令失败却被当成「没扫到」，反而给出假的「通过」——这比不扫更危险。
 */
const { execFileSync } = require('child_process');

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

/** 只用参数数组，不经过 shell */
function git(args, { allowFail = true } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1e8 });
  } catch (e) {
    // git grep 没匹配到时退出码为 1，属于正常；其余退出码是真出错了
    if (allowFail && e.status === 1 && !e.stderr) return e.stdout || '';
    if (e.stderr && String(e.stderr).trim()) {
      console.error(`\n⚠️  git ${args.slice(0, 2).join(' ')} 执行失败，扫描结果不可信：`);
      console.error('   ' + String(e.stderr).trim().split('\n')[0]);
      process.exit(2); // 明确失败，不要伪装成通过
    }
    return e.stdout || '';
  }
}

function scanText(text, label, problems) {
  text.split('\n').forEach((line, i) => {
    if (PLACEHOLDER.test(line)) return;
    for (const { name, re } of RULES) {
      const m = line.match(re);
      if (m) problems.push({ rule: name, where: `${label}:${i + 1}  …${m[0].slice(0, 12)}…` });
    }
  });
}

const scanAll = process.argv.includes('--all');
const problems = [];

if (scanAll) {
  // 遍历所有可达对象里的 blob，逐个读内容扫描
  const objects = git(['rev-list', '--objects', '--all']).split('\n').filter(Boolean);
  let blobs = 0;
  for (const line of objects) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue; // 没有路径的是 commit/tree
    const sha = line.slice(0, sp);
    const path = line.slice(sp + 1);
    if (git(['cat-file', '-t', sha]).trim() !== 'blob') continue;
    blobs += 1;
    for (const re of BLOCKED_PATHS) {
      if (re.test(path)) problems.push({ rule: '该文件不该在历史里', where: path });
    }
    scanText(git(['cat-file', 'blob', sha]), path, problems);
  }
  console.log(`扫描了 ${blobs} 个文件对象（全部历史）`);
} else {
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .split('\n').filter(Boolean);

  for (const file of staged) {
    if (BLOCKED_PATHS.some((re) => re.test(file))) {
      problems.push({ rule: '该文件禁止提交', where: file });
      continue;
    }
    scanText(git(['show', `:${file}`]), file, problems);
  }
  console.log(`扫描了 ${staged.length} 个暂存文件`);
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
