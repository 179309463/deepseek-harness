#!/usr/bin/env node
// CodeWalk 准确性校验：代码块必须与 lines 范围内的真实源码逐行一致。
// 用法：pnpm verify
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const atlasRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(atlasRoot, '..');
const chaptersDir = join(atlasRoot, 'src/pages/chapters');

const cwRe = /<CodeWalk\s+file="([^"]+)"(?:\s+lines="([^"]+)")?[^>]*>([\s\S]*?)<\/CodeWalk>/g;
const fenceRe = /```\w*\n([\s\S]*?)```/;

let checked = 0;
const failures = [];

for (const file of readdirSync(chaptersDir).filter((f) => f.endsWith('.mdx'))) {
  const mdx = readFileSync(join(chaptersDir, file), 'utf8');
  for (const match of mdx.matchAll(cwRe)) {
    const [, srcFile, lines, body] = match;
    const fence = body.match(fenceRe);
    if (!fence || !lines) continue;
    // 多文件/多范围拼接块（含注释来源标记）跳过自动校验
    if (srcFile.includes('·') || lines.includes('·')) continue;

    const [startStr, endStr] = lines.split('-');
    const start = Number(startStr);
    const end = Number(endStr ?? startStr);
    if (!Number.isInteger(start)) continue;

    let source;
    try {
      source = readFileSync(join(repoRoot, srcFile), 'utf8').split('\n');
    } catch {
      failures.push(`${file}: 源文件不存在 ${srcFile}`);
      continue;
    }

    const block = fence[1].replace(/\n$/, '').split('\n');
    const slice = source.slice(start - 1, end);
    checked++;

    if (block.length !== slice.length) {
      failures.push(`${file}: ${srcFile}:${lines} 行数不符（代码块 ${block.length} 行 vs 源码 ${slice.length} 行），首行块内「${block[0]?.trim()}」/ 源码「${slice[0]?.trim()}」`);
      continue;
    }
    for (let i = 0; i < block.length; i++) {
      if (block[i].trim() !== slice[i].trim()) {
        failures.push(`${file}: ${srcFile}:${lines} 第 ${start + i} 行不一致\n  块内: ${block[i]}\n  源码: ${slice[i]}`);
        break;
      }
    }
  }
}

console.log(`校验 ${checked} 个 CodeWalk 代码块`);
if (failures.length > 0) {
  console.error(`\n${failures.length} 处不一致：\n`);
  for (const f of failures) console.error(`- ${f}\n`);
  process.exit(1);
}
console.log('全部一致。');
