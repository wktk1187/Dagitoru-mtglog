import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai'; // Gemini, HarmBlockThreshold追加
import { Buffer } from 'node:buffer'; // Node.js組み込みモジュールとして明示
import { File } from 'formdata-node'; // Whisper APIへのファイル渡しのため追加
import { Client as NotionClient, APIErrorCode, isNotionClientError } from '@notionhq/client'; // Notion, APIErrorCode, isNotionClientError を追加
import type { CreatePageParameters } from '@notionhq/client/build/src/api-endpoints'; // Notionページプロパティ型
import process from "node:process"; // Deno lint: no-process-global の対応

// 環境変数のチェックとSupabaseクライアントの初期化
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY; // SERVICE_ROLE_KEY から ANON_KEY に変更
const openaiApiKey = process.env.OPENAI_API_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY; // Gemini APIキー
const notionApiKey = process.env.NOTION_API_KEY; // Notion APIキー

// Notion Database IDs from environment variables
const NOTION_DB_ID_1 = process.env.NOTION_DB_ID_1;
const NOTION_DB_ID_2 = process.env.NOTION_DB_ID_2;
const NOTION_DB_ID_3 = process.env.NOTION_DB_ID_3;

if (!supabaseUrl || !supabaseAnonKey || !openaiApiKey || !geminiApiKey || !notionApiKey ||
    !NOTION_DB_ID_1 || !NOTION_DB_ID_2 || !NOTION_DB_ID_3
   ) {
  console.error(
    'Missing environment variables:',
    {
      supabaseUrl: !!supabaseUrl,
      supabaseAnonKey: !!supabaseAnonKey, // supabaseServiceRoleKey から変更
      openaiApiKey: !!openaiApiKey,
      geminiApiKey: !!geminiApiKey,
      notionApiKey: !!notionApiKey,
      notionDbId1: !!NOTION_DB_ID_1,
      notionDbId2: !!NOTION_DB_ID_2,
      notionDbId3: !!NOTION_DB_ID_3
    }
  );
  // POSTハンドラ内で主要なチェックと早期リターンがあるため、ここでの throw new Error はコメントアウトのままにします。
  // アプリケーション起動時にログで確認できることが重要です。
}

const supabase: SupabaseClient = createClient(supabaseUrl!, supabaseAnonKey!); // supabaseAdmin から supabase に変更し、AnonKey を使用
const openai: OpenAI = new OpenAI({ apiKey: openaiApiKey });
const genAI = new GoogleGenerativeAI(geminiApiKey!); // Geminiクライアント初期化
const notion = new NotionClient({ auth: notionApiKey }); // Notionクライアント初期化

// Interface for structured summary from Gemini
interface StructuredSummary {
  meeting_title: string;
  meeting_basics: string;
  meeting_objective_agenda: string;
  discussions_decisions: string;
  next_schedule: string;
  other_notes: string;
}

// Interface for data to update a task in Supabase
interface UpdateTaskPayload {
  error_message?: string | null;
  transcription_result?: string | null;
  summary_result?: string | null; // Geminiからの構造化JSONを文字列化したもの
  notion_page_id?: string | null;
  processed_at?: string | null;
}

// Helper function to parse date strings (YYYY/MM/DD or YYYY年MM月DD日) to YYYY-MM-DD
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
    console.error("Error parsing date:", dateString, e);
  }
  console.warn("Could not parse date string:", dateString, "returning undefined.");
  return undefined;
}

// ヘルパー関数
async function downloadVideoFromStorage(filePathOnBucket: string): Promise<Blob> {
  const bucketName = 'videos'; // バケット名を固定
  console.log(`Downloading video from Supabase Storage: bucket '${bucketName}', path '${filePathOnBucket}'`);

  if (!filePathOnBucket) { // ファイルパスが空でないかチェック
    throw new Error(`Invalid filePathOnBucket: ${filePathOnBucket}. Expected format: path/to/file.mp4`);
  }

  const { data, error } = await supabase.storage
    .from(bucketName) // 固定のバケット名を使用
    .download(filePathOnBucket); // filePathOnBucket をそのまま使用

  if (error) {
    console.error('Error downloading video from Supabase:', error);
    // エラーオブジェクトに詳細が含まれている場合があるので、それをログに出力
    if (error.cause) console.error('Error cause:', error.cause);
    throw new Error(`Failed to download video (bucket: ${bucketName}, path: ${filePathOnBucket}): ${error.message}`);
  }
  if (!data) {
    throw new Error(`No data returned when downloading video (bucket: ${bucketName}, path: ${filePathOnBucket})`);
  }
  console.log(`Video ${filePathOnBucket} from bucket ${bucketName} downloaded successfully.`);
  return data;
}

async function transcribeVideoWithWhisper(videoBlob: Blob, fileName: string = 'video.mp4'): Promise<string> {
  console.log(`Transcribing video: ${fileName} (type: ${videoBlob.type}) using Whisper API...`);
  try {
    const arrayBuffer = await videoBlob.arrayBuffer();
    const videoBuffer = Buffer.from(arrayBuffer);

    // formdata-nodeのFileオブジェクトを作成して渡す
    const whisperFile = new File([videoBuffer], fileName, { type: videoBlob.type });

    console.log(`[Whisper Pre-flight] Preparing to call OpenAI Whisper API.`);
    console.log(`[Whisper Pre-flight] File details - Name: ${fileName}, Size: ${videoBuffer.length} bytes, Type: ${videoBlob.type}`);
    console.log(`[Whisper Pre-flight] OpenAI Model: whisper-1`);

    const transcription = await openai.audio.transcriptions.create({
        model: 'whisper-1',
        file: whisperFile, // Fileオブジェクトを渡す
    });
    
    console.log(`[Whisper Success] Whisper API transcription successful for ${fileName}.`);
    console.log(`[Whisper Success] Transcription text length: ${transcription.text.length}`);
    // console.log('[Whisper Success] Full response object:', JSON.stringify(transcription, null, 2)); // 詳細すぎる場合はコメントアウト

    return transcription.text;
  } catch (error: unknown) {
    console.error(`[Whisper Error] Error during Whisper API transcription for ${fileName}.`);
    console.error('[Whisper Error] Raw error object:', error);

    if (error instanceof OpenAI.APIError) {
      console.error('[Whisper Error] OpenAI APIError Details:');
      console.error(`  Status: ${error.status}`);
      console.error(`  Code: ${error.code}`);
      console.error(`  Param: ${error.param}`);
      console.error(`  Type: ${error.type}`);
      console.error(`  Message: ${error.message}`);
      if (error.headers) {
        console.error(`  Headers: ${JSON.stringify(error.headers, null, 2)}`);
      }
      if (error.error) {
          console.error(`  Error object from API: ${JSON.stringify(error.error, null, 2)}`);
      }
    } else if (error instanceof Error) {
        console.error('[Whisper Error] Standard Error Details:');
        console.error(`  Name: ${error.name}`);
        console.error(`  Message: ${error.message}`);
        if (error.stack) {
            console.error(`  Stack: ${error.stack}`);
        }
        if (error.cause) {
             console.error('  Cause:', error.cause);
        }
    } else {
        console.error('[Whisper Error] Unknown error type during Whisper API transcription.');
    }
    // 元のエラーを再スローするか、新しいエラーをスローするかは既存の設計に合わせる
    throw new Error(`Whisper API request failed for ${fileName}: ${(error instanceof Error) ? error.message : String(error)}`);
  }
}

async function summarizeTextWithGemini(text: string): Promise<StructuredSummary> {
  console.log("Generating structured summary with Gemini API...");
  const prompt = `以下の会議の文字起こし内容を分析し、指定された項目で情報を整理して厳密にJSON形式で出力してください。JSON以外の前置きや後書きは一切不要です。

{
  "meeting_title": "会議名（例：〇〇株式会社様 定例会議）",
  "meeting_basics": "会議の基本情報（参加者、場所など、文字起こしから推測できる範囲で記述）",
  "meeting_objective_agenda": "会議の目的と主要なアジェンダ（文字起こしから抽出・要約して記述）",
  "discussions_decisions": "会議での主要な議論と決定事項（文字起こしから抽出・要約し、箇条書きを推奨）",
  "next_schedule": "今後のスケジュールや次のアクションについて（文字起こしから抽出・要約し、箇条書きを推奨）",
  "other_notes": "その他特記事項（上記以外で重要な点や補足事項を記述）"
}

文字起こし内容：
---
${text}
---
出力は上記のJSON形式のみとしてください。説明や前置き、後書きは絶対に含めないでください。`;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const generationConfig = {
        responseMimeType: "application/json",
    };
    const safetySettings = [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    ];

    const result = await model.generateContent({
        contents: [{ role: "user", parts: [{text: prompt}]}],
        generationConfig,
        safetySettings
    });
    const response = result.response;
    const responseText = response.text();
    
    console.log('Raw Gemini API response text:', responseText);

    // Corrected regex for cleaning JSON response
    const cleanedResponseText = responseText.replace(/^```json\n?|\n?```$/g, "").trim();

    const summary = JSON.parse(cleanedResponseText) as StructuredSummary;
    console.log('Gemini API structured summary successful:', summary);
    return summary;
  } catch (e: unknown) {
    console.error('Error during Gemini API structured summarization:', (e instanceof Error) ? e.message : String(e));
    if (typeof e === 'object' && e !== null && 'response' in e) {
      const errorResponse = (e as { response: unknown }).response; // errorResponse は 'unknown' 型

      if (typeof errorResponse === 'object' && errorResponse !== null) {
        // 'data' プロパティの存在を確認し、存在すれば errorResponse.data (unknown型) にアクセス
        if ('data' in errorResponse && errorResponse.data !== undefined) {
            // errorResponse.data を String() で明示的に文字列化
            console.error('Gemini API Error Response Data:', String(errorResponse.data));
        // 'statusText' プロパティの存在を確認し、かつ文字列型であれば errorResponse.statusText (string型) にアクセス
        } else if ('statusText' in errorResponse && typeof errorResponse.statusText === 'string') {
            console.error('Gemini API Error Status Text:', errorResponse.statusText);
        } else {
            console.error('Gemini API Error Response (unknown structure):', errorResponse);
        }
      } else {
        console.error('Gemini API Error Response (not an object):', errorResponse);
      }
    } else {
      console.error('Full Gemini Error:', e);
    }
    throw new Error(`Gemini API request failed: ${(e instanceof Error) ? e.message : String(e)}`);
  }
}

// updateTaskInSupabase の型定義を修正
async function updateTaskInSupabase(taskId: string, status: string, data?: Partial<UpdateTaskPayload>) {
    console.log(`Updating task ${taskId} in Supabase with status: ${status}`);
    const updates: { status: string; updated_at: string } & Partial<UpdateTaskPayload> = {
        status,
        updated_at: new Date().toISOString(),
    };

    if (data) {
        // dataオブジェクトからUpdateTaskPayloadに定義されたキーのみを選択的にコピー
        if (data.error_message !== undefined) updates.error_message = data.error_message;
        if (data.transcription_result !== undefined) updates.transcription_result = data.transcription_result;
        if (data.summary_result !== undefined) updates.summary_result = data.summary_result;
        if (data.notion_page_id !== undefined) updates.notion_page_id = data.notion_page_id;
        if (data.processed_at !== undefined) updates.processed_at = data.processed_at;
    }

    if (status === 'completed' && !updates.processed_at) {
        updates.processed_at = new Date().toISOString(); 
    }

    const { error } = await supabase
        .from('transcription_tasks')
        .update(updates)
        .eq('id', taskId);

    if (error) {
        console.error(`Error updating task ${taskId} in Supabase:`, error);
    }
}

// Notionページ作成ヘルパー関数
async function createNotionPage(
  dbId: string,
  meetingDate: string | undefined,
  consultantName: string | null | undefined,
  clientName: string | null | undefined,
  summaryData: StructuredSummary
) {
  console.log(`Creating Notion page in DB: ${dbId}`);

  const pageTitle = summaryData.meeting_title || `${clientName || 'N/A'}様 ${meetingDate || '日付不明'}`;
  const properties: CreatePageParameters['properties'] = { // 型を CreatePageParameters['properties'] に変更
    '会議名': { title: [{ text: { content: pageTitle } }] },
    // 日付プロパティは meetingDate が undefined の場合、プロパティ自体を含めないようにする
    ...(meetingDate && { '日付': { date: { start: meetingDate } } }),
  };

  if (dbId === NOTION_DB_ID_1 || dbId === NOTION_DB_ID_3) {
    if (consultantName) {
      properties['コンサルタント名'] = { rich_text: [{ text: { content: consultantName } }] };
    }
  }
  // クライアント名は DB① と DB② にのみ存在する
  if (dbId === NOTION_DB_ID_1 || dbId === NOTION_DB_ID_2) {
    if (clientName) {
      properties['クライアント名'] = { rich_text: [{ text: { content: clientName } }] };
    }
  }
  
  // summaryData の各項目が空文字列の場合も考慮してセット
  properties['会議の基本情報'] = { rich_text: [{ text: { content: summaryData.meeting_basics || ""} }] };
  properties['会議の目的とアジェンダ'] = { rich_text: [{ text: { content: summaryData.meeting_objective_agenda || ""} }] };
  properties['会議の内容(議論と決定事項)'] = { rich_text: [{ text: { content: summaryData.discussions_decisions || ""} }] };
  properties['今後のスケジュール'] = { rich_text: [{ text: { content: summaryData.next_schedule || ""} }] };
  properties['その他特記事項'] = { rich_text: [{ text: { content: summaryData.other_notes || ""} }] };

  // undefined になったプロパティを削除 (CreatePageParameters の型要件に合わせるため、
  // オプショナルなプロパティは存在しないか、正しい型である必要があるため、明示的な削除は不要になる場合があるが、
  // 上記の meetingDate の条件分岐のように、元々 undefined を許容していた箇所は、プロパティごと含めないのが安全)
  // Object.keys(properties).forEach(key => (properties as Record<string, unknown>)[key] === undefined && delete (properties as Record<string, unknown>)[key]);
  // ↑ CreatePageParameters['properties'] 型を使う場合、この削除ロジックは不要または修正が必要
  //   特に、title のような必須プロパティが undefined になることは型定義上ありえないため。
  //   オプショナルなプロパティは、値がなければキー自体をpropertiesオブジェクトに含めないようにする。

  try {
    const response = await notion.pages.create({
      parent: { database_id: dbId },
      properties: properties,
    });
    console.log(`Notion page created successfully in DB ${dbId}: ${(response as {id: string}).id}`);
    return (response as {id: string}).id;
  } catch (e: unknown) {
    if (isNotionClientError(e)) { // NotionClientError 型ガードを使用
        console.error(`Error creating Notion page in DB ${dbId}: Code: ${e.code}, Message: ${e.message}`);
        if (e.code === APIErrorCode.ValidationError) {
            // e.body に詳細が含まれることが多い。NotionClientError (APIResponseErrorを継承) は body: string を持つ
            console.error('Notion API Validation Error Body:', e.body); // (e as any).body から e.body へ変更
        }
    } else {
        console.error(`Error creating Notion page in DB ${dbId}:`, (e instanceof Error ? e.message : String(e)));
    }
    return null;
  }
}

async function notifySlack(payload: object) {
  // VERCEL_URL は Vercel のシステム環境変数で、デプロイされたベースURL (https://<project-name>-<unique-hash>-<scope>.vercel.app) が入る
  // ローカル開発時は VERCEL_URL はセットされないため、フォールバックURLが必要
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'; 
  const notifyUrl = `${baseUrl}/api/slack/notify`;

  try {
    console.log(`Sending Slack notification to ${notifyUrl} with payload:`, payload);
    const response = await fetch(notifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Error sending Slack notification: ${response.status} ${response.statusText}`, errorBody);
    } else {
      console.log('Slack notification sent successfully.');
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Failed to send Slack notification:', error.message, error.stack);
    } else {
      console.error('Failed to send Slack notification with unknown error type:', error);
    }
  }
}

export async function POST(request: NextRequest) {
  console.log('Received request in /api/process-task');
  if (!supabaseUrl || !supabaseAnonKey || !openaiApiKey || !geminiApiKey || !notionApiKey ||
      !NOTION_DB_ID_1 || !NOTION_DB_ID_2 || !NOTION_DB_ID_3
  ) {
    return NextResponse.json({ error: 'Server configuration error: Missing API keys or DB IDs.' }, { status: 500 });
  }

  let taskIdFromRequest: string | undefined;
  let storagePathFromRequest: string | undefined;
  let originalFileNameForNotification: string | undefined;

  try {
    const body = await request.json();
    console.log('Request body:', body);
    taskIdFromRequest = body.taskId;
    storagePathFromRequest = body.storagePath;

    if (!taskIdFromRequest || !storagePathFromRequest) {
      return NextResponse.json({ error: 'Missing taskId or storagePath in request body' }, { status: 400 });
    }
    
    // Use a new block-scoped taskId for this operation to avoid confusion
    const currentTaskId = taskIdFromRequest; 
    originalFileNameForNotification = storagePathFromRequest.split('/').pop();

    const { data: taskData, error: taskError } = await supabase
      .from('transcription_tasks')
      .select('meeting_date, consultant_name, client_name, original_file_name')
      .eq('id', currentTaskId)
      .single();

    if (taskError || !taskData) {
      console.error(`Error fetching task details for ${currentTaskId} from Supabase:`, taskError);
      await updateTaskInSupabase(currentTaskId, 'failed_in_vercel', { error_message: `Failed to fetch task details: ${taskError?.message}` });
      await notifySlack({
        taskId: currentTaskId,
        status: 'failed',
        fileName: originalFileNameForNotification || 'N/A',
        errorMessage: `Failed to fetch task details: ${taskError?.message}`,
      });
      return NextResponse.json({ error: `Failed to fetch task details: ${taskError?.message}` }, { status: 500 });
    }
    
    const meetingDate = parseDateToISO(taskData.meeting_date as string | null | undefined);
    const consultantName = taskData.consultant_name as string | null | undefined;
    const clientName = taskData.client_name as string | null | undefined;

    await updateTaskInSupabase(currentTaskId, 'processing_in_vercel');

    const originalFileName = storagePathFromRequest.split('/').pop() || 'video_from_storage.mp4';
    const videoBlob = await downloadVideoFromStorage(storagePathFromRequest);

    const transcript = await transcribeVideoWithWhisper(videoBlob, originalFileName);
    await updateTaskInSupabase(currentTaskId, 'transcribed_in_vercel', { transcription_result: transcript });

    const structuredSummary = await summarizeTextWithGemini(transcript);
    await updateTaskInSupabase(currentTaskId, 'summarized_in_vercel', { summary_result: JSON.stringify(structuredSummary) });

    let notionPageId1: string | null = null;
    let notionPageId2: string | null = null;
    let notionPageId3: string | null = null;

    if (NOTION_DB_ID_1) {
        notionPageId1 = await createNotionPage(NOTION_DB_ID_1, meetingDate, consultantName, clientName, structuredSummary);
    }
    if (NOTION_DB_ID_2) {
        notionPageId2 = await createNotionPage(NOTION_DB_ID_2, meetingDate, null, clientName, structuredSummary);
    }
    if (NOTION_DB_ID_3) {
        notionPageId3 = await createNotionPage(NOTION_DB_ID_3, meetingDate, consultantName, null, structuredSummary); // clientName に null を渡す
    }
    
    const notionPageIdsToStore = [notionPageId1, notionPageId2, notionPageId3].filter(id => id !== null).join(',');

    await updateTaskInSupabase(currentTaskId, 'completed', { 
        notion_page_id: notionPageIdsToStore || null,
        // summary_result は既にsummarized_in_vercelで保存済み
    });

    console.log(`Task ${currentTaskId} processed successfully by Vercel.`);

    // Slackへの成功通知
    await notifySlack({
      taskId: currentTaskId,
      status: 'completed',
      fileName: originalFileNameForNotification || 'N/A',
      summary: structuredSummary.meeting_title, // または他の要約情報
      notionPageIds: notionPageIdsToStore,
      // 必要に応じて他の情報も追加 (例: clientName, meetingDate)
      clientName: clientName,
      meetingDate: meetingDate, 
    });

    return NextResponse.json({ 
      message: "Task processed successfully, Notion pages created.", 
      taskId: currentTaskId, 
      notionPageId1,
      notionPageId2,
      notionPageId3
    });

  } catch (e: unknown) {
    // Use taskIdFromRequest here if currentTaskId is not in scope or could be undefined in early error
    const idForErrorLogging = taskIdFromRequest || 'unknown';
    const errorMessage = (e instanceof Error) ? e.message : String(e);
    console.error(`Error processing task ${idForErrorLogging} in Vercel:`, errorMessage, (e instanceof Error) ? e.stack : undefined);
    if (taskIdFromRequest) { // Check if original taskId was available for update
        await updateTaskInSupabase(taskIdFromRequest, 'failed_in_vercel', { error_message: errorMessage });
    }

    // Slackへの失敗通知
    await notifySlack({
      taskId: idForErrorLogging,
      status: 'failed',
      fileName: originalFileNameForNotification || 'N/A',
      errorMessage: errorMessage,
    });

    return NextResponse.json({ error: `Failed to process task: ${errorMessage}` }, { status: 500 });
  }
}
