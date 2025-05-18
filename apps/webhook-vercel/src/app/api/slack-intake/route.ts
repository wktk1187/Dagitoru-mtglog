import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto'; // cryptoモジュールをインポート

// Slack Signing Secret (環境変数から)
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// Supabaseクライアントの初期化 (環境変数から)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error(
    'Missing Supabase environment variables for slack-intake API.',
    { supabaseUrl: !!supabaseUrl, supabaseServiceRoleKey: !!supabaseServiceRoleKey }
  );
  // サーバー起動時にエラーを投げるか、リクエスト時に返すか。
  // throw new Error("Missing Supabase environment variables"); 
}
if (!SLACK_SIGNING_SECRET) {
  console.error(
    'Missing SLACK_SIGNING_SECRET environment variable for slack-intake API.'
  );
}

const supabaseAdmin: SupabaseClient = createClient(supabaseUrl!, supabaseServiceRoleKey!);

// Helper function to parse date strings (YYYY/MM/DD or YYYY年MM月DD日) to YYYY-MM-DD
// (これは /api/process-task/route.ts にもあるので、共通ライブラリに移動推奨)
function parseDateToISO(dateString: string | null | undefined): string | undefined {
  if (!dateString) return undefined;
  try {
    const parts = dateString.replace(/年|月/g, '/').replace(/日/g, '').split('/');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10);
      const day = parseInt(parts[2], 10);
      if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
        const monthStr = month < 10 ? `0${month}` : `${month}`;
        const dayStr = day < 10 ? `0${day}` : `${day}`;
        return `${year}-${monthStr}-${dayStr}`;
      }
    }
  } catch (e) {
    console.error("Error parsing date in slack-intake:", dateString, e);
  }
  console.warn("Could not parse date string in slack-intake:", dateString, "returning undefined.");
  return undefined;
}

interface ParsedSlackText {
  meetingDate?: string; // YYYY-MM-DD format, parsed by parseDateToISO if a date is found
  consultantName?: string;
  clientName?: string;
  fullText: string; 
}

// Slackからのテキストをパースする関数 (柔軟性を持たせる)
function parseSlackMessageText(text: string | null | undefined): ParsedSlackText {
  const result: ParsedSlackText = { fullText: text || "" };
  if (!text) return result;

  // 1. 日付の抽出 (より多くのパターンに対応)
  const dateRegexes = [
    /(\d{4})[\/\-\.年](\d{1,2})[\/\-\.月](\d{1,2})日?/, // YYYY/MM/DD, YYYY-MM-DD, YYYY.MM.DD, YYYY年MM月DD日
    /日付[:：\s]*(\d{4}[\/\-\.年]\d{1,2}[\/\-\.月]\d{1,2}日?)/, // 「日付: YYYY/MM/DD」
  ];
  for (const regex of dateRegexes) {
    const match = text.match(regex);
    if (match) {
      const dateStr = match[1].includes(':') ? match[1].split(/[:：\s]/).pop() : match[1]; // キーワードがある場合は値部分を取得
      const parsedDate = parseDateToISO(dateStr); // 既存の関数でフォーマット
      if (parsedDate) {
        result.meetingDate = parsedDate;
        break;
      }
    }
  }
  // もし最初のロジックで見つからなければ、テキスト全体から日付っぽいものを探す
  if (!result.meetingDate) {
      const generalDateMatch = text.match(/(\d{4}[\/\-\.年]\d{1,2}[\/\-\.月]\d{1,2}日?)/);
      if (generalDateMatch && generalDateMatch[0]) {
          result.meetingDate = parseDateToISO(generalDateMatch[0]);
      }
  }


  // 2. コンサルタント名、クライアント名の抽出 (キーワードベース)
  // これらのキーワードは実際のSlackメッセージに合わせて調整が必要
  const consultantKeywords = ['コンサルタント名', 'コンサルタント', '担当者', '担当'];
  const clientKeywords = ['クライアント名', 'クライアント', '顧客名', '会社名', '顧客'];

  for (const keyword of consultantKeywords) {
    const regex = new RegExp(`${keyword}[:：\s]*([^\n\s]+)`, 'i'); // キーワードの後の非空白文字を抽出
    const match = text.match(regex);
    if (match && match[1]) {
      result.consultantName = match[1].trim();
      break;
    }
  }

  for (const keyword of clientKeywords) {
    const regex = new RegExp(`${keyword}[:：\s]*([^\n\s]+)`, 'i');
    const match = text.match(regex);
    if (match && match[1]) {
      result.clientName = match[1].trim();
      break;
    }
  }
  
  // フォールバック: もしクライアント名が抽出できず、テキストが短い場合は全体をクライアント名と見なすか検討
  // (今回は行わないが、要件に応じて)

  return result;
}

export async function POST(request: NextRequest) {
  if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Supabase client not initialized. Check server logs.' }, { status: 500 });
  }
  if (!SLACK_SIGNING_SECRET) {
    console.error('SLACK_SIGNING_SECRET is not set. Cannot verify Slack request.');
    return NextResponse.json({ error: 'Server configuration error: Slack signing secret not set.' }, { status: 500 });
  }

  // リクエストボディのクローンを作成して、複数回読み取れるようにする
  const requestCloneForText = request.clone();
  const requestCloneForFormData = request.clone(); // formData用にもう一つクローン

  // Slack署名検証
  const signature = requestCloneForText.headers.get('x-slack-signature');
  const timestamp = requestCloneForText.headers.get('x-slack-request-timestamp');
  
  // 重要: request.text() は Promise を返すため await が必要
  const requestBodyText = await requestCloneForText.text(); 

  if (!signature || !timestamp) {
    return NextResponse.json({ error: 'Missing Slack signature or timestamp headers' }, { status: 400 });
  }

  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - (60 * 5);
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    console.warn('Old Slack request received, potentially a replay attack.');
    return NextResponse.json({ error: 'Slack request timestamp is too old.' }, { status: 403 });
  }

  const sigBasestring = `v0:${timestamp}:${requestBodyText}`;
  const mySignature = `v0=${crypto.createHmac('sha256', SLACK_SIGNING_SECRET)
                              .update(sigBasestring, 'utf8')
                              .digest('hex')}`;

  if (!crypto.timingSafeEqual(Buffer.from(mySignature, 'utf8'), Buffer.from(signature, 'utf8'))) {
    console.warn('Slack signature verification failed.');
    return NextResponse.json({ error: 'Slack signature verification failed.' }, { status: 403 });
  }

  // 署名検証成功
  console.log('Slack signature verified successfully.');

  try {
    // formData を2つ目のクローンから取得
    const formData = await requestCloneForFormData.formData(); 
    const file = formData.get('file') as File | null; 
    const text = formData.get('text') as string | null;   

    if (!file) {
      return NextResponse.json({ error: 'No file provided in the request' }, { status: 400 });
    }

    const parsedTextData = parseSlackMessageText(text);
    const originalFileName = file.name;
    
    const uniqueFileName = `${Date.now()}_${Math.random().toString(36).substring(2, 10)}_${originalFileName}`;
    const filePath = `videos/${uniqueFileName}`.replace(/\s+/g, '_'); 

    const fileBuffer = Buffer.from(await file.arrayBuffer());

    const { data: storageData, error: storageError } = await supabaseAdmin.storage
      .from('videos') 
      .upload(filePath, fileBuffer, {
        contentType: file.type,
        upsert: false, 
      });

    if (storageError) {
      console.error('Error uploading to Supabase Storage:', storageError);
      return NextResponse.json({ error: `Storage error: ${storageError.message}` }, { status: 500 });
    }
    if (!storageData || !storageData.path) {
        return NextResponse.json({ error: 'File uploaded but no path returned from storage.'}, {status: 500 });
    }

    const fullStoragePath = storageData.path; 

    const taskToInsert = {
      storage_path: fullStoragePath, 
      original_file_name: originalFileName,
      status: 'uploaded', 
      meeting_date: parsedTextData.meetingDate, 
      consultant_name: parsedTextData.consultantName, 
      client_name: parsedTextData.clientName, 
    };

    const { data: dbData, error: dbError } = await supabaseAdmin
      .from('transcription_tasks')
      .insert(taskToInsert)
      .select('id') 
      .single(); 

    if (dbError) {
      console.error('Error inserting task into Supabase DB:', dbError);
      // TODO: Consider deleting the uploaded file from storage if DB insert fails (rollback)
      return NextResponse.json({ error: `Database error: ${dbError.message}` }, { status: 500 });
    }

    console.log('Slack intake processed successfully. Task ID:', dbData?.id, 'File:', fullStoragePath);
    return NextResponse.json({
      message: 'File received and task created',
      taskId: dbData?.id,
      filePath: fullStoragePath,
      parsedText: parsedTextData
    });

  } catch (error: any) {
    console.error('Error in /api/slack-intake after signature verification:', error.message, error.stack);
    // エラーレスポンスに error.stack を含めるのは開発時のみに限定すべき
    return NextResponse.json({ error: `Internal server error: Processing failed after signature verification. ${(process.env.NODE_ENV === 'development' && error.message) ? error.message : ''}` }, { status: 500 });
  }
} 