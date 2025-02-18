require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// -----------------------------------------
// HACK para simular "default: OpenAI" como construtor
// -----------------------------------------
const openaiModule = require('openai');

/**
 * Recria uma classe "OpenAI" que retorna o objeto
 * com a forma antiga: openai.chat.completions.create(...)
 */
function OldStyleOpenAIConstructor({ apiKey }) {
  const { Configuration, OpenAIApi } = openaiModule;
  
  // Configura via API key
  const configuration = new Configuration({ apiKey });
  const apiInstance = new OpenAIApi(configuration);

  return {
    chat: {
      completions: {
        // Simula .create() => chama createChatCompletion do OpenAIApi
        create: async (params) => {
          const result = await apiInstance.createChatCompletion(params);
          // Retorna no formato que você espera (choices[0].message.content)
          return {
            choices: result.data.choices
          };
        }
      }
    }
  };
}

// Sobrescreve a 'default' do require('openai') para permitir o destructuring
openaiModule.default = OldStyleOpenAIConstructor;

// Agora sim podemos fazer o "const { default: OpenAI } = require('openai');"
const { default: OpenAI } = openaiModule;

// -----------------------------------------
// Inicializa "openai" com a API key
// -----------------------------------------
if (!process.env.OPENAI_API_KEY) {
  console.error('ERRO: Defina a variável OPENAI_API_KEY no Railway (Settings > Variables)!');
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------------------
// Configura o cliente WhatsApp
// -----------------------------------------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    // Flags para rodar em ambiente root (Railway) sem dar erro de sandbox
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

// -----------------------------------------
// Exibe QR Code no log
// -----------------------------------------
client.on('qr', (qr) => {
  console.log('QR Code gerado, aponte a câmera do WhatsApp para autenticar:');
  qrcode.generate(qr, { small: true });
});

// -----------------------------------------
// Loga quando estiver pronto
// -----------------------------------------
client.on('ready', () => {
  console.log('Bot conectado com sucesso!');
});

// -----------------------------------------
// Processa mensagens recebidas
// -----------------------------------------
client.on('message', async (message) => {
  try {
    // Se quiser responder só em grupos, ative esta linha:
    // if (!message.from.includes('g.us')) return;

    console.log(`Mensagem recebida de ${message.from}: ${message.body}`);

    // Faz a chamada usando a sintaxe antiga
    const response = await openai.chat.completions.create({
      model: 'gpt-4o', 
      messages: [
        { role: 'user', content: message.body }
      ]
    });

    // Pega a resposta do ChatGPT
    // (como simulamos, response.choices[0].message.content deve existir)
    const gptReply = response.choices[0]?.message?.content || 'Não entendi...';

    // Responde via WhatsApp
    await message.reply(gptReply);

  } catch (error) {
    console.error('Erro ao processar mensagem com ChatGPT:', error);
    await message.reply('Desculpe, ocorreu um erro ao processar sua solicitação.');
  }
});

// -----------------------------------------
// Inicializa o cliente
// -----------------------------------------
client.initialize();
