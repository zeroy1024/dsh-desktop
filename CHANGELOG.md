# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-09-06

### Added

- 文件浏览的 Markdown 预览改为文档级渲染：标题、目录、仓内链接可跳转，代码块走宿主 CodeBlock。

### Changed

- 用量统计明细表去掉无数据的推理列，表头和单元格居中，用量占比只保留百分比。
- 用量统计趋势图只保留近 7 日 / 近 30 日（默认 7 日），X 轴按日历铺满所选窗口。

### Fixed

- 用量统计改为与会话底栏同一套计费口径：不再因空 step、缺 `totalTokens` 或缺缓存桶把整轮用量丢掉。

[0.1.2]: https://github.com/zeroy1024/dsh-desktop/compare/v0.1.1...v0.1.2
