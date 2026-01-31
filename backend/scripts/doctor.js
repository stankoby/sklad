import net from 'net';
import process from 'process';
import { loadEnvFile, resolveEnvPath } from '../utils/env.js';

const REQUIRED_NODE_MAJOR = 20;
const REQUIRED_ENV_KEYS = ['MOYSKLAD_TOKEN'];
const OPTIONAL_ENV_KEYS = ['MOYSKLAD_STORE_ID', 'MOYSKLAD_STORE_NAME'];

const log = (message) => console.log(message);
const warn = (message) => console.warn(`⚠️  ${message}`);
const error = (message) => console.error(`❌ ${message}`);

const envPath = resolveEnvPath();
const hasEnvFile = loadEnvFile(envPath);

const nodeMajor = Number(process.versions.node.split('.')[0] || 0);
if (nodeMajor < REQUIRED_NODE_MAJOR) {
  error(`Нужен Node.js версии ${REQUIRED_NODE_MAJOR}+ (LTS). Сейчас: ${process.versions.node}.`);
  log('👉 Установите LTS с https://nodejs.org/ и повторите команду.');
  process.exit(1);
}

if (!hasEnvFile) {
  warn('Файл .env не найден.');
  log('👉 Скопируйте .env.example в .env и заполните переменные.');
}

const hasToken = Boolean(process.env.MOYSKLAD_TOKEN);
const hasLogin = Boolean(process.env.MOYSKLAD_LOGIN);
const hasPassword = Boolean(process.env.MOYSKLAD_PASSWORD);
const hasAuth = hasToken || (hasLogin && hasPassword);

if (!hasAuth) {
  error('Не найден доступ к МойСклад: нужно MOYSKLAD_TOKEN или MOYSKLAD_LOGIN + MOYSKLAD_PASSWORD.');
  log('👉 Проверьте .env (пример есть в .env.example).');
  process.exit(1);
}

for (const key of REQUIRED_ENV_KEYS) {
  if (!process.env[key] && !hasLogin) {
    warn(`Переменная ${key} не задана. Используется логин/пароль?`);
  }
}

for (const key of OPTIONAL_ENV_KEYS) {
  if (!process.env[key]) {
    warn(`Переменная ${key} не задана. Это может быть нужно для некоторых функций.`);
  }
}

const port = Number(process.env.PORT || 3001);
await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      reject(new Error(`Порт ${port} уже занят. Закройте программу на этом порту или поменяйте PORT в .env.`));
    } else {
      reject(err);
    }
  });
  server.once('listening', () => {
    server.close(() => resolve());
  });
  server.listen(port, '127.0.0.1');
}).catch((err) => {
  error(err.message);
  process.exit(1);
});

log('✅ Doctor check: всё выглядит готовым к запуску.');
