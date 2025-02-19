require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// ------------------------------------------------------
// HACK para simular a sintaxe antiga do "OpenAI".
// ------------------------------------------------------
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

// Verifica se temos a chave da OpenAI
if (!process.env.OPENAI_API_KEY) {
  console.error('ERRO: OPENAI_API_KEY não definida!');
  process.exit(1);
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------------------------------------------------
// Conexão ao PostgreSQL (usando pg Pool)
// ------------------------------------------------------
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: parseInt(process.env.PGPORT, 10),
  ssl: { rejectUnauthorized: false },
});

// ------------------------------------------------------
// Conexão ao Redis (para armazenar estado da conversa)
// ------------------------------------------------------
const redis = require('redis');
const redisClient = redis.createClient({
  url: process.env.REDIS_URL // ex: "redis://default:senha@host:port"
});
redisClient.on('error', (err) => console.error('Redis Client Error', err));

// Inicializa o Redis
async function initRedis() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}

// ------------------------------------------------------
// Cria tabelas no PostgreSQL (se não existirem) e seeds
// ------------------------------------------------------
async function initDB() {
  // Tabela de produtos oficiais
  await pool.query(`
    CREATE TABLE IF NOT EXISTS official_products (
      id SERIAL PRIMARY KEY,
      brand TEXT NOT NULL,
      canonical_name TEXT NOT NULL
    );
  `);

  // Tabela de pacientes
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

  // Tabela de estoque
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      brand TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Tabela de transações
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

      sale_type TEXT,    -- "Sedex", "Portaria", etc.
      paid BOOLEAN,
      payment_method TEXT,
      date_of_sale TIMESTAMP,
      sale_code TEXT
    );
  `);

  console.log('Tabelas criadas/atualizadas se não existiam.');

  // Seeds de 'official_products'
  const seedProducts = [
    ['1DROP', '1Drop 1500mg Full Spectrum 30ml'],
    ['1DROP', '1Drop 2100mg (1500mg Full Spectrum + 300mg CBG + 300mg D8-THC) 30ml'],
    ['1DROP', '1Drop 2250mg BroadSpectrum (1500mg Full Spectrum + 750mg CBG) com zero THC 30ml'],
    ['1DROP', '1Drop 6000mg CBD Isolado 30ml'],
    ['1DROP', '1Drop 6000mg Full Spectrum 30ml'],
    ['1DROP', '1Drop Gummies 900mg/30 unidades por frasco 10:1:1 (750mg de CBD + 75mg de D9-THC + 75mg de CBG por frasco) Full Spectrum Zero Açúcar'],
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

// ------------------------------------------------------
// "Melhoramos a inteligência" adicionando instruções
// ao systemPrompt para lidar com soma, contagens,
// e intervalos de datas (se o GPT mandar).
// ------------------------------------------------------
const systemPrompt = `
Você é um assistente que gerencia estoque e vendas de produtos à base de CBD (com dados no PostgreSQL).

**Marcas válidas**: 1DROP, KannabidiOil, LIBERI, VITA10.

**Formas de Operação**:
- ENTRADA (compra/importação) associada a paciente ANVISA
- SAÍDA (venda para paciente/cliente), com:
  - sale_type: "Sedex", "Portaria" ou "Envio Direto"
  - date_of_sale: se não informada, usar data/hora atual
  - paid: true/false
  - payment_method: "pix", "credito", "debito", "dinheiro", "doacao", etc.

**Se faltarem dados essenciais**, peça ao usuário.

**Formato de resposta**:
1) Breve frase em português explicando o que fará.
2) Bloco de JSON \`\`\`
3) Se faltam dados, "operation":"NONE".

**Consultas extras**:
- Para saber o total em Real, use "SELECT" com "aggregate":"SUM(cost_in_real)" ou "SUM(quantity)".
- Para filtrar por datas, inclua "date_start" e "date_end" em fields ou where.

Exemplo:
\`\`\`
{
  "operation":"SELECT",
  "table":"transactions",
  "fields":{
    "aggregate":"SUM(cost_in_real)",
    "date_start":"2025-01-01",
    "date_end":"2025-01-31"
  },
  "where":{
    "operation_type":"SAÍDA"
  }
}
\`\`\`
`;

// ------------------------------------------------------
// Resgata do Redis a pendingOperation (se existir)
// ------------------------------------------------------
async function getPendingOperation(userNumber) {
  const key = `pendingOp:${userNumber}`;
  return await redisClient.get(key); // retorna string ou null
}

// ------------------------------------------------------
// Seta no Redis a pendingOperation
// ------------------------------------------------------
async function setPendingOperation(userNumber, operationText) {
  const key = `pendingOp:${userNumber}`;
  if (!operationText) {
    // limpar
    await redisClient.del(key);
  } else {
    // salvar
    await redisClient.set(key, operationText);
  }
}

// ------------------------------------------------------
// Função que chama ChatGPT e extrai JSON
// ------------------------------------------------------
async function processUserMessage(userNumber, userMessage) {
  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ]
  });

  const fullAnswer = response.choices[0]?.message?.content || '';

  // Extrair JSON de dentro de ``` ```
  const jsonRegex = /```([^`]+)```/s;
  const match = fullAnswer.match(jsonRegex);
  let jsonPart = null;
  if (match) {
    jsonPart = match[1].trim();
  }

  return { fullAnswer, jsonPart };
}

// ------------------------------------------------------
// Principal: Decide se há pendências, chama GPT, etc.
// ------------------------------------------------------
async function handleUserMessage(userNumber, userMsg) {
  // 1) Verifica se há algo pendente
  let pending = await getPendingOperation(userNumber);

  if (pending) {
    // Combina pendência + msg do user
    const combinedMsg = `${pending}\n\nUsuário diz agora: "${userMsg}"`;

    const { fullAnswer, jsonPart } = await processUserMessage(userNumber, combinedMsg);
    let dbMsg = '';
    if (jsonPart) {
      dbMsg = await executeDbOperation(jsonPart, userNumber);
    }

    // Se não tem mais dados pendentes
    if (!dbMsg.includes('faltam dados') && !dbMsg.includes('aguardando')) {
      await setPendingOperation(userNumber, null); // limpa pendência
    }

    return `${fullAnswer}\n\n[DB INFO]: ${dbMsg}`;
  }

  // 2) Se não há pendência, chama GPT diretamente
  const { fullAnswer, jsonPart } = await processUserMessage(userNumber, userMsg);
  let dbResult = 'Nenhuma operação de BD detectada.';

  if (jsonPart) {
    dbResult = await executeDbOperation(jsonPart, userNumber);

    // Se ainda faltar dados, mantemos a pendência
    if (dbResult.includes('faltam dados') || dbResult.includes('por favor forneça')) {
      await setPendingOperation(userNumber, userMsg); 
    }
  }

  return `${fullAnswer}\n\n[DB INFO]: ${dbResult}`;
}

// ------------------------------------------------------
// EXECUTA OPERAÇÕES NO BD (com algumas melhorias)
// ------------------------------------------------------
async function executeDbOperation(jsonStr, userNumber) {
  if (!jsonStr) return 'Nenhuma operação de BD detectada.';
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (err) {
    return 'JSON inválido ou erro ao fazer parse.';
  }

  const { operation, table, fields = {}, where = {} } = data;
  if (!operation || operation === 'NONE') {
    return 'O GPT decidiu que não há nada para fazer no BD (ou aguarda dados).';
  }

  switch (operation) {
    case 'INSERT':
      return await handleInsert(table, fields);

    case 'UPDATE':
      return await handleUpdate(table, fields, where);

    case 'DELETE':
      return await handleDelete(table, where);

    case 'SELECT':
      // Aqui adicionamos lógica extra para SUM, COUNT, date ranges etc.
      return await handleSelect(table, where, fields);

    default:
      return `Operação '${operation}' não reconhecida ou não implementada.`;
  }
}

// ------------------------------------------------------
// Handlers de INSERT / UPDATE / DELETE / SELECT
// ------------------------------------------------------

// 1) INSERT
async function handleInsert(table, fields) {
  switch (table) {
    case 'patients':
      return await insertPatient(fields);
    case 'transactions':
      return await insertTransaction(fields);
    default:
      return `INSERT em '${table}' não implementado.`;
  }
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
    return 'Falta o nome completo (full_name). Por favor forneça ou confirme que deseja inserir sem esse dado.';
  }

  const insertRes = await pool.query(`
    INSERT INTO patients (
      full_name, email, user_gov, password_gov, medico,
      endereco, prescricao, data_anvisa, data_expiracao
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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

  return `Paciente inserido com ID=${insertRes.rows[0].id}.`;
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

  if (!brand || !product_name || !quantity || !operation_type) {
    return 'Campos insuficientes para inserir transação (brand/product_name/quantity/operation_type).';
  }
  if (!patient_name) {
    return 'Falta o nome do paciente (patient_name). Por favor forneça ou confirme que deseja inserir sem esse dado.';
  }

  // Busca paciente
  const patRes = await pool.query(`SELECT id FROM patients WHERE full_name ILIKE $1`, [patient_name]);
  if (patRes.rows.length === 0) {
    return `Paciente '${patient_name}' não encontrado. Cadastre-o primeiro ou corrija o nome.`;
  }
  const patientId = patRes.rows[0].id;

  // Verifica se já existe no inventory
  const invRes = await pool.query(`
    SELECT id, quantity FROM inventory
    WHERE brand=$1 AND product_name=$2
  `, [brand, product_name]);

  let productId;
  let newQty;
  if (invRes.rows.length > 0) {
    productId = invRes.rows[0].id;
    const currentQ = invRes.rows[0].quantity || 0;
    if (operation_type === 'ENTRADA') {
      newQty = currentQ + quantity;
    } else {
      newQty = currentQ - quantity;
      if (newQty < 0) {
        newQty = 0; // ou poderia barrar se quiser
      }
    }
    await pool.query(`UPDATE inventory SET quantity=$1 WHERE id=$2`, [newQty, productId]);
  } else {
    // Se não existe, criar
    const invInsert = await pool.query(`
      INSERT INTO inventory (brand, product_name, quantity)
      VALUES ($1,$2,$3) RETURNING id
    `, [
      brand,
      product_name,
      (operation_type === 'ENTRADA') ? quantity : 0
    ]);
    productId = invInsert.rows[0].id;
    newQty = quantity;
  }

  // Calcular custos
  const fx = exchange_rate ? Number(exchange_rate) : 5.0;
  let cReal = cost_in_real ? Number(cost_in_real) : 0;
  let cDollar = cost_in_dollar ? Number(cost_in_dollar) : 0;
  if (cReal === 0 && cDollar > 0) {
    cReal = cDollar * fx;
  } else if (cDollar === 0 && cReal > 0) {
    cDollar = cReal / fx;
  }

  // Data da venda
  let finalDateSale = date_of_sale ? new Date(date_of_sale) : null;
  if (!finalDateSale || isNaN(finalDateSale.getTime())) {
    if (operation_type === 'SAÍDA') {
      finalDateSale = new Date();
    } else {
      finalDateSale = null;
    }
  }

  const transRes = await pool.query(`
    INSERT INTO transactions (
      product_id, operation_type, quantity,
      patient_id, cost_in_real, cost_in_dollar, exchange_rate,
      sale_type, paid, payment_method, date_of_sale, sale_code
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id
  `, [
    productId, operation_type, quantity,
    patientId, cReal, cDollar, fx,
    sale_type || null,
    (paid === true || paid === "true") ? true : false,
    payment_method || null,
    finalDateSale,
    sale_code || null
  ]);

  const tid = transRes.rows[0].id;
  return `Transação ID=${tid} inserida. Estoque de ${brand} / ${product_name} agora é ${newQty}.`;
}

// 2) UPDATE
async function handleUpdate(table, fields, where) {
  if (!Object.keys(where).length) {
    return 'WHERE não informado para UPDATE.';
  }

  const setParts = [];
  const vals = [];
  let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    setParts.push(`${k}=$${idx++}`);
    vals.push(v);
  }
  const whereParts = [];
  for (const [k, v] of Object.entries(where)) {
    whereParts.push(`${k}=$${idx++}`);
    vals.push(v);
  }
  const sql = `UPDATE ${table} SET ${setParts.join(', ')} WHERE ${whereParts.join(' AND ')}`;

  await pool.query(sql, vals);
  return `Registro(s) atualizado(s) em ${table}.`;
}

// 3) DELETE
async function handleDelete(table, where) {
  if (!Object.keys(where).length) {
    return 'WHERE não informado para DELETE.';
  }

  const clauses = [];
  const vals = [];
  Object.entries(where).forEach(([k,v], i) => {
    clauses.push(`${k}=$${i+1}`);
    vals.push(v);
  });
  const sqlDel = `DELETE FROM ${table} WHERE ${clauses.join(' AND ')}`;
  await pool.query(sqlDel, vals);

  return `DELETE realizado em ${table} (where: ${JSON.stringify(where)})`;
}

// 4) SELECT (com possíveis agregados e intervalos de datas)
async function handleSelect(table, where, fields) {
  // "fields.aggregate" pode ser algo como "SUM(cost_in_real)" ou "COUNT(*)"
  // "fields.date_start" e "fields.date_end" podem existir para filtrar datas
  const { aggregate, date_start, date_end } = fields;

  // Monta SELECT
  let selectClause = '*';
  if (aggregate) {
    selectClause = `${aggregate} as result`; 
  }

  let sql = `SELECT ${selectClause} FROM ${table}`;
  const vals = [];
  const clauses = [];

  // Se for transactions, e tiver date_start ou date_end, filtramos date_of_sale
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

  // Filtros do "where"
  Object.entries(where).forEach(([k,v]) => {
    // Ex: { operation_type: "SAÍDA" }
    clauses.push(`${k}=$${vals.length+1}`);
    vals.push(v);
  });

  if (clauses.length > 0) {
    sql += ` WHERE ` + clauses.join(' AND ');
  }

  const res = await pool.query(sql, vals);

  // Se foi um aggregate, retornamos o valor
  if (aggregate) {
    if (res.rows.length === 0 || res.rows[0].result === null) {
      return `Resultado do agregado = 0 ou sem linhas.`;
    }
    return `Resultado da agregação: ${res.rows[0].result}`;
  }

  // Se não for agregação
  if (!res.rows.length) {
    return 'Nenhum resultado encontrado.';
  }
  // Retorna JSON
  return JSON.stringify(res.rows, null, 2);
}

// ------------------------------------------------------
// Configura o cliente WhatsApp
// ------------------------------------------------------
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
  console.log('QR Code gerado, aponte a câmera do WhatsApp para autenticar:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('Bot conectado com sucesso!');
  await initRedis();
  await initDB();
});

const allowedNumbers = [
  // Se quiser restringir, insira no formato ex: '555199999999@c.us'
];

client.on('message', async (msg) => {
  try {
    // Filtrar por allowedNumbers
    if (allowedNumbers.length > 0 && !allowedNumbers.includes(msg.from)) {
      return;
    }

    const userNumber = msg.from;
    const userText = msg.body;
    console.log(`Mensagem de ${userNumber}: ${userText}`);

    const responseText = await handleUserMessage(userNumber, userText);
    await msg.reply(responseText);

  } catch (err) {
    console.error('Erro ao processar mensagem:', err);
    await msg.reply('Desculpe, ocorreu um erro ao processar sua solicitação.');
  }
});

client.initialize();
