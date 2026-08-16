# DSH 源码图鉴（dsh-code-atlas）

「哆啦A梦带队读源码」—— deepseek-harness 仓库的深度源码分析静态网站。Astro 5 + MDX + Tailwind v4 + Mermaid，亮白模式，纯静态输出。

## 本地开发

```sh
pnpm install
pnpm dev      # 开发预览
pnpm build    # 输出静态站到 dist/
pnpm preview  # 本地预览构建产物
```

## 目录

```
research/          源码研究笔记（写作素材，不参与构建）
src/pages/         页面（index + chapters/0X-*.mdx + appendix/*）
src/components/    CodeWalk / MermaidDiagram / ArtFigure / StoryStrip / EventRiver / SourceRef
src/layouts/       Base（站点骨架）/ Chapter（章节骨架）
public/art/        丝网印刷绘本风插画（webp）：首页主视觉、chNN-hero、chNN-art、附录横幅、页脚长条
```

## 插画资产

- 风格：米白纸底 + 半调网点 + 2px 墨蓝描边的丝网印刷绘本感，与 comic-ppt 的科技杂志风刻意区分。
- `chNN-hero.webp` 由 `Chapter.astro` 根据章号自动取用，中文 alt 写在该布局的 `HERO_ALT` 里；新增章节需同时补上两者。
- `chNN-art.webp` 通过 `ArtFigure` 插在本章源码地图的 UML 下方，跟 UML 讲同一件事：上图讲机制，下图讲意象。
- 图片统一压成 webp（宽边 ≤ 2000px，q80），首屏以外均 `loading="lazy"`。

## 部署到 Railway

1. Railway 新建项目，选择本仓库，将 **Root Directory** 设为 `dsh-code-atlas`。
2. `railway.toml` 已配置 nixpacks：`pnpm install --frozen-lockfile && pnpm build`，启动 `pnpm start`（serve 托管 `dist/`）。
3. Node 版本要求 `^22.19 || >=24`（nixpacks 会读取 `package.json` 的 `engines`）。

## 写作约定

- 每个代码论点必须带 `CodeWalk`（文件路径 + 行号 + 真实代码片段）。
- UML 一律用 `MermaidDiagram`，禁止外链图片。
- 章节骨架：漫画条开场 → 源码地图 → CodeWalk 精读 → 运行机制图 → 动手实验 → 胖虎翻车现场 → 小结卡。
- 全站亮白模式，不要引入暗色主题。
