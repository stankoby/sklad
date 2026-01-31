import { spawn } from 'child_process';
import process from 'process';
import { loadEnvFile, resolveEnvPath } from '../utils/env.js';

const envPath = resolveEnvPath();
loadEnvFile(envPath);

const port = Number(process.env.PORT || 3001);
const url = `http://localhost:${port}/api/health`;

const server = spawn('node', ['server.js'], {
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverExited = false;
server.on('exit', (code) => {
  serverExited = true;
  if (code !== 0) {
    console.error(`❌ Сервер завершился с кодом ${code}.`);
  }
});

const waitForHealth = async () => {
  const deadline = Date.now() + 10000;
  let lastError = null;

  while (Date.now() < deadline) {
    if (serverExited) {
      throw new Error('Сервер не запустился (процесс завершился).');
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
      lastError = new Error(`Health ответил со статусом ${response.status}.`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw lastError || new Error('Не удалось дождаться /api/health.');
};

try {
  await waitForHealth();
  console.log('✅ Smoke test: /api/health отвечает корректно.');
  server.kill('SIGTERM');
  process.exit(0);
} catch (err) {
  console.error(`❌ Smoke test failed: ${err.message}`);
  server.kill('SIGTERM');
  process.exit(1);
}
