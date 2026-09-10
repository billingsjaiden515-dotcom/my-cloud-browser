const BASE = 'http://localhost:3001';

console.log('Testing API endpoints...');

try {
  const config = await fetch(`${BASE}/api/config`).then(r => r.json());
  console.log('/api/config:', JSON.stringify(config));
} catch (e) {
  console.error('/api/config failed:', e.message);
}

try {
  const start = await fetch(`${BASE}/api/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ browserType: 'chromium' }),
  }).then(r => r.json());
  console.log('/api/session/start:', JSON.stringify(start));
} catch (e) {
  console.error('/api/session/start failed:', e.message);
}