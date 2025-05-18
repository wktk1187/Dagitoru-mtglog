-- pg_net 拡張機能が有効になっていることを確認 (マイグレーションの最初の方で一度だけ実行すればよい)
-- create extension if not exists pg_net with schema extensions;

-- トリガー関数を作成
create or replace function public.handle_new_transcription_task()
returns trigger
language plpgsql
security definer -- FunctionがDB操作等で昇格された権限を必要とする場合
as $$
begin
  perform net.http_post(
    url:='http://127.0.0.1:54321/functions/v1/process-video-task', -- ローカルSupabase Functionのエンドポイント
    body:=jsonb_build_object( -- jsonb型でpayloadを構築
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', row_to_json(new)
      -- 'old_record' はINSERT時には不要なので省略も可
    ),
    headers:=jsonb_build_object( -- jsonb型でヘッダーを構築
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
    )
  );
  return new;
end;
$$;

-- transcription_tasks テーブルにトリガーを設定
create trigger on_new_transcription_task
  after insert on public.transcription_tasks
  for each row execute procedure public.handle_new_transcription_task(); 