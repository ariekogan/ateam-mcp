
import { handleToolCall } from './src/tools.js';

const sessionId = 'session-' + Math.random().toString(36).substring(2, 15);
const apiKey = 'adas_mobile-pa_193d609d807aed88f13dfd0fc42f8e10';

async function run() {
  console.log('Authenticating...');
  const authRes = await handleToolCall('ateam_auth', { api_key: apiKey }, sessionId);
  console.log('Auth result:', JSON.stringify(authRes, null, 2));

  if (authRes.isError) {
    process.exit(1);
  }

  console.log('Listing solutions...');
  const listRes = await handleToolCall('ateam_list_solutions', {}, sessionId);
  console.log('Solutions:', JSON.stringify(listRes, null, 2));
}

run().catch(console.error);
