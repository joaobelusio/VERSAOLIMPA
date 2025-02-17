require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { default: OpenAI } = require('openai');

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
    // Exemplo: responde apenas se for no grupo (ID contendo 'g.us'), 
    // mas se quiser responder a todas as mensagens, remova essa verificação.
    if (message.from.includes('g.us')) {
      console.log(`Mensagem recebida no grupo ${message.from}: ${message.body}`);

      // Chama a API do ChatGPT (modelo gpt-4o)
      const response = await openai.chat.completions.create({
        model: 'gpt-4o', // Ajuste se necessário para 'gpt-4' ou outro modelo
        messages: [
          { role: 'user', content: message.body }
        ]
      });

      // Extrai o texto da resposta
      const gptReply = response.choices[0]?.message?.content || 'Não entendi...';

      // Envia a resposta de volta no grupo
      message.reply(gptReply);
    }
  } catch (error) {
    console.error('Erro ao processar mensagem com ChatGPT:', error);
    message.reply('Desculpe, ocorreu um erro ao processar sua solicitação.');
  }
});

// Inicializa o cliente do WhatsApp
client.initialize();
