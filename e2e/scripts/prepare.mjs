// Prepara uma execução limpa da suíte: recria o banco de teste e compila a API em backend/dist-e2e
// (pasta própria: não disputa o dist de um "nest start --watch" aberto pelo desenvolvedor).
// Se a API de teste já estiver no ar, o banco NÃO é recriado (os servidores são reaproveitados).
import { execSync } from 'node:child_process';
import net from 'node:net';

const apiPort = Number(process.env.E2E_API_PORT ?? 3001);

const inUse = await new Promise((resolve) => {
  const socket = net.connect(apiPort, '127.0.0.1');
  socket.once('connect', () => { socket.end(); resolve(true); });
  socket.once('error', () => resolve(false));
});

if (inUse) {
  console.log(`API de teste já está rodando na porta ${apiPort}: reaproveitando servidor e banco atuais.`);
} else {
  execSync('node scripts/reset-db.mjs', { stdio: 'inherit' });
  // E2E_SKIP_BUILD=1 reaproveita o backend/dist-e2e já compilado (execuções paralelas não podem
  // recompilar: o nest build apaga a pasta antes, derrubando a API de quem estiver rodando)
  if (process.env.E2E_SKIP_BUILD === '1') {
    console.log('E2E_SKIP_BUILD=1: usando o backend/dist-e2e já compilado.');
  } else {
    execSync('npm run build:e2e', { cwd: '../backend', stdio: 'inherit' });
  }
}
