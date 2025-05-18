import { NextRequest, NextResponse } from 'next/server';
import { WebClient } from '@slack/web-api'; // Slackクライアント

// 環境変数の読み込み
const slackBotToken = process.env.SLACK_BOT_TOKEN;
const slackChannelId = process.env.SLACK_CHANNEL_ID;

let slackClient: WebClient | null = null;
if (slackBotToken) {
  slackClient = new WebClient(slackBotToken);
} else {
  console.warn('SLACK_BOT_TOKEN is not set. Slack notifications will be disabled.');
}

async function sendSlackNotification(message: string) {
  if (!slackClient || !slackChannelId) {
    console.error('Slack client or channel ID is not configured. Cannot send message.');
    console.log('Slack message (not sent):', message); // Log message if not sent
    return;
  }
  try {
    await slackClient.chat.postMessage({
      channel: slackChannelId,
      text: message,
      // You can use blocks for richer formatting: https://api.slack.com/block-kit
    });
    console.log('Slack notification sent successfully.');
  } catch (error) {
    console.error('Error sending Slack notification:', error);
  }
}

export async function POST(request: NextRequest) {
  if (!slackClient) {
    // Log that Slack is not configured and proceed gracefully or return error
    console.warn("Slack integration is not configured. Skipping Slack notification.");
    // Optionally return an error or a specific response if Slack is critical
    // return NextResponse.json({ error: 'Slack integration not configured' }, { status: 500 });
  }

  try {
    const body = await request.json();
    // Destructure all expected fields, providing defaults or handling missing ones
    const {
      task_id,
      status,
      original_file_name = 'N/A',
      // Assuming these paths point to where the full text might be stored, if not directly provided
      storage_transcript_path = 'N/A', 
      storage_summary_path = 'N/A',
      // Direct text if available (and preferred for Slack messages if not too long)
      transcript_text, // Will be used if present
      summary_text,    // Will be used if present
      notion_page_url, // Expecting a URL to the Notion page if created by process-task
      error_message = 'An unknown error occurred.'
    } = body;

    console.log(`Received notification for task_id: ${task_id}, status: ${status}`);

    if (!task_id) {
      return NextResponse.json({ error: 'task_id is required' }, { status: 400 });
    }

    let slackMessage = '';

    if (status === 'completed') {
      console.log(`Processing completed task: ${task_id}`);
      
      slackMessage = `✅ 動画「${original_file_name}」の処理が完了しました (タスクID: ${task_id})。
`;

      if (summary_text) {
        slackMessage += `\n📝 要約:\n${summary_text.substring(0, 300)}${summary_text.length > 300 ? '...' : ''}\n`; // Display first 300 chars of summary
      } else if (storage_summary_path !== 'N/A'){
        slackMessage += `\n要約パス: ${storage_summary_path}\n`;
      }

      if (transcript_text) {
        // Optionally include a snippet or just a note that transcript is available
        // slackMessage += `\n📜 文字起こし(一部):\n${transcript_text.substring(0, 200)}${transcript_text.length > 200 ? '...' : ''}\n`;
      } else if (storage_transcript_path !== 'N/A'){
        slackMessage += `文字起こしパス: ${storage_transcript_path}\n`;
      }

      if (notion_page_url) {
        slackMessage += `\n📄 Notionページ: ${notion_page_url}\n`;
      }
      
      // Notion登録処理のコメントアウトは残す (役割が明確化されれば実装)
      // console.log('Data (would be) added to Notion for task:', task_id);

    } else if (status === 'failed') {
      console.error(`Task ${task_id} failed. Error: ${error_message}`);
      slackMessage = `❌ 動画「${original_file_name}」の処理中にエラーが発生しました (タスクID: ${task_id})。
エラー: ${error_message}`;
    
    } else {
      console.warn(`Received unhandled status '${status}' for task_id: ${task_id}`);
      // Optionally send a Slack message for unhandled statuses too
      slackMessage = `⚠️ タスク ${task_id} が不明なステータス '${status}' を受信しました。`;
    }

    if (slackMessage && slackClient && slackChannelId) {
      await sendSlackNotification(slackMessage);
    }

    return NextResponse.json({ message: 'Notification received and processed' }, { status: 200 });

  } catch (error: any) {
    console.error('Error processing notification:', error.message, error.stack);
    // Attempt to send a generic error to Slack if possible
    if (slackClient && slackChannelId) {
        await sendSlackNotification(`🚨 /api/slack/notifyエンドポイントでエラーが発生しました: ${error.message}`);
    }
    return NextResponse.json({ error: 'Internal server error processing notification' }, { status: 500 });
  }
} 