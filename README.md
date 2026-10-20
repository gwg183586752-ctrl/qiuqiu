# qiuqiu

项目已初始化 Git、OpenSpec 和 Matt Pocock skills。当前尚未选择应用技术栈。

## 目录

- `demo/`：演示代码。
- `docs/`：项目文档。
- `openspec/`：需求规格、变更计划和归档。
- `.agents/skills/`：项目内的 Codex skills。

## OpenSpec

使用本机已安装的 OpenSpec CLI 1.14.1，项目配置采用 `spec-driven` schema，产出语言为简体中文。

在 Codex 对话中使用：

```text
$openspec-explore 讨论一个需求
$openspec-propose 描述要实现的功能
$openspec-apply-change 实现已经规划的变更
$openspec-archive-change 归档已完成的变更
```

在终端查看变更和规格：

```powershell
openspec list
openspec list --specs
```

## Matt Pocock skills

已安装官方工程和生产力目录中的 27 个 skills，例如 `$ask-matt`、`$grill-with-docs`、`$tdd`、`$code-review` 和 `$implement`。新安装的 skills 从下一轮对话起可用。

来源与版本记录在 `.agents/skill-sources.json`，原始许可见 `.agents/MATT-POCOCK-LICENSE`。

安装来源：[OpenSpec](https://github.com/Fission-AI/OpenSpec) 和 [Matt Pocock skills](https://github.com/mattpocock/skills)。
