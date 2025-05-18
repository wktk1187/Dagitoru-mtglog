import process from "node:process";
// Supabaseクライアントの初期化やアップロード処理をここに記述します
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Supabase URL and Anon Key must be defined in .env.local");
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey);

// 型定義 (必要に応じてより詳細に)
export interface TranscriptionTask {
  id?: string; // DB側で自動生成されるためオプショナル
  storage_path: string;
  status?: string; // デフォルトは'pending'
  original_file_name?: string | null;
  // 他のカラムも必要に応じて追加
}

// 例: データをアップロードする関数
export async function uploadData(bucket: string, path: string, data: File | ArrayBuffer | Blob, contentType: string) {
  console.log(`Uploading data to Supabase: ${bucket}/${path}`);
  const { data: uploadData, error } = await supabase.storage
    .from(bucket)
    .upload(path, data, {
      contentType,
      upsert: true, // 同じパスにファイルが存在する場合は上書き
    });

  if (error) {
    console.error("Error uploading to Supabase:", error);
    return { data: null, error };
  }

  console.log("Upload successful:", uploadData);
  return { data: uploadData, error: null };
}

// 新しい関数: transcription_tasks テーブルにレコードを挿入
export async function insertTranscriptionTask(task: Omit<TranscriptionTask, 'id' | 'status'> & { status?: string }) {
  console.log("Inserting new transcription task:", task);
  const { data, error } = await supabase
    .from('transcription_tasks')
    .insert([
      {
        storage_path: task.storage_path,
        original_file_name: task.original_file_name,
        status: task.status || 'pending', // statusが指定されなければpending
      },
    ])
    .select(); // 挿入したレコードを返す

  if (error) {
    console.error("Error inserting transcription task:", error);
    return { data: null, error };
  }

  console.log("Transcription task inserted successfully:", data);
  if (data && data.length > 0) {
    return { data: data[0], error: null }; // 最初のレコードを返す
  }
  return { data: null, error: new Error("No data returned after insert") };
} 