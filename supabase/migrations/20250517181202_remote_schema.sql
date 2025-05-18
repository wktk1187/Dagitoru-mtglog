

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgjwt" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."transcription_tasks" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "storage_path" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text",
    "original_file_name" "text",
    "transcript_path" "text",
    "summary_path" "text",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "transcription_tasks_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."transcription_tasks" OWNER TO "postgres";


COMMENT ON TABLE "public"."transcription_tasks" IS 'Stores tasks for video transcription and summarization, including status and paths to generated files.';



COMMENT ON COLUMN "public"."transcription_tasks"."id" IS 'Primary key, unique identifier for the task (UUID).';



COMMENT ON COLUMN "public"."transcription_tasks"."storage_path" IS 'Full path to the original video file in Supabase Storage (e.g., uploads/uuid.mp4). Provided by the webhook.';



COMMENT ON COLUMN "public"."transcription_tasks"."status" IS 'Current status of the transcription task (e.g., pending, processing, completed, failed).';



COMMENT ON COLUMN "public"."transcription_tasks"."original_file_name" IS 'Original name of the file as uploaded from Slack.';



COMMENT ON COLUMN "public"."transcription_tasks"."transcript_path" IS 'Path to the generated transcript text file in Supabase Storage.';



COMMENT ON COLUMN "public"."transcription_tasks"."summary_path" IS 'Path to the generated summary markdown file in Supabase Storage.';



COMMENT ON COLUMN "public"."transcription_tasks"."error_message" IS 'Stores any error message if the task processing failed.';



COMMENT ON COLUMN "public"."transcription_tasks"."created_at" IS 'Timestamp indicating when the task record was created.';



COMMENT ON COLUMN "public"."transcription_tasks"."updated_at" IS 'Timestamp indicating when the task record was last updated (automatically managed by a trigger).';



ALTER TABLE ONLY "public"."transcription_tasks"
    ADD CONSTRAINT "transcription_tasks_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_transcription_tasks_created_at" ON "public"."transcription_tasks" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_transcription_tasks_status" ON "public"."transcription_tasks" USING "btree" ("status");



CREATE OR REPLACE TRIGGER "update_transcription_tasks_updated_at" BEFORE UPDATE ON "public"."transcription_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE POLICY "Allow full access for service_role" ON "public"."transcription_tasks" USING (true) WITH CHECK (true);



ALTER TABLE "public"."transcription_tasks" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";











































































































































































GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";


















GRANT ALL ON TABLE "public"."transcription_tasks" TO "anon";
GRANT ALL ON TABLE "public"."transcription_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."transcription_tasks" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "service_role";






























RESET ALL;
