import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'static',
  integrations: [mdx()],
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    // MermaidDiagram 的图源走 slot 文本，smartypants 会把 "-->" 转成破折号、
    // 直引号转成弯引号，导致 mermaid 语法被破坏，必须关闭。
    smartypants: false,
    shikiConfig: {
      theme: 'github-light',
      wrap: false,
    },
  },
});
