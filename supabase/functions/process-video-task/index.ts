/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js";
import "https://deno.land/std@0.224.0/dotenv/load.ts";

function getEnvVar(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Environment variable ${key} not set`);
  return value;
}

async function updateTaskStatus(
  supabase: SupabaseClient,
  taskId: string,
  status: string,
  errorMessage?: string | null
): Promise<void> {
  const updates: { status: string; error_message?: string; notified_at?: string } = {
    status,
    notified_at: new Date().toISOString(),
  };
  if (errorMessage) {
    updates.error_message = errorMessage;
  }
  const { error } = await supabase
    .from("transcription_tasks")
    .update(updates)
    .eq("id", taskId);
  if (error) console.error(`Error updating task to ${status}:`, error.message);
  else console.log(`Task ${taskId} status updated to ${status}.`);
}

serve(async (req: Request) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let supabase: SupabaseClient | null = null;
  let record: { id: string; storage_path: string } | null = null;

  try {
    const payload = await req.json();
    if (payload.type === "INSERT" && payload.table === "transcription_tasks" && payload.record) {
      record = payload.record;
    } else {
      console.error("Invalid payload structure:", payload);
      throw new Error("Invalid payload structure");
    }

    if (!record || !record.id || !record.storage_path) {
      console.error("Record ID or storage_path missing:", record);
      throw new Error("Record ID or storage_path missing in payload");
    }

    const taskId = record.id;
    const storagePath = record.storage_path;

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? getEnvVar("MY_APP_SUPABASE_URL");
    const serviceRoleKey = getEnvVar("MY_APP_SUPABASE_SERVICE_ROLE_KEY");
    supabase = createClient(supabaseUrl, serviceRoleKey);

    const vercelWebhookUrl = getEnvVar("VERCEL_WEBHOOK_URL");

    console.log(`Notifying Vercel webhook for task ${taskId}: ${vercelWebhookUrl}`);

    const webhookResponse = await fetch(vercelWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: taskId,
        storagePath: storagePath,
      }),
    });

    if (!webhookResponse.ok) {
      const errorBody = await webhookResponse.text();
      console.error(`Vercel webhook failed for task ${taskId}: ${webhookResponse.status}`, errorBody);
      if (supabase) {
        await updateTaskStatus(supabase, taskId, "webhook_failed", `Vercel webhook error: ${webhookResponse.status} - ${errorBody}`);
      }
      throw new Error(`Vercel webhook notification failed: ${webhookResponse.status}`);
    }

    console.log(`Vercel webhook notified successfully for task ${taskId}. Response: ${await webhookResponse.text()}`);
    if (supabase) {
      await updateTaskStatus(supabase, taskId, "webhook_sent");
    }

    return new Response(JSON.stringify({ message: "Webhook notification sent to Vercel." }), {
      headers: { ...cors, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Error in process-video-task (notification function):", msg);
    if (record && record.id && supabase) {
      await updateTaskStatus(supabase, record.id, "function_error", msg);
    }
    return new Response(JSON.stringify({ error: `Failed to notify Vercel: ${msg}` }), {
      headers: { ...cors, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
