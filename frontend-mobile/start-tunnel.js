/**
 * npm run tunnel — expõe a API local (porta 3000) na internet pelo Serveo e grava a URL
 * pública em EXPO_PUBLIC_API_URL no arquivo .env.local deste app (o código-fonte não é alterado).
 *
 * Use quando o celular não está na mesma rede do computador (rede corporativa, 4G...).
 * Na mesma rede Wi-Fi não precisa de túnel: o app descobre o IP sozinho (npm run start:lan).
 *
 * Ao encerrar (Ctrl+C, fechar a janela do terminal ou o túnel cair) a variável volta ao valor
 * anterior (ou é removida). Uma URL de túnel nunca é "restaurada": se uma sessão anterior foi
 * interrompida sem limpar o .env.local, a URL morta é avisada no início e removida no fim.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const API_PORT = process.env.API_PORT || process.env.EXPO_PUBLIC_API_PORT || '3000';
const ENV_FILE = path.join(__dirname, '.env.local');
const ENV_KEY = 'EXPO_PUBLIC_API_URL';

/** Endereços de túnel (Serveo, ngrok, localtunnel, Cloudflare, túnel do Expo): só valem enquanto o túnel vive. */
const TUNNEL_URL = /^https?:\/\/[^/\s]*(serveo|serveousercontent|ngrok|loca\.lt|localtunnel|trycloudflare|exp\.direct)/i;

function looksLikeTunnelUrl(value) {
  return !!value && TUNNEL_URL.test(value);
}

function readEnvLines() {
  try {
    return fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

function readEnvValue() {
  const line = readEnvLines().find((l) => l.trim().startsWith(`${ENV_KEY}=`));
  return line ? line.trim().slice(ENV_KEY.length + 1) : null;
}

/** Cria/atualiza (ou remove, com value null) a variável preservando as outras linhas. */
function writeEnvValue(value) {
  const lines = readEnvLines().filter((l) => !l.trim().startsWith(`${ENV_KEY}=`));
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (value) lines.push(`${ENV_KEY}=${value}`);
  fs.writeFileSync(ENV_FILE, lines.length ? `${lines.join('\n')}\n` : '');
}

// Valor que existia antes do túnel (restaurado no encerramento). URL de túnel antiga não conta:
// é de uma sessão que terminou sem limpar o .env.local e não funciona mais.
const storedValue = readEnvValue();
const staleTunnel = looksLikeTunnelUrl(storedValue);
const previousValue = staleTunnel ? null : storedValue;
let currentUrl = null;

if (staleTunnel) {
  console.warn(`⚠️  O .env.local já tem ${ENV_KEY}=${storedValue}`);
  console.warn('   Parece a URL de um túnel anterior que não foi encerrado corretamente (ela não funciona mais).');
  console.warn('   Ela será trocada pela URL nova e removida ao encerrar. Se outro "npm run tunnel" estiver aberto, feche-o.\n');
}

let restored = false;

/** Desfaz a alteração no .env.local (uma vez só; síncrono para funcionar também no evento "exit"). */
function restoreEnv() {
  if (restored || (!currentUrl && !staleTunnel)) return;
  restored = true;
  try {
    // Só mexe no arquivo se a variável ainda for a deste túnel (ou a URL morta encontrada no início)
    const now = readEnvValue();
    if (now !== currentUrl && !(staleTunnel && now === storedValue)) return;
    writeEnvValue(previousValue);
    console.log(previousValue
      ? `\n↩️  ${ENV_KEY} restaurada para ${previousValue} em .env.local`
      : `\n↩️  ${ENV_KEY} removida do .env.local (o app volta a usar o IP da rede local).`);
    console.log('   Reinicie o Expo com: npx expo start --clear');
  } catch (err) {
    console.error(`\n⚠️  Não foi possível restaurar o .env.local: ${err.message}`);
  }
  currentUrl = null;
}

function handleOutput(data) {
  const output = data.toString();
  process.stdout.write(output); // Mostra o log normal do Serveo no terminal

  // Prefere a URL do próprio Serveo; senão, a primeira URL https da linha de "Forwarding"
  const match = output.match(/https:\/\/[a-z0-9.-]*serveo[a-z0-9.-]*\.[a-z]+/i)
    || (/forwarding/i.test(output) ? output.match(/https:\/\/[^\s"']+/i) : null);
  if (!match) return;

  const newUrl = match[0].replace(/\/+$/, '');
  if (newUrl === currentUrl) return;

  try {
    writeEnvValue(newUrl);
    currentUrl = newUrl;
    restored = false;
    console.log(`\n🔗 URL pública da API: ${newUrl}`);
    console.log(`✅ ${ENV_KEY} gravada em frontend-mobile/.env.local`);
    console.log('\n👉 Em outro terminal (na pasta frontend-mobile), (re)inicie o Expo para ler a variável:');
    console.log('   npx expo start --clear            (ou: npx expo start --tunnel --clear fora da rede local)');
    console.log('   Mantenha este terminal aberto enquanto estiver testando.\n');
  } catch (err) {
    console.error(`❌ Erro ao gravar o .env.local: ${err.message}`);
  }
}

console.log(`🚀 Iniciando túnel do Serveo para http://127.0.0.1:${API_PORT} ...`);

// Roda o SSH do Serveo (accept-new evita travar pedindo confirmação da chave na primeira vez)
const serveo = spawn('ssh', [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=30',
  '-R', `80:127.0.0.1:${API_PORT}`,
  'serveo.net',
]);

serveo.stdout.on('data', handleOutput);
serveo.stderr.on('data', handleOutput);

serveo.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error('❌ Comando "ssh" não encontrado. Instale o OpenSSH (no Windows: Configurações > Apps > Recursos opcionais > Cliente OpenSSH).');
  } else {
    console.error(`❌ Falha ao iniciar o túnel: ${err.message}`);
  }
  process.exit(1);
});

// Avisa se o túnel fechar e desfaz a alteração no .env.local
serveo.on('close', (code) => {
  console.log(`\n⚠️ Túnel fechado com código ${code}`);
  restoreEnv();
  process.exit(code ?? 0);
});

function shutdown(exitCode) {
  restoreEnv();
  if (serveo.exitCode === null && !serveo.killed) serveo.kill();
  process.exit(exitCode);
}

// Ctrl+C, kill, fechar a janela do terminal (SIGHUP; no Windows também Ctrl+Break = SIGBREAK)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => shutdown(0));
}

// Qualquer outra saída (inclusive process.exit e erros) também limpa o .env.local
process.on('uncaughtException', (err) => {
  console.error(`❌ Erro inesperado: ${err.message}`);
  shutdown(1);
});
process.on('exit', () => {
  restoreEnv();
  if (serveo.exitCode === null && !serveo.killed) serveo.kill();
});
