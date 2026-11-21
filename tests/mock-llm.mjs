// 本地假模型服务，用于自测（不联网、不花钱）
// 用法：node tests/mock-llm.mjs 8788
import http from 'node:http';

const port = Number(process.argv[2] || 8788);

const server = http.createServer((req, res) => {
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {}
    const userMsg = payload.messages?.find((m) => m.role === 'user')?.content || '{}';
    let questions = [];
    try {
      questions = JSON.parse(userMsg).questions || [];
    } catch {}

    const obj = {};
    for (const q of questions) {
      const isJudge = String(q.type || '').includes('判断');
      obj[q.id] = isJudge ? 'T' : 'A';
    }
    const content = JSON.stringify(obj);
    const data = {
      id: 'mock',
      object: 'chat.completion',
      model: payload.model || 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-llm listening on http://127.0.0.1:${port}/v1`);
});
