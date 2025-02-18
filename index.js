require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { default: OpenAI } = require('openai');

// Verifica se a variável OPENAI_API_KEY está definida
if (!process.env.OPENAI_API_KEY) {
  console.error('Erro: OPENAI_API_KEY não está definida no arquivo .env');
  process.exit(1);
}

// Inicializa a conexão com a API da OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Inicializa o cliente do WhatsApp
const client = new Client({
  authStrategy: new LocalAuth()
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
    // Caso queira responder APENAS em grupos, ative a linha abaixo:
    // if (!message.from.includes('g.us')) return;

    console.log(`Mensagem recebida de ${message.from}: ${message.body}`);

    // Chama a API do ChatGPT (modelo gpt-4o, altere se necessário para 'gpt-4' ou 'gpt-3.5-turbo')
    const response = await openai.chat.completions.create({
      model: 'gpt-4o', 
      messages: [
        { role: 'user', content: message.body }
      ]
    });

    // Extrai o texto da resposta
    const gptReply = response.choices[0]?.message?.content || 'Não entendi...';

    // Envia a resposta
    await message.reply(gptReply);

  } catch (error) {
    console.error('Erro ao processar mensagem com ChatGPT:', error);
    message.reply('Desculpe, ocorreu um erro ao processar sua solicitação.');
  }
});

// Inicializa o cliente do WhatsApp
client.initialize();
