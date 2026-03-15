
const MCP_URL = 'https://mcp.ateam-ai.com/mcp';

async function listTools() {
  console.log('Initializing MCP session...');
  const initRes = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'explore-script', version: '1.0.0' }
      }
    })
  });
  
  const sessionId = initRes.headers.get('mcp-session-id');
  await initRes.json();
  
  // Send initialized notification
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'mcp-session-id': sessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    })
  });

  console.log('Listing tools from ' + MCP_URL + '...');
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'mcp-session-id': sessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    })
  });
  const data = await res.json();
  if (data.error) {
    console.error('MCP Error:', JSON.stringify(data.error, null, 2));
    return;
  }
  
  const tools = data.result.tools;
  console.log('Found ' + tools.length + ' tools:');
  tools.forEach(t => {
    if (t.name.startsWith('ateam_git') || t.name.includes('git')) {
      console.log('- ' + t.name + ': ' + t.description);
    }
  });
  
  console.log('\nAll tools:');
  tools.forEach(t => console.log('- ' + t.name));
}

listTools().catch(console.error);
