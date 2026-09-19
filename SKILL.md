---
name: better-ask-picker
description: 質問の概要を表示しつつ、選択肢を全件1画面に出して1つまたは複数選ばせたいときに使う。mcp__better-ask-picker__pick ツールを登録するプラグイン（spike）。選択肢が5個以上、または複数選択（multiSelect）が必要な場合に使う。
---

# better-ask-picker

`mcp__better-ask-picker__pick` を呼ぶと、専用ペインに質問の概要と全選択肢を表示する。

- `question`: 質問文（必須）
- `summary`: 質問の概要・背景（Markdown、任意）
- `options`: `[{ label, description? }]`（2個以上、上限なし）
- `multiSelect`: true で複数選択（決定ボタンで確定）

戻り値は JSON 文字列 `{"selected":["A","C"]}`。キャンセル時は `{"selected":[],"cancelled":true}`。

ターミナル幅が144列未満などでペインを出せない場合は、ネイティブの質問ダイアログ（4択ずつ）に自動でフォールバックする。
