# Wiki 图形资源

每张 Wiki 图保留三种格式：

| 格式 | 用途 |
| --- | --- |
| `.mmd` | Mermaid CLI 的可维护源文件 |
| `.svg` | Wiki 页面和 GitLab 的默认展示格式 |
| `png/*.png` | 需要 PNG 下载、演示文稿或图片附件时使用 |

PNG 位于当前目录的 `png/` 子目录，与 SVG 一一对应。所有 PNG 都由 Mermaid CLI 直接从同名 `.mmd` 生成，不是对 SVG 截图。

## 图形清单

| 图 | Mermaid source | SVG | PNG |
| --- | --- | --- | --- |
| 产品总览 | [mmd](./product-overview.mmd) | [svg](./product-overview.svg) | [png](./png/product-overview.png) |
| 产品层与执行层边界 | [mmd](./architecture-boundaries.mmd) | [svg](./architecture-boundaries.svg) | [png](./png/architecture-boundaries.png) |
| 一次任务生命周期 | [mmd](./run-lifecycle.mmd) | [svg](./run-lifecycle.svg) | [png](./png/run-lifecycle.png) |
| 四层嵌套 | [mmd](./engine-layers.mmd) | [svg](./engine-layers.svg) | [png](./png/engine-layers.png) |
| 四层调用时序 | [mmd](./layer-call-sequence.mmd) | [svg](./layer-call-sequence.svg) | [png](./png/layer-call-sequence.png) |
| Prompt 组装 | [mmd](./prompt-flow.mmd) | [svg](./prompt-flow.svg) | [png](./png/prompt-flow.png) |
| Context 注入 | [mmd](./context-flow.mmd) | [svg](./context-flow.svg) | [png](./png/context-flow.png) |
| Context Budget | [mmd](./context-budget.mmd) | [svg](./context-budget.svg) | [png](./png/context-budget.png) |
| Harness 执行与验证 | [mmd](./harness-flow.mmd) | [svg](./harness-flow.svg) | [png](./png/harness-flow.png) |
| Loop 状态图 | [mmd](./loop-graph.mmd) | [svg](./loop-graph.svg) | [png](./png/loop-graph.png) |
| Loop 事件与证据 | [mmd](./loop-events.mmd) | [svg](./loop-events.svg) | [png](./png/loop-events.png) |
| 数据与审计 | [mmd](./data-and-audit.mmd) | [svg](./data-and-audit.svg) | [png](./png/data-and-audit.png) |
| 路线图 | [mmd](./status-roadmap.mmd) | [svg](./status-roadmap.svg) | [png](./png/status-roadmap.png) |

## 重新生成

在 Wiki 根目录执行：

```sh
for source in wiki/diagrams/*.mmd; do
  name="${source##*/}"
  name="${name%.mmd}"
  npx --yes -p @mermaid-js/mermaid-cli mmdc -i "$source" -o "wiki/diagrams/${name}.svg" -b transparent
  npx --yes -p @mermaid-js/mermaid-cli mmdc -i "$source" -o "wiki/diagrams/png/${name}.png" -b transparent -s 2
done
```
