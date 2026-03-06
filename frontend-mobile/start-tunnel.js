const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Caminho exato até o seu arquivo api.ts
const apiFilePath = path.join(__dirname, 'src', 'services', 'api.ts');

console.log('🚀 Iniciando túnel do Serveo...');

// Roda o comando SSH do Serveo em segundo plano
const serveo = spawn('ssh', ['-R', '80:127.0.0.1:3000', 'serveo.net']);

serveo.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(output); // Mostra o log normal do Serveo no terminal

  // Procura por qualquer URL que comece com https:// no log do Serveo
  const match = output.match(/(https:\/\/[^\s]+)/);

  if (match) {
    const newUrl = match[0];
    console.log(`\n🔗 URL Nova Detectada: ${newUrl}`);

    try {
      // Lê o seu arquivo api.ts atual
      let apiFile = fs.readFileSync(apiFilePath, 'utf8');
      
      // Substitui a linha antiga pela URL nova
      apiFile = apiFile.replace(/const API_URL = ['"`].*?['"`];/, `const API_URL = '${newUrl}';`);
      
      // Salva o arquivo
      fs.writeFileSync(apiFilePath, apiFile);
      console.log('✅ Arquivo src/services/api.ts atualizado automaticamente com sucesso!\n');
    } catch (err) {
      console.error('❌ Erro ao tentar atualizar o api.ts:', err);
    }
  }
});

// Mostra erros caso o Serveo caia
serveo.stderr.on('data', (data) => {
  process.stdout.write(data.toString());
});

// Avisa se o túnel fechar
serveo.on('close', (code) => {
  console.log(`\n⚠️ Túnel fechado com código ${code}`);
});