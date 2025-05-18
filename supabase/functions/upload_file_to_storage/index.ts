import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.43.4"; // バージョンを固定または適切に管理
import "https://deno.land/std@0.224.0/dotenv/load.ts"; // ローカル開発用に .env を読み込む場合

// SupabaseダッシュボードのSecrets名に合わせる
const SUPABASE_URL_FROM_ENV = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY_FROM_ENV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SLACK_BOT_TOKEN_FROM_ENV = Deno.env.get("SLACK_BOT_TOKEN");

interface TaskPayload {
  taskId: string;
  slack_file_id?: string; // APIから呼ばれる場合は必須ではないかもしれないのでオプショナル
  slack_download_url: string;
  original_file_name: string;
  mimetype: string;
  filetype: string;
}

async function updateTaskStatus(
  supabase: SupabaseClient,
  taskId: string,
  status: string,
  updatePayload: Record<string, any> = {}
): Promise<void> {
  const { error } = await supabase
    .from("transcription_tasks")
    .update({ status, ...updatePayload, updated_at: new Date().toISOString() })
    .eq("id", taskId);
  if (error) {
    console.error(`Error updating task ${taskId} to ${status}:`, error.message);
    // ここでさらに堅牢なエラー通知処理を入れることも検討 (例: Slack通知)
  }
}

serve(async (req: Request) => {
  if (!SUPABASE_URL_FROM_ENV || !SUPABASE_SERVICE_ROLE_KEY_FROM_ENV || !SLACK_BOT_TOKEN_FROM_ENV) {
    console.error("Missing one or more required environment variables. Check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SLACK_BOT_TOKEN.");
    return new Response(JSON.stringify({ error: "Internal server configuration error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseAdmin = createClient(SUPABASE_URL_FROM_ENV, SUPABASE_SERVICE_ROLE_KEY_FROM_ENV);
  let payload: TaskPayload;

  try {
    payload = await req.json();
    console.log("Received payload:", payload);
  } catch (e) {
    console.error("Failed to parse request body:", e);
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const {
    taskId,
    slack_download_url,
    original_file_name,
    mimetype,
    filetype,
  } = payload;

  if (!taskId || !slack_download_url || !original_file_name || !mimetype || !filetype) {
    console.error("Missing required fields in payload:", payload);
    return new Response(JSON.stringify({ error: "Missing required fields in payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  try {
    console.log(`[${taskId}] Starting file download from Slack: ${slack_download_url}`);
    const slackFileResponse = await fetch(slack_download_url, {
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN_FROM_ENV}`,
      },
    });

    if (!slackFileResponse.ok || !slackFileResponse.body) {
      const errorBody = await slackFileResponse.text();
      console.error(
        `[${taskId}] Failed to download file from Slack: ${slackFileResponse.status}`,
        errorBody
      );
      await updateTaskStatus(supabaseAdmin, taskId, "upload_failed", {
        error_message: `Slack download failed: ${slackFileResponse.status} - ${errorBody.substring(0, 200)}`,
      });
      return new Response(
        JSON.stringify({ error: "Failed to download file from Slack" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    console.log(`[${taskId}] File downloaded from Slack. Preparing to stream to Supabase Storage...`);

    let fileExtension = filetype || "dat";
    // MIMEタイプからの拡張子推測ロジック (Vercel APIからコピー＆改善も検討)
    if (mimetype.startsWith("video/")) {
      fileExtension = mimetype.split("/")[1];
    } else if (mimetype.startsWith("audio/")) {
      fileExtension = mimetype.split("/")[1] === "mpeg" ? "mp3" : mimetype.split("/")[1];
    }
    if (fileExtension === "quicktime") fileExtension = "mov";
    // 不明な拡張子の場合のフォールバックや、より堅牢なマッピングが必要な場合も

    const storagePath = `uploads/${taskId}.${fileExtension}`;
    console.log(`[${taskId}] Uploading to Supabase Storage: ${storagePath} with type ${mimetype} using stream`);

    const { data: uploadResult, error: uploadError } =
      await supabaseAdmin.storage
        .from("videos")
        .upload(storagePath, slackFileResponse.body, {
          contentType: mimetype,
          upsert: false, // true にして再試行を許容するか検討
          duplex: "half", // DenoのReadableStreamを扱うために追加
        });

    if (uploadError) {
      console.error(`[${taskId}] Failed to upload to Supabase Storage:`, uploadError);
      await updateTaskStatus(supabaseAdmin, taskId, "upload_failed", {
        error_message: `Supabase Storage upload failed: ${uploadError.message}`,
      });
      return new Response(
        JSON.stringify({ error: "Failed to upload to Supabase Storage" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log(`[${taskId}] File uploaded to Supabase Storage:`, uploadResult);
    await updateTaskStatus(supabaseAdmin, taskId, "uploaded", { // ステータスを 'uploaded' に変更
      storage_path: storagePath,
      error_message: null, // エラーが解消された場合はクリア
    });

    return new Response(JSON.stringify({ message: "File uploaded and task updated successfully", taskId, storagePath }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error(`[${taskId}] Unexpected error in upload_file_to_storage:`, error);
    await updateTaskStatus(supabaseAdmin, taskId, "upload_failed", {
      error_message: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: "Unexpected server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}); 