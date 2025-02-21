require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Pool } = require('pg');
const redis = require('redis');
const openaiModule = require('openai');

// ---------------------------
// 1) Config do OpenAI
// ---------------------------
function OldStyleOpenAIConstructor({ apiKey }) {
  const { Configuration, OpenAIApi } = openaiModule;
  const configuration = new Configuration({ apiKey });
  const apiInstance = new OpenAIApi(configuration);
  return {
    chat: {
      completions: {
        create: async (params) => {
          const result = await apiInstance.createChatCompletion(params);
          return { choices: result.data.choices };
        }
      }
    }
  };
}
openaiModule.default = OldStyleOpenAIConstructor;
const { default: OpenAI } = openaiModule;
if (!process.env.OPENAI_API_KEY) {
  console.error('Falta OPENAI_API_KEY');
  process.exit(1);
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------
// 2) Postgres
// ---------------------------
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: parseInt(process.env.PGPORT, 10),
  ssl: { rejectUnauthorized: false },
});

// ---------------------------
// 3) Redis
// ---------------------------
const redisClient = redis.createClient({
  url: process.env.REDIS_URL
});
redisClient.on('error', (err) => console.error('Redis Error:', err));
redisClient.on('ready', () => console.log('Redis pronto!'));
async function initRedis() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}

// ---------------------------
// 4) Tabelas + seeds
// ---------------------------
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      brand TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity INT NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES inventory(id),
      operation_type TEXT NOT NULL, -- ENTRADA ou SAÍDA
      quantity INT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      cost_in_real NUMERIC,
      cost_in_dollar NUMERIC,
      exchange_rate NUMERIC,
      patient_id INT,
      sale_type TEXT,
      paid BOOLEAN,
      payment_method TEXT,
      date_of_sale TIMESTAMP,
      sale_code TEXT
    );
  `);
  // ... e assim por diante ...
  console.log('DB ok!');
}

// ---------------------------
// 5) States in Redis
// ---------------------------
async function getState(user) {
  const val = await redisClient.get(`state:${user}`);
  return val ? JSON.parse(val) : {};
}
async function saveState(user, state) {
  await redisClient.set(`state:${user}`, JSON.stringify(state));
}

// ---------------------------
// 6) Lógica de parse manual
// ---------------------------
// Exemplo simples: "Quero 48 frascos de 1drop 6000 a 21k dolar"
function tryParseTransaction(userText) {
  // Procurar algo como "(\d+) frascos de (.*?)( a ([\d.]+)(k)? (reais|dolar|dólar))?"
  // É só um exemplo simples, pode precisar de melhorias
  const re = /(\d+)\s*frascos? de\s+([^\s]+)(?:.*?\b(\d+(?:\.\d+)?)\s*(k)?\s*(reais|dolar|dólar))?/i;
  const match = userText.match(re);
  if (!match) return null;

  const quantity = parseInt(match[1], 10);
  let brandOrProduct = match[2]; // ex: "1drop" ou "1drop 6000"
  // Valor
  let rawValue = match[3];
  const isK = match[4]; // se "k"
  const moneyType = match[5]; // "reais" ou "dolar"
  let costValue = null;
  if (rawValue) {
    // se for "21" e isK => 21000
    const baseNum = parseFloat(rawValue);
    costValue = isK ? baseNum * 1000 : baseNum;
  }

  let costInReal = null, costInDollar = null;
  if (moneyType) {
    const low = moneyType.toLowerCase();
    if (low.includes('real')) {
      costInReal = costValue;
    } else {
      costInDollar = costValue;
    }
  }
  return {
    quantity,
    brandOrProduct,
    costInReal,
    costInDollar
  };
}

// ---------------------------
// 7) handleUserMessage
// ---------------------------
async function handleUserMessage(userNumber, userText) {
  // 1) Ver se user quer algo do tipo "quero X frascos"
  let parsed = tryParseTransaction(userText);
  if (parsed) {
    // Supondo que seja SAÍDA
    // e assumimos brand="1DROP" se userText contém "1drop" etc...
    // Adapte a fuzi logic
    let brand = "1DROP";
    if (parsed.brandOrProduct.toLowerCase().includes("kannab")) brand = "KannabidiOil";
    // ou faça fuzzy se quiser
    // ...
    const costInReal = parsed.costInReal || 0;
    const costInDollar = parsed.costInDollar || 0;
    // 'patient_name' => ID=??? ou 0
    // Vamos inserir
    const resultMsg = await doInsertTransaction({
      brand,
      product_name: "1Drop 6000mg Full Spectrum 30ml", // for example
      quantity: parsed.quantity,
      operation_type: "SAÍDA",
      cost_in_real: costInReal,
      cost_in_dollar: costInDollar
    });
    return `Ok! ${resultMsg}`;
  }

  // 2) Se user diz "quantos 1drop temos?"
  if (/quantos.*1drop/i.test(userText)) {
    // do SELECT
    const selectMsg = await doSelectInventory("1DROP");
    return selectMsg;
  }

  // 3) Se user pergunta algo como "quanto vendemos no mes X"
  if (/quanto vendemos/i.test(userText)) {
    // Deixa GPT responder algo... Exemplo:
    const gptResp = await askGPT_ApenasConsultoria(userText);
    return gptResp;
  }

  // Senão, fallback
  return "Não entendi. Pode reformular?";
}

// Exemplo: Insert transaction
async function doInsertTransaction(fields) {
  // 1) Verifica se item existe em inventory
  const invRes = await pool.query(`
    SELECT id, quantity FROM inventory
    WHERE brand=$1 AND product_name=$2
  `, [fields.brand, fields.product_name]);

  let productId, newQty;
  if (invRes.rows.length > 0) {
    productId = invRes.rows[0].id;
    const current = invRes.rows[0].quantity || 0;
    if (fields.operation_type === 'ENTRADA') {
      newQty = current + fields.quantity;
    } else {
      newQty = current - fields.quantity;
      if (newQty < 0) newQty = 0;
    }
    await pool.query(`UPDATE inventory SET quantity=$1 WHERE id=$2`, [newQty, productId]);
  } else {
    // Se nao existe, cria
    const ins = await pool.query(`
      INSERT INTO inventory (brand, product_name, quantity)
      VALUES($1,$2,$3) RETURNING id
    `, [
      fields.brand,
      fields.product_name,
      (fields.operation_type === 'ENTRADA') ? fields.quantity : 0
    ]);
    productId = ins.rows[0].id;
    newQty = fields.quantity;
  }

  // Insert transactions
  const res = await pool.query(`
    INSERT INTO transactions(
      product_id, operation_type, quantity,
      cost_in_real, cost_in_dollar, exchange_rate
    ) VALUES($1,$2,$3,$4,$5,$6)
    RETURNING id
  `, [
    productId,
    fields.operation_type,
    fields.quantity,
    fields.cost_in_real || 0,
    fields.cost_in_dollar || 0,
    fields.exchange_rate || 5.0
  ]);
  return `Transação ID=${res.rows[0].id} inserida. Estoque = ${newQty}.`;
}

// Exemplo: SELECT inventory
async function doSelectInventory(brand) {
  const res = await pool.query(`
    SELECT * FROM inventory WHERE brand=$1
  `, [brand]);
  if (!res.rows.length) return `Não há itens da marca ${brand}.`;
  let msg = `Estoque da marca ${brand}:\n`;
  res.rows.forEach(r => {
    msg += `- ${r.product_name}: ${r.quantity}\n`;
  });
  return msg;
}

// Exemplo: GPT para perguntas livres
async function askGPT_ApenasConsultoria(text) {
  // Se user pergunta "quanto vendemos no mes X"
  // Chamamos GPT e deixamos ele responder livre
  const resp = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: "Você é um consultor de vendas, mas não gera JSON. Responda em português." },
      { role: 'user', content: text }
    ]
  });
  return resp.choices[0]?.message?.content || "Desculpe, não entendi.";
}

// ------------------------------------------------------
// 11) WA
// ------------------------------------------------------
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  }
});

client.on('qr', (qr) => {
  console.log('QR code gerado:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('WhatsApp pronto!');
  await initDB();
  await initRedis();
});

client.on('message', async (msg) => {
  try {
    // Se quiser filtrar ...
    const user = msg.from;
    const userText = msg.body;
    console.log(`[${user}]: ${userText}`);

    const resp = await handleUserMessage(user, userText);
    await msg.reply(resp);
  } catch(e) {
    console.error('Erro:', e);
    await msg.reply('Erro interno...');
  }
});

client.initialize();
