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
  // 起動時のエラーとして記録し、リクエスト処理時には supabaseAdmin の存在をチェックする
  console.error('Supabase environment variables are not fully set for /api/slack/events at startup.');
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
    // @ts-ignore
    duplex: 'half' 
  });

  if (!await verifySlackRequest(reqForVerify)) {
    console.warn(`[${new Date().toISOString()}] Slack request verification failed.`);
    return NextResponse.json({ error: 'Request verification failed' }, { status: 403 });
  }

  const data = JSON.parse(rawBody);

  // URL検証チャレンジへの応答
  if (data.type === 'url_verification') {
    console.log(`[${new Date().toISOString()}] Responding to Slack URL verification challenge`);
    return NextResponse.json({ challenge: data.challenge });
  }

  // file_sharedイベントの処理
  if (data.event && data.event.type === 'file_shared') {
    const fileId = data.event.file_id;
    const eventChannelId = data.event.channel_id; // 後で通知などに使える可能性
    console.log(`[${new Date().toISOString()}] Received file_shared event for file_id: ${fileId} in channel: ${eventChannelId}`);

    try {
      // Supabaseクライアントが初期化されているか確認
      if (!supabaseAdmin) {
        console.error(`[${new Date().toISOString()}] Supabase client is not initialized. Cannot process event.`);
        return NextResponse.json({ error: 'Server configuration error: Supabase client not available.' }, { status: 500 });
      }

      const slackToken = process.env.SLACK_BOT_TOKEN;
      if (!slackToken) {
        console.error(`[${new Date().toISOString()}] SLACK_BOT_TOKEN is not set.`);
        return NextResponse.json(
          { error: "Slack Bot Token not configured" },
          { status: 500 }
        );
      }
      const slackClient = new WebClient(slackToken);

      console.log(`[${new Date().toISOString()}] Calling files.info for fileId: ${fileId}`);
      const fileInfoResponse = await slackClient.files.info({ file: fileId });

      if (!fileInfoResponse.ok || !fileInfoResponse.file) {
        console.error(`[${new Date().toISOString()}] Failed to retrieve file info from Slack API for fileId ${fileId}:`, fileInfoResponse.error);
        return NextResponse.json(
          { error: "Failed to retrieve file info from Slack" },
          { status: 500 }
        );
      }

      const fileData = fileInfoResponse.file;
      console.log(`[${new Date().toISOString()}] Successfully retrieved file info for ${fileId}:`, fileData.name);

      if (!fileData.url_private_download) {
        console.error(`[${new Date().toISOString()}] url_private_download not found in file info for ${fileId}.`, fileData);
        return NextResponse.json({ error: 'File download URL not found in Slack file info' }, { status: 400 });
      }
      
      const messageText = fileData.initial_comment && fileData.initial_comment.comment
        ? fileData.initial_comment.comment
        : "";

      const parsedMessage = parseSlackMessageText(messageText);
      const taskId = uuidv4();

      console.log(`[${new Date().toISOString()}] Attempting to insert task ${taskId} into DB with status 'upload_pending'.`);

      const taskToInsert = {
        id: taskId,
        original_file_name: fileData.name || 'unknown_file',
        slack_file_id: fileId,
        slack_download_url: fileData.url_private_download, // Supabase Functionが使用
        mimetype: fileData.mimetype || 'application/octet-stream',
        filetype: fileData.filetype || 'dat', // Supabase Function側でより詳細な拡張子決定も可能
        status: 'upload_pending', // Supabase Functionによるアップロード待ち
        meeting_date: parsedMessage.meetingDate,
        consultant_name: parsedMessage.consultantName,
        client_name: parsedMessage.clientName,
        // created_at, updated_at はDBのデフォルトまたはトリガーで設定
        // storage_path は Supabase Function が設定
      };

      const { data: dbResult, error: dbError } = await supabaseAdmin
        .from('transcription_tasks')
        .insert([taskToInsert])
        .select()
        .single();

      if (dbError) {
        console.error(`[${new Date().toISOString()}] Failed to insert task ${taskId} to DB:`, dbError);
        return NextResponse.json({ message: "Failed to create transcription task.", error: dbError.message }, { status: 500 });
      }
      
      console.log(`[${new Date().toISOString()}] Task ${taskId} inserted to DB successfully with status 'upload_pending'. DB Result:`, dbResult);

      return NextResponse.json({
        message: 'Request received. File upload will be processed asynchronously.',
        taskId: taskId,
      }, { status: 202 }); // 202 Accepted: リクエストは受理されたが処理は完了していない

    } catch (error: any) {
      const taskIdForErrorLog = "unknown_task_id_at_catch"; // taskIdが取れない場合もあるため
      console.error(`[${new Date().toISOString()}] Error processing file_shared event for ${taskIdForErrorLog}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: 'Internal server error during event processing', details: errorMessage }, { status: 500 });
    }
  }

  console.log(`[${new Date().toISOString()}] Received Slack event, but not a file_shared or url_verification event. Type:`, data.event ? data.event.type : "No event type");
  return NextResponse.json({ message: 'Event received but not processed by this handler' });
} 