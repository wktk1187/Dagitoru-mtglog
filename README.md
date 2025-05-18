# Slack 動画要約プロジェクト

このプロジェクトは、Slackに投稿された動画を自動で文字起こしし、要約を作成して通知するシステムです。

## 構成

- `apps/webhook-vercel`: Slackイベントを受信し、Supabaseに処理要求を登録するNext.jsアプリケーション (Vercelデプロイ想定)
- `services/transcriber`: 動画の文字起こしと要約を行うPythonバッチ処理
- `scripts`: 補助スクリプト (例: 特定動画の再処理)
- `docs`: 仕様書など

## セットアップと実行

(各サービスごとの詳細を記述)

### `webhook-vercel`

...

### `transcriber`

... 