# 詳細仕様書：Slack動画要約ボット

## 🛠 使用技術・サービス詳細

| 項目       | 技術/サービス                         | 備考 |
|------------|----------------------------------------|------|
| 動画送信元   | Slack Bot                            | Events API, `file_shared` イベント使用 |
| Webhook受信 | Vercel (Next.js API Routes)          | 認証不要で簡便、Slack署名検証あり |
| ストレージ   | Supabase Storage                     | `uploadFromUrl`を利用 |
| 音声認識     | Whisper（Python）                    | `base` or `medium` モデル推奨 |
| 要約        | Gemini API (Generative Language API) | Gemini 1.5 Pro または Gemini 1.0 |
| 通知/登録先 | Slack API / Notion API               | 要約結果を通知 or 永続化保存 |

---

## 📂 ストレージ設計（Supabase）

| パス                            | 内容                     |
|---------------------------------|--------------------------|
| `/uploads/{uuid}.mp4`           | Slackから取得した元動画 |
| `/transcripts/{uuid}.txt`       | Whisperによる文字起こし |
| `/summaries/{uuid}.md`          | Gemini要約文             |

---

## 🔄 各処理詳細

### 1. Slack Webhook受信
- `@slack/events-api` で `file_shared` を受信
- Slackファイルメタ情報 (`url_private`, `id`, `name`) を取得
- Slack Bot Token による認証DL（Bearer Token）

### 2. Supabase Storageアップロード
- Vercel内で `fetch()` によりSlackから動画DL
- `supabase.storage.from().upload()` で `/uploads/{uuid}` に保存
- 成功時、UUIDでファイルIDを返却・ログ出力

### 3. Whisper（Python）による文字起こし
- Supabaseの `/uploads/*.mp4` をDL
- Whisperで `.mp4` を `.txt` に変換
- ファイル出力 `/transcripts/{uuid}.txt`
- Whisperエラー時はログ + Slack通知

### 4. Gemini APIによる要約
- Whisper出力（最大8000字）をプロンプトに挿入
- Gemini呼び出し用JSON構造を組み立て
- `/summaries/{uuid}.md` に出力

### 5. Slack通知 or Notion登録
- Slack: `chat.postMessage` で通知（ファイル名 + 要約 + GCSリンク）
- Notion: `pages.create()` で要約結果をDBに追加

---

## ✅ 完了要件（精緻化）

| 項目 | 完了条件 |
|------|----------|
| Slack Webhook連携 | `file_shared` イベントを正しく受信し、ファイルメタデータを取得できる |
| 動画保存           | Slackの `url_private` から動画を取得し、Supabaseに保存できる（UUID命名） |
| Whisper処理        | 保存動画を正確に文字起こしし、最大誤差5%以内で出力可能 |
| Gemini要約         | Geminiでの要約結果が最低70%以上の精度で概要を捉えている |
| Slack通知           | 要約文をSlackに送信、リンクが有効であること |
| Notion登録          | タイトル/本文形式でDBに登録。文字起こし全文リンク付き |
| エラーハンドリング  | DL・変換・APIエラー発生時にSlackでアラートが飛ぶ |
| CLI再処理           | UUID指定で再度Whisper + 要約処理が可能なCLIスクリプト存在 |
| ログ記録           | 各工程のログが Supabase Functions または Vercel Log に残ること |

---

## 🧪 テスト項目（抜粋）

- [ ] Slack でファイル共有 → webhook 発火を確認
- [ ] Supabase に動画保存確認（サイズ1.5GBまで対応）
- [ ] Whisper により正確に文字起こしされる
- [ ] Gemini で要約が返る（3文以上で意味が通る）
- [ ] Slack/Notion に通知・登録できる

## 機能要件

## 非機能要件

## システム構成図

## API仕様

### Slack Events API 受信エンドポイント

## データモデル 