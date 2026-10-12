// Prepara uma execução limpa da suíte: recria o banco de teste e compila a API.
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
  execSync('npm run build', { cwd: '../backend', stdio: 'inherit' });
}
