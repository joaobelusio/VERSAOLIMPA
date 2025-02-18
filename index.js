require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { default: OpenAI } = require('openai');

// Verifica se a variável OPENAI_API_KEY está definida
if (!process.env.OPENAI_API_KEY) {
  console.error('ERRO: OPENAI_API_KEY não definida. Defina nas Variables do Railway!');
  process.exit(1);
}

// Inicializa a conexão com a API da OpenAI usando sua sintaxe
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Configura o cliente do WhatsApp
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    // Argumentos para rodar como root no Railway (sem sandbox)
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

// Exibe o QR Code no terminal para autenticação
client.on('qr', (qr) => {
  console.log('QR Code gerado, aponte a câmera do WhatsApp para autenticar:');
  qrcode.generate(qr, { small: true });
});

// Loga quando o bot estiver pronto
client.on('ready', () => {
  console.log('Bot conectado com sucesso!');
});

// Evento disparado quando chega uma mensagem
client.on('message', async (message) => {
  try {
    // Se quiser responder somente em grupos, reative:
    // if (!message.from.includes('g.us')) return;

    console.log(`Mensagem recebida de ${message.from}: ${message.body}`);

    // Chama a API do ChatGPT (modelo 'gpt-4o' ou troque para 'gpt-3.5-turbo' / 'gpt-4')
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: message.body }
      ]
    });

    // Extrai o texto da resposta
    const gptReply = response.choices[0]?.message?.content || 'Não entendi...';

    // Responde a mensagem
    await message.reply(gptReply);

  } catch (error) {
    console.error('Erro ao processar mensagem com ChatGPT:', error);
    await message.reply('Desculpe, ocorreu um erro ao processar sua solicitação.');
  }
});

// Inicializa o cliente do WhatsApp
client.initialize();
