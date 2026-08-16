#!/usr/bin/env node
// 对删节/拼接的 CodeWalk，按指定起止行用源码原文整体替换 fence。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const atlasRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(atlasRoot, '..');

const jobs = [
  { mdx: '01-plugin-universe.mdx', src: 'vendor/cordis/src/registry.ts', start: 316, end: 336 },
  { mdx: '03-capability-seam.mdx', src: 'packages/shell/shell/src/index.ts', start: 40, end: 68 },
  { mdx: '03-capability-seam.mdx', src: 'packages/shell/shell/src/types.ts', start: 38, end: 90 },
  { mdx: '03-capability-seam.mdx', src: 'packages/shell/bash-local/src/index.ts', start: 146, end: 171 },
  { mdx: '04-session-memory.mdx', src: 'packages/core/session/src/types.ts', start: 33, end: 56 },
  { mdx: '04-session-memory.mdx', src: 'packages/core/session/src/types.ts', start: 343, end: 374 },
  { mdx: '04-session-memory.mdx', src: 'packages/core/session/src/surface.ts', start: 83, end: 114 },
  { mdx: '05-agent-loop.mdx', src: 'packages/core/agent/src/runtime-types.ts', start: 219, end: 244 },
  { mdx: '05-agent-loop.mdx', src: 'packages/core/agent-loop/src/agent.ts', start: 262, end: 301 },
  { mdx: '05-agent-loop.mdx', src: 'packages/core/agent-loop/src/agent.ts', start: 339, end: 400 },
  { mdx: '05-agent-loop.mdx', src: 'packages/core/agent-loop/src/tool-calls.ts', start: 59, end: 101 },
];

for (const job of jobs) {
  const srcLines = readFileSync(join(repoRoot, job.src), 'utf8').split('\n');
  const exact = srcLines.slice(job.start - 1, job.end).join('\n');
  const mdxPath = join(atlasRoot, 'src/pages/chapters', job.mdx);
  let mdx = readFileSync(mdxPath, 'utf8');

  const re = new RegExp(
    `(<CodeWalk\\s+file="${job.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+lines=")[^"]+("[\\s\\S]*?\\n)\\\`\\\`\\\`\\w*\\n[\\s\\S]*?\\\`\\\`\\\``,
    'm',
  );
  const next = mdx.replace(re, (full, a, b) => {
    // 只替换「尚未对齐」的那一个：若 lines 已经是目标范围且内容已精确，跳过
    return `${a}${job.start}-${job.end}${b}\`\`\`ts\n${exact}\n\`\`\``;
  });
  if (next === mdx) {
    console.error(`未匹配: ${job.mdx} ${job.src}`);
    process.exitCode = 1;
    continue;
  }
  // 上面的正则会替换该 file 的第一个 CodeWalk。同一文件两个范围时按顺序跑，
  // 先处理较小 start 的（types.ts 33 然后 343；agent.ts 262 然后 339）。
  writeFileSync(mdxPath, next);
  console.log(`已替换 ${job.mdx} ← ${job.src}:${job.start}-${job.end}`);
}
