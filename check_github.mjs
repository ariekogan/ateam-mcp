
import { handleToolCall } from './src/tools.js';

const sessionId = 'session-' + Math.random().toString(36).substring(2, 15);
const apiKey = 'adas_mobile-pa_193d609d807aed88f13dfd0fc42f8e10';

async function run() {
  await handleToolCall('ateam_auth', { api_key: apiKey }, sessionId);
  
  console.log('Checking GitHub status...');
  const res = await handleToolCall('ateam_github_status', { solution_id: 'personal-adas' }, sessionId);
  console.log('Status:', JSON.stringify(res, null, 2));
}

run().catch(console.error);
