require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// ===============================
// 1) OPENAI "velha sintaxe"
// ===============================
const openaiModule = require('openai');
function OldStyleOpenAIConstructor({ apiKey }) {
  const { Configuration, OpenAIApi } = openaiModule;
  
  const configuration = new Configuration({ apiKey });
  const apiInstance = new OpenAIApi(configuration);

  return {
    chat: {
      completions: {
        create: async (params) => {
          const result = await apiInstance.createChatCompletion(params);
          return {
            choices: result.data.choices
          };
        }
      }
    }
  };
}
openaiModule.default = OldStyleOpenAIConstructor;
const { default: OpenAI } = openaiModule;

if (!process.env.OPENAI_API_KEY) {
  console.error('ERRO: OPENAI_API_KEY não definida!');
  process.exit(1);
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===============================
// 2) POSTGRES
// ===============================
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: parseInt(process.env.PGPORT, 10),
  ssl: { rejectUnauthorized: false },
});

// ===============================
// 3) REDIS (para memória curta da conversa)
// ===============================
const redis = require('redis');
const redisClient = redis.createClient({
  url: process.env.REDIS_URL // "redis://default:senha@redis.railway.internal:6379"
});
redisClient.on('error', (err) => console.error('Erro no Redis:', err));
redisClient.on('connect', () => console.log('Redis: conectando...'));
redisClient.on('ready', () => console.log('Redis: conectado e pronto!'));

async function initRedis() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
    console.log('Conectado ao Redis!');
  }
}

// ===============================
// 4) Funções para armazenar/ler histórico no Redis
// ===============================
const MAX_MESSAGES = 6; // quantas mensagens recentes manter

async function getConversationHistory(userNumber) {
  const key = `conversationHistory:${userNumber}`;
  const json = await redisClient.get(key);
  if (!json) {
    return [];
  }
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

async function saveConversationHistory(userNumber, historyArray) {
  const key = `conversationHistory:${userNumber}`;
  await redisClient.set(key, JSON.stringify(historyArray));
}

// ===============================
// 5) Cria tabelas + seeds no Postgres
// ===============================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS official_products (
      id SERIAL PRIMARY KEY,
      brand TEXT NOT NULL,
      canonical_name TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS patients (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT,
      user_gov TEXT,
      password_gov TEXT,
      medico TEXT,
      endereco TEXT,
      prescricao TEXT,
      data_anvisa DATE,
      data_expiracao DATE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      brand TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES inventory(id),
      operation_type TEXT NOT NULL, -- ENTRADA ou SAÍDA
      quantity INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),

      patient_id INTEGER REFERENCES patients(id),
      cost_in_real NUMERIC,
      cost_in_dollar NUMERIC,
      exchange_rate NUMERIC,

      sale_type TEXT,
      paid BOOLEAN,
      payment_method TEXT,
      date_of_sale TIMESTAMP,
      sale_code TEXT
    );
  `);

  console.log('Tabelas criadas/atualizadas se não existiam.');

  // Seeds
  const seedProducts = [
    ['1DROP', '1Drop 1500mg Full Spectrum 30ml'],
    ['1DROP', '1Drop 2100mg (1500mg Full Spectrum + 300mg CBG + 300mg D8-THC) 30ml'],
    ['1DROP', '1Drop 2250mg BroadSpectrum (1500mg Full Spectrum + 750mg CBG) com zero THC 30ml'],
    ['1DROP', '1Drop 6000mg CBD Isolado 30ml'],
    ['1DROP', '1Drop 6000mg Full Spectrum 30ml'],
    ['1DROP', '1Drop Gummies 900mg/30 unidades por frasco 10:1:1 (750mg de CBD + 75mg de D9-THC + 75mg de CBG) Full Spectrum Zero Açúcar'],
    ['KannabidiOil', 'KannabidiOil 1800mg (1500mg Full Spectrum +300mg CBN + Melatonina) 30ml'],
    ['KannabidiOil', 'KannabidiOil 1800mg (1500mg Full Spectrum e +300mg D8-THC) + Vitamina D 30ml'],
    ['KannabidiOil', 'KannabidiOil Gummies BLISS+ 1050mg/30un (25mg de CBD, 5mg de D9-THC e 5mg de CBG por bala)'],
    ['KannabidiOil', 'KannabidiOil Gummies ANS+ 1050mg/30un (25mg de CBD, 5mg de D9-THC e 5mg de CBN por bala)'],
    ['KannabidiOil', 'KannabidiOil Gummies 600mg/10un (50mg de cbd, 5mg de D9-THC e 5mg de CBG)'],
    ['LIBERI', 'LIBERI 6000mg CBD Isolado (+Vitamina D)'],
    ['LIBERI', 'LIBERI 1800mg (1500mg de Full Spectrum + 300mg de D8-THC) 30ml'],
    ['VITA10', 'VITA10 3000mg Full Spectrum'],
  ];
  for (const [brand, canonical_name] of seedProducts) {
    await pool.query(`
      INSERT INTO official_products (brand, canonical_name)
      SELECT $1, $2
      WHERE NOT EXISTS (
        SELECT 1 FROM official_products WHERE brand=$1 AND canonical_name=$2
      )
    `, [brand, canonical_name]);
  }
  console.log('Seeds de official_products inseridos (se faltava).');
}

// ===============================
// 6) System Prompt
// ===============================
const systemPrompt = `
Você é um assistente que gerencia estoque e vendas de produtos à base de CBD em um banco de dados **PostgreSQL**.

### Tabelas válidas:
- "patients"
- "inventory"
- "transactions"
- "official_products"

(NUNCA use "stock", "table":"stock" ou outra variação que não esteja na lista acima.)

### Campos obrigatórios para "transactions" (INSERT):
- "brand": string
- "product_name": string (ex: "1Drop 6000mg Full Spectrum 30ml")
- "quantity": número
- "operation_type": "ENTRADA" ou "SAÍDA"
- "patient_name": string
- "cost_in_real" ou "cost_in_dollar"
- "exchange_rate" (pode ser 5.0 se não tiver outro valor)

### Exemplo de JSON correto para SAÍDA:
\`\`\`
{
  "operation":"INSERT",
  "table":"transactions",
  "fields":{
    "brand":"1DROP",
    "product_name":"1Drop 6000mg Full Spectrum 30ml",
    "quantity":2,
    "operation_type":"SAÍDA",
    "patient_name":"Fulano de Tal",
    "sale_type":"Portaria",
    "paid":true,
    "payment_method":"pix",
    "date_of_sale":"2025-03-01 10:00:00",
    "cost_in_real":2000,
    "cost_in_dollar":0,
    "exchange_rate":5.2
  }
}
\`\`\`

### Regras:
1) Sempre responda com uma frase explicando o que entendeu/fará + um bloco de JSON \`\`\`.
2) Se faltarem dados, peça ao usuário e use "operation":"NONE".
3) Se o usuário falar "dar alta de X frascos" ou "quero vender Y frascos", é "operation_type":"SAÍDA".
4) Se falar "comprei" ou "entrada", é "operation_type":"ENTRADA".
5) Se o usuário der um nome de produto informal (ex: "1drop 6000fs"), converta para "1Drop 6000mg Full Spectrum 30ml" (ou pergunte).
6) Para SELECT, se o usuário disser "estoque atual", faça "operation":"SELECT", "table":"inventory", "where": { ... }.
7) Se o usuário mandar algo genérico como "quanto vendemos em abril", use "operation":"SELECT", "table":"transactions", e "fields":{"aggregate":"SUM(cost_in_real)"} e datas etc.

Boa sorte!
`;

// ===============================
// 7) askGPT => usando histórico
// ===============================
async function askGPT(userNumber, userText) {
  // Carrega histórico
  let history = await getConversationHistory(userNumber);

  // Nova msg do usuário
  history.push({ role: 'user', content: userText });
  while (history.length > MAX_MESSAGES) {
    history.shift();
  }

  // Monta arr final
  const messagesForGPT = [
    { role: 'system', content: systemPrompt },
    ...history
  ];

  // Chama GPT
  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: messagesForGPT
  });
  const fullAnswer = response.choices[0]?.message?.content || '';

  // Armazena resposta
  history.push({ role: 'assistant', content: fullAnswer });
  while (history.length > MAX_MESSAGES) {
    history.shift();
  }
  await saveConversationHistory(userNumber, history);

  // Extrai JSON (com fallback)
  const jsonPart = extractJsonBlock(fullAnswer);

  return { fullAnswer, jsonPart };
}

// ===============================
// Regex fallback
// ===============================
function extractJsonBlock(fullAnswer) {
  // 1) Tenta triple backticks
  const tripleRegex = /```([\s\S]+)```/;
  const tripleMatch = fullAnswer.match(tripleRegex);
  if (tripleMatch) {
    return tripleMatch[1].trim();
  }

  // 2) Tenta "json" e captura do 1o '{' até a última '}'
  //    De forma bem agressiva (pode haver multiline).
  //    Exemplo: "json\n{ ... }"
  const fallbackRegex = /json[\s\S]*?(\{[\s\S]+\})/;
  const fallbackMatch = fullAnswer.match(fallbackRegex);
  if (fallbackMatch) {
    return fallbackMatch[1].trim();
  }

  return null;
}

// ===============================
// 8) handleUserMessage
// ===============================
async function handleUserMessage(userNumber, userText) {
  const { fullAnswer, jsonPart } = await askGPT(userNumber, userText);

  let dbMsg = 'Nenhuma operação de BD detectada.';
  if (jsonPart) {
    const fixedJson = fixJsonCommonIssues(jsonPart);
    dbMsg = await executeDbOperation(fixedJson);
  }

  return `${fullAnswer}\n\n[DB INFO]: ${dbMsg}`;
}

// ===============================
// 9) Corrige problemas
// ===============================
function fixJsonCommonIssues(jsonStr) {
  let fixed = jsonStr.replace(/"table":"stock"/gi, '"table":"inventory"');
  fixed = fixed.replace(/cost_in_usd/gi, 'cost_in_dollar');
  return fixed;
}

// ===============================
// 10) EXECUTA OPERAÇÃO NO BD
// ===============================
async function executeDbOperation(jsonStr) {
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (err) {
    console.error('ERRO parse JSON:', err, jsonStr);
    return 'JSON inválido ou erro ao fazer parse.';
  }

  const { operation, table, fields = {}, where = {} } = data;
  if (!operation || operation === 'NONE') {
    return 'O GPT decidiu que não há nada para fazer.';
  }

  // Fuzzy matching se for Insert em transactions
  if (operation === 'INSERT' && table === 'transactions' && fields.product_name) {
    const bestName = await findClosestProductName(fields.brand, fields.product_name);
    if (bestName && bestName !== fields.product_name) {
      console.log(`Corrigindo product_name de "${fields.product_name}" para "${bestName}".`);
      fields.product_name = bestName;
    }
  }

  switch (operation) {
    case 'INSERT':
      return await handleInsert(table, fields);
    case 'UPDATE':
      return await handleUpdate(table, fields, where);
    case 'DELETE':
      return await handleDelete(table, where);
    case 'SELECT':
      return await handleSelect(table, where, fields);
    default:
      return `Operação '${operation}' não reconhecida.`;
  }
}

// ===============================
// 11) Fuzzy matching
// ===============================
async function findClosestProductName(brand, userProductName) {
  if (!brand) return null;
  const res = await pool.query(`
    SELECT canonical_name
    FROM official_products
    WHERE brand ILIKE $1
  `, [brand]);
  if (res.rows.length === 0) {
    return null;
  }
  let bestScore = -1;
  let bestName = null;
  for (const row of res.rows) {
    const score = stringSimilarity(row.canonical_name, userProductName);
    if (score > bestScore) {
      bestScore = score;
      bestName = row.canonical_name;
    }
  }
  return bestName;
}
function stringSimilarity(a, b) {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  let matches = 0;
  for (let ch of bb) {
    if (aa.includes(ch)) matches++;
  }
  return matches / aa.length;
}

// ===============================
// 12) Handlers
// ===============================
async function handleInsert(table, f) {
  if (table === 'patients') return insertPatient(f);
  if (table === 'transactions') return insertTransaction(f);
  return `INSERT em '${table}' não implementado.`;
}

async function insertPatient(fields) {
  const {
    full_name,
    email,
    user_gov,
    password_gov,
    medico,
    endereco,
    prescricao,
    data_anvisa,
    data_expiracao
  } = fields;

  if (!full_name) {
    return 'Falta "full_name".';
  }

  const res = await pool.query(`
    INSERT INTO patients(
      full_name, email, user_gov, password_gov, medico,
      endereco, prescricao, data_anvisa, data_expiracao
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING id
  `, [
    full_name || null,
    email || null,
    user_gov || null,
    password_gov || null,
    medico || null,
    endereco || null,
    prescricao || null,
    data_anvisa || null,
    data_expiracao || null
  ]);
  return `Paciente inserido com ID=${res.rows[0].id}.`;
}

async function insertTransaction(fields) {
  const {
    brand,
    product_name,
    quantity,
    operation_type,
    patient_name,
    cost_in_real,
    cost_in_dollar,
    exchange_rate,
    sale_type,
    paid,
    payment_method,
    date_of_sale,
    sale_code
  } = fields;
  if (!brand || !product_name || !quantity || !operation_type || !patient_name) {
    return 'Faltam campos obrigatórios.';
  }

  // Verifica paciente
  const pat = await pool.query(`SELECT id FROM patients WHERE full_name ILIKE $1`, [patient_name]);
  if (pat.rows.length === 0) {
    return `Paciente '${patient_name}' não encontrado.`;
  }
  const patientId = pat.rows[0].id;

  // Inventory
  const inv = await pool.query(`
    SELECT id, quantity FROM inventory
    WHERE brand=$1 AND product_name=$2
  `, [brand, product_name]);

  let productId;
  let newQty;
  if (inv.rows.length > 0) {
    productId = inv.rows[0].id;
    const current = inv.rows[0].quantity || 0;
    if (operation_type === 'ENTRADA') {
      newQty = current + quantity;
    } else {
      newQty = current - quantity;
      if (newQty < 0) newQty = 0;
    }
    await pool.query(`UPDATE inventory SET quantity=$1 WHERE id=$2`, [newQty, productId]);
  } else {
    const ins = await pool.query(`
      INSERT INTO inventory(brand, product_name, quantity)
      VALUES($1,$2,$3) RETURNING id
    `, [
      brand,
      product_name,
      operation_type === 'ENTRADA' ? quantity : 0
    ]);
    productId = ins.rows[0].id;
    newQty = quantity;
  }

  // Custos
  const fx = exchange_rate ? Number(exchange_rate) : 5.0;
  let cReal = cost_in_real ? Number(cost_in_real) : 0;
  let cDollar = cost_in_dollar ? Number(cost_in_dollar) : 0;
  if (cReal === 0 && cDollar > 0) {
    cReal = cDollar * fx;
  } else if (cDollar === 0 && cReal > 0) {
    cDollar = cReal / fx;
  }

  // Data
  let finalDate = date_of_sale ? new Date(date_of_sale) : null;
  if (!finalDate || isNaN(finalDate.getTime())) {
    if (operation_type === 'SAÍDA') {
      finalDate = new Date();
    } else {
      finalDate = null;
    }
  }

  const tr = await pool.query(`
    INSERT INTO transactions(
      product_id, operation_type, quantity,
      patient_id, cost_in_real, cost_in_dollar, exchange_rate,
      sale_type, paid, payment_method, date_of_sale, sale_code
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id
  `, [
    productId, operation_type, quantity,
    patientId, cReal, cDollar, fx,
    sale_type || null,
    (paid === true || paid === "true") ? true : false,
    payment_method || null,
    finalDate,
    sale_code || null
  ]);

  return `Transação inserida (ID=${tr.rows[0].id}). Estoque de "${brand} / ${product_name}" agora é ${newQty}.`;
}

async function handleUpdate(table, fields, where) {
  if (!Object.keys(where).length) {
    return 'WHERE não informado.';
  }
  const setParts = [];
  const vals = [];
  let idx = 1;
  for (const [k,v] of Object.entries(fields)) {
    setParts.push(`${k}=$${idx++}`);
    vals.push(v);
  }
  const whereParts = [];
  for (const [k,v] of Object.entries(where)) {
    whereParts.push(`${k}=$${idx++}`);
    vals.push(v);
  }
  const sql = `UPDATE ${table} SET ${setParts.join(', ')} WHERE ${whereParts.join(' AND ')}`;
  await pool.query(sql, vals);
  return `Registro(s) atualizado(s) em ${table}.`;
}

async function handleDelete(table, where) {
  if (!Object.keys(where).length) {
    return 'WHERE não informado.';
  }
  const clauses = [];
  const vals = [];
  Object.entries(where).forEach(([k,v], i) => {
    clauses.push(`${k}=$${i+1}`);
    vals.push(v);
  });
  const sql = `DELETE FROM ${table} WHERE ${clauses.join(' AND ')}`;
  await pool.query(sql, vals);
  return `DELETE realizado em ${table} (where: ${JSON.stringify(where)})`;
}

async function handleSelect(table, where, fields) {
  const { aggregate, date_start, date_end } = fields;
  let sel = '*';
  if (aggregate) {
    sel = `${aggregate} as result`;
  }
  let sql = `SELECT ${sel} FROM ${table}`;
  const vals = [];
  const clauses = [];

  // Se for transactions e tiver date_start / date_end
  if (table === 'transactions') {
    if (date_start) {
      clauses.push(`date_of_sale >= $${vals.length+1}`);
      vals.push(date_start);
    }
    if (date_end) {
      clauses.push(`date_of_sale <= $${vals.length+1}`);
      vals.push(date_end);
    }
  }
  for (const [k,v] of Object.entries(where)) {
    clauses.push(`${k}=$${vals.length+1}`);
    vals.push(v);
  }
  if (clauses.length > 0) {
    sql += ` WHERE ` + clauses.join(' AND ');
  }
  const res = await pool.query(sql, vals);

  if (aggregate) {
    if (res.rows.length > 0 && res.rows[0].result != null) {
      return `Resultado do ${aggregate}: ${res.rows[0].result}`;
    } else {
      return `Resultado do ${aggregate}: 0 (ou nada encontrado)`;
    }
  }
  if (res.rows.length === 0) {
    return 'Nenhum resultado encontrado.';
  }
  return JSON.stringify(res.rows, null, 2);
}

// ===============================
// 13) Configura WA
// ===============================
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

client.on('qr', (qr) => {
  console.log('QR Code gerado, aponte a câmera do WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('Bot conectado ao WhatsApp!');
  // Inicia Redis e Postgres
  await initRedis();
  await initDB();
});

const allowedNumbers = [
  // '555199999999@c.us'
];

client.on('message', async (msg) => {
  try {
    if (allowedNumbers.length > 0 && !allowedNumbers.includes(msg.from)) {
      return;
    }
    const userNumber = msg.from;
    const userText = msg.body;
    console.log(`[MSG de ${userNumber}]: ${userText}`);

    const responseText = await handleUserMessage(userNumber, userText);
    await msg.reply(responseText);

  } catch (err) {
    console.error('Erro ao processar msg:', err);
    await msg.reply('Desculpe, ocorreu um erro ao processar sua solicitação.');
  }
});

client.initialize();
