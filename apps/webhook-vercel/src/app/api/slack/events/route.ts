import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Buffer } from 'node:buffer';
import { v4 as uuidv4 } from 'uuid';
import { WebClient } from "@slack/web-api";

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Initialize Supabase Admin Client
let supabaseAdmin: SupabaseClient;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
} else {
  console.error('Supabase environment variables are not fully set for /api/slack/events');
}

async function verifySlackRequest(request: NextRequest) {
  if (!SLACK_SIGNING_SECRET) {
    console.error('Slack Signing Secret is not defined.');
    return false; // 本番環境ではエラーを返すか、厳格な処理を
  }
  const signature = request.headers.get('x-slack-signature');
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const body = await request.text(); // Read the raw body

  if (!signature || !timestamp) {
    return false;
  }

  // リプレイ攻撃を防ぐためにタイムスタンプをチェック (5分以内)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = `v0=${crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(sigBasestring, 'utf8')
    .digest('hex')}`;

  return crypto.timingSafeEqual(Buffer.from(mySignature, 'utf8'), Buffer.from(signature, 'utf8'));
}

// --- Helper function to parse date (can be moved to a shared lib) ---
function parseDateToISO(dateString: string | null | undefined): string | undefined {
  if (!dateString) return undefined;
  try {
    const parts = dateString.replace(/年|月/g, '/').replace(/日/g, '').split('/');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10);
      const day = parseInt(parts[2], 10);
      if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  } catch (e) { console.error("Error parsing date:", dateString, e); }
  return undefined;
}

// --- Helper function to parse Slack message text (can be moved to a shared lib) ---
interface ParsedSlackText {
  meetingDate?: string;
  consultantName?: string;
  clientName?: string;
  fullText: string;
}
function parseSlackMessageText(text: string | null | undefined): ParsedSlackText {
  const result: ParsedSlackText = { fullText: text || "" };
  if (!text) return result;
  // Basic date parsing (YYYY/MM/DD, YYYY-MM-DD, YYYY年MM月DD日)
  const dateMatch = text.match(/(\d{4})[\/\-\.年](\d{1,2})[\/\-\.月](\d{1,2})日?/);
  if (dateMatch) result.meetingDate = parseDateToISO(dateMatch[0]);
  // Basic keyword parsing for consultant and client names
  const consultantMatch = text.match(/(?:コンサルタント名|コンサルタント|担当者|担当)[:：\s]*([^\n\s]+)/i);
  if (consultantMatch && consultantMatch[1]) result.consultantName = consultantMatch[1].trim();
  const clientMatch = text.match(/(?:クライアント名|クライアント|顧客名|会社名|顧客)[:：\s]*([^\n\s]+)/i);
  if (clientMatch && clientMatch[1]) result.clientName = clientMatch[1].trim();
  return result;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.clone().text(); // 検証用にraw bodyを複製
  const reqForVerify = new NextRequest(request.url, {
    headers: request.headers,
    body: Buffer.from(rawBody),
    method: request.method,
    // @ts-ignore // Node.js stream types might not align perfectly with NextRequest internal types
    duplex: 'half' 
  });

  if (!await verifySlackRequest(reqForVerify)) {
    console.warn('Slack request verification failed.');
    return NextResponse.json({ error: 'Request verification failed' }, { status: 403 });
  }

  const data = JSON.parse(rawBody);

  // URL検証チャレンジへの応答
  if (data.type === 'url_verification') {
    console.log('Responding to Slack URL verification challenge');
    return NextResponse.json({ challenge: data.challenge });
  }

  // file_sharedイベントの処理
  if (data.event && data.event.type === 'file_shared') {
    const fileId = data.event.file_id;
    const eventChannelId = data.event.channel_id;
    console.log(`Received file_shared event for file_id: ${fileId} in channel: ${eventChannelId}`);

    try {
      // Slack Web APIクライアントを初期化
      const slackToken = process.env.SLACK_BOT_TOKEN;
      if (!slackToken) {
        console.error("SLACK_BOT_TOKEN is not set.");
        return NextResponse.json(
          { error: "Slack Bot Token not configured" },
          { status: 500 }
        );
      }
      const slackClient = new WebClient(slackToken);

      // files.info APIを呼び出してファイル詳細情報を取得
      const fileInfoResponse = await slackClient.files.info({ file: fileId });

      if (!fileInfoResponse.ok || !fileInfoResponse.file) {
        console.error("Failed to retrieve file info from Slack API:", fileInfoResponse.error);
        return NextResponse.json(
          { error: "Failed to retrieve file info" },
          { status: 500 }
        );
      }

      const fileData = fileInfoResponse.file; // 完全なファイルオブジェクト
      console.log("Successfully retrieved file info:", JSON.stringify(fileData, null, 2));

      if (!fileData.url_private_download) { // ダウンロードURLをチェック
        console.error('url_private_download not found in file info.', fileData);
        return NextResponse.json({ error: 'File download URL not found' }, { status: 400 });
      }
      
      // Slackメッセージテキストの取得 (initial_comment が fileData に含まれることを期待)
      const messageText = fileData.initial_comment && fileData.initial_comment.comment
        ? fileData.initial_comment.comment
        : ""; // コメントがない場合は空文字

      const parsedMessage = parseSlackMessageText(messageText);

      const downloadUrl = fileData.url_private_download;
      const originalFileName = fileData.name || 'unknown_file';
      const fileType = fileData.mimetype || 'application/octet-stream';
      // 拡張子は fileData.filetype から取得し、なければMIMEタイプから推測するかデフォルト値を設定
      // 一般的な動画・音声形式を考慮
      let fileExtension = fileData.filetype || 'dat';
      if (fileType.startsWith('video/')) {
        fileExtension = fileType.split('/')[1];
      } else if (fileType.startsWith('audio/')) {
        fileExtension = fileType.split('/')[1] === 'mpeg' ? 'mp3' : fileType.split('/')[1];
      }
      if (fileExtension === 'quicktime') fileExtension = 'mov';

      const taskId = uuidv4(); // タスクIDを先に生成
      const storagePath = `uploads/${taskId}.${fileExtension}`; // storagePath に taskId を含める

      console.log(`Attempting to download from: ${downloadUrl}`);
      console.log(`File info: name=${originalFileName}, type=${fileType}, ext=${fileExtension}, storagePath=${storagePath}`);
      console.log(`Parsed text: Meeting Date: ${parsedMessage.meetingDate}, Consultant: ${parsedMessage.consultantName}, Client: ${parsedMessage.clientName}`);

      if (!SLACK_BOT_TOKEN) {
        console.error('SLACK_BOT_TOKEN is not set.');
        return NextResponse.json({ error: 'SLACK_BOT_TOKEN is not configured on the server.' }, { status: 500 });
      }
      if (!supabaseAdmin) {
        console.error('Supabase client is not initialized.');
        return NextResponse.json({ error: 'Supabase client is not initialized on the server.' }, { status: 500 });
      }

      const response = await fetch(downloadUrl, {
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        },
      });

      if (!response.ok || !response.body) {
        console.error(`Failed to download file from Slack: ${response.status} ${response.statusText}`);
        const errorBody = await response.text();
        console.error("Slack download error body:", errorBody);
        return NextResponse.json({ error: 'Failed to download file from Slack' }, { status: response.status });
      }

      const fileBuffer = await response.arrayBuffer();
      console.log(`File downloaded successfully. Size: ${fileBuffer.byteLength} bytes. Uploading to Supabase...`);

      // Supabase Storageへアップロード (videos バケットを想定)
      const { data: uploadResult, error: uploadError } = await supabaseAdmin.storage
        .from('videos') // バケット名を 'videos' に指定
        .upload(storagePath, fileBuffer, {
          contentType: fileType,
          upsert: false, // 同名ファイルが存在する場合はエラー (taskIdベースなので基本重複しないはず)
        });

      if (uploadError) {
        console.error('Failed to upload to Supabase Storage:', uploadError);
        return NextResponse.json({ error: `Failed to upload to Supabase Storage: ${uploadError.message}` }, { status: 500 });
      }
      console.log('File uploaded to Supabase Storage:', uploadResult);

      // transcription_tasks テーブルへ挿入
      const taskToInsert = {
        id: taskId,
        storage_path: storagePath, // storagePathは バケット名を含まないパス
        original_file_name: originalFileName,
        status: 'pending', // 初期ステータス
        meeting_date: parsedMessage.meetingDate, // parseDateToISO済みの形式
        consultant_name: parsedMessage.consultantName,
        client_name: parsedMessage.clientName,
        // created_at, updated_at はDBのデフォルトまたはトリガーで設定される想定
      };

      const { data: dbTask, error: dbError } = await supabaseAdmin
        .from('transcription_tasks')
        .insert([taskToInsert])
        .select() // 挿入したデータを返すようにselect()を追加
        .single(); // 1行だけ挿入するのでsingle()

      if (dbError) {
        console.error('Failed to insert transcription task to DB:', dbError);
        // ここでアップロードしたファイルを削除する処理も検討できる
        return NextResponse.json({ message: "File uploaded but task creation failed.", error: dbError.message }, { status: 500 });
      }
      console.log('Transcription task inserted to DB:', dbTask);

      return NextResponse.json({
        message: 'File processed and task created successfully.',
        taskId: taskId,
        storagePath: storagePath,
        dbTask: dbTask
      }, { status: 200 });

    } catch (error: any) { // errorをany型としてキャッチ
      console.error('Error processing file_shared event:', error);
      // errorがErrorインスタンスか確認してメッセージを取得
      const errorMessage = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: 'Internal server error', details: errorMessage }, { status: 500 });
    }
  }

  console.log("Received Slack event, but not a file_shared or url_verification event", data.event ? data.event.type : "No event type or unknown structure");
  return NextResponse.json({ message: 'Event received but not processed' });
} 