# theme-factory（收录副本）

来源：[`anthropics/skills` → `skills/theme-factory`](https://github.com/anthropics/skills/tree/main/skills/theme-factory)
许可：Apache-2.0（`LICENSE.txt` 为上游原文）。

收录原因：它提供 10 套**配色 + 字体配对**的现成主题，还有一条更重要的指引——
**没有合适主题时，允许基于输入自定义一套**。

## 为什么没有直接套其中一套

这 10 套是为**幻灯片/文档**设计的：每套 4 个颜色、字体固定 DejaVu Sans、没有深色模式。
数据看板需要的是：三级文字都要过 4.5:1、数字等宽对齐、语义色（正常/告警）、明暗两套 token。

最终三个页面的视觉按**主流 SaaS 看板**做（Vercel token + 吸顶导航），见 [`themes/dashboard.md`](../../themes/dashboard.md)。
这里的 10 套主题保留作参考，未直接采用。
