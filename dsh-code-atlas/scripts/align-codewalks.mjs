#!/usr/bin/env node
// 把每个 CodeWalk 代码块对齐到仓库真实源码：
// 1. 在源文件中定位代码块（忽略行首缩进）
// 2. 把 lines 改成真实起止行
// 3. 用源码原文（含缩进）替换代码块
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const atlasRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(atlasRoot, '..');
const chaptersDir = join(atlasRoot, 'src/pages/chapters');

const trim = (s) => s.replace(/^\s+/, '').replace(/\s+$/, '');

function findSlice(source, block) {
  const needle = block.map(trim).filter((l) => l.length > 0);
  if (needle.length === 0) return null;
  const src = source.map(trim);
  for (let i = 0; i <= src.length - needle.length; i++) {
    let ok = true;
    let j = 0;
    let k = i;
    while (j < needle.length && k < src.length) {
      if (src[k] === '') { k++; continue; }
      if (src[k] !== needle[j]) { ok = false; break; }
      j++;
      k++;
    }
    if (ok && j === needle.length) {
      // 回落到包含空行的真实范围：从 i 到最后一个匹配行
      let end = i;
      j = 0;
      k = i;
      while (j < needle.length && k < src.length) {
        if (src[k] === '') { k++; continue; }
        if (src[k] === needle[j]) { end = k; j++; }
        k++;
      }
      return { start: i + 1, end: end + 1 };
    }
  }
  return null;
}

let fixed = 0;
const unresolved = [];

for (const file of readdirSync(chaptersDir).filter((f) => f.endsWith('.mdx'))) {
  const path = join(chaptersDir, file);
  let mdx = readFileSync(path, 'utf8');
  const cwRe = /<CodeWalk\s+file="([^"]+)"(?:\s+lines="([^"]+)")?([^>]*)>([\s\S]*?)<\/CodeWalk>/g;

  mdx = mdx.replace(cwRe, (full, srcFile, lines, rest, body) => {
    if (!lines || srcFile.includes('·') || lines.includes('·')) return full;
    const fence = body.match(/```(\w*)\n([\s\S]*?)```/);
    if (!fence) return full;
    const lang = fence[1] || 'ts';
    const block = fence[2].replace(/\n$/, '').split('\n');
    let source;
    try {
      source = readFileSync(join(repoRoot, srcFile), 'utf8').split('\n');
      if (source[source.length - 1] === '') source.pop();
    } catch {
      unresolved.push(`${file}: 源文件不存在 ${srcFile}`);
      return full;
    }

    const loc = findSlice(source, block);
    if (!loc) {
      unresolved.push(`${file}: 无法在 ${srcFile} 中定位代码块（原 lines=${lines}，首行「${trim(block[0] || '')}」）`);
      return full;
    }

    const exact = source.slice(loc.start - 1, loc.end).join('\n');
    const newLines = loc.start === loc.end ? String(loc.start) : `${loc.start}-${loc.end}`;
    const newBody = body.replace(/```\w*\n[\s\S]*?```/, `\`\`\`${lang}\n${exact}\n\`\`\``);
    if (newLines !== lines || fence[2].replace(/\n$/, '') !== exact) {
      fixed++;
      console.log(`  ${file}: ${srcFile} ${lines} → ${newLines} (${loc.end - loc.start + 1} 行)`);
    }
    return `<CodeWalk file="${srcFile}" lines="${newLines}"${rest}>${newBody}</CodeWalk>`;
  });

  writeFileSync(path, mdx);
}

console.log(`\n已对齐 ${fixed} 个代码块`);
if (unresolved.length) {
  console.error(`\n未能自动定位 ${unresolved.length} 处：`);
  for (const u of unresolved) console.error(`- ${u}`);
  process.exit(1);
}
