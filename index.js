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

// ------------------------------------------------------
// Inicializa a "OpenAI" com sintaxe antiga
// ------------------------------------------------------
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
// Tabelas e inicialização
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

  // Tabela de transações (entradas e saídas).
  // Acrescentamos campos específicos de SAÍDA:
  //  - sale_type (Sedex, Portaria, EnvioDireto)
  //  - paid (boolean)
  //  - payment_method (pix, credito, debito, dinheiro, doacao, etc.)
  //  - date_of_sale (timestamp)
  //  - sale_code: para agrupar itens de uma mesma venda
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES inventory(id),
      operation_type TEXT NOT NULL, -- ENTRADA ou SAÍDA
      quantity INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),

      patient_id INTEGER REFERENCES patients(id),  -- Paciente ANVISA ou comprador
      cost_in_real NUMERIC,
      cost_in_dollar NUMERIC,
      exchange_rate NUMERIC,

      sale_type TEXT,           -- "Sedex", "Portaria", "Envio Direto" (só se SAÍDA)
      paid BOOLEAN,             -- se está pago ou não
      payment_method TEXT,      -- forma de pagamento
      date_of_sale TIMESTAMP,   -- data da saída
      sale_code TEXT            -- código pra agrupar múltiplos itens
    );
  `);

  console.log('Tabelas criadas/atualizadas se não existiam.');

  // Inserção de produtos oficiais (seed)
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
// Memória de Conversa simples em RAM
// (em produção, poderia ser Redis, DB, etc.)
// ------------------------------------------------------
const conversationState = {}; 
// Estrutura: conversationState[waNumber] = { pendingOperation: {...}, ... }

// ------------------------------------------------------
// Prompt do GPT
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
- Podem ser vários produtos numa só operação (nesse caso, gerar multiple inserts ou uma convenção de "sale_code").

**Se faltarem dados essenciais**, você deve perguntar ao usuário se ele quer fornecer ou se prefere gravar assim mesmo.

**Exemplo de JSON** (saída/venda de 3 frascos):
\`\`\`
{
  "operation":"INSERT",
  "table":"transactions",
  "fields":{
    "brand":"1DROP",
    "product_name":"1Drop 6000mg Full Spectrum 30ml",
    "quantity":3,
    "operation_type":"SAÍDA",
    "patient_name":"Fulano de Tal",
    "sale_type":"Sedex",
    "paid":true,
    "payment_method":"pix",
    "date_of_sale":"2025-02-19 10:30:00",
    "cost_in_real":1950,
    "cost_in_dollar":0,
    "exchange_rate":5.2,
    "sale_code":"VENDA-XYZ"
  }
}
\`\`\`

**Consultas**:
- Perguntas do tipo "Quanto vendemos no mês X?" => utilize "operation":"SELECT" com alguma query que faça soma do cost_in_real etc.
- Perguntas do tipo "quantos medicamentos X vendemos entre datas Y e Z?" => outro SELECT com WHERE e SUM ou COUNT.

**Formato de resposta**:
1) Breve frase em português
2) Bloco de JSON \`\`\`
3) Se faltam dados, pergunte e use "operation":"NONE" (ou algo que indique que aguarda info).

Boa sorte!
`;

// ------------------------------------------------------
// Função que chama ChatGPT e extrai JSON
// ------------------------------------------------------
async function processUserMessage(userNumber, userMessage) {
  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: systemPrompt },
      // Podendo incluir parte do histórico, se desejar
      { role: 'user', content: userMessage }
    ]
  });

  const fullAnswer = response.choices[0]?.message?.content || '';

  // Extraímos o JSON
  const jsonRegex = /```([^`]+)```/s;
  const match = fullAnswer.match(jsonRegex);
  let jsonPart = null;
  if (match) {
    jsonPart = match[1].trim();
  }

  return { fullAnswer, jsonPart };
}

// ------------------------------------------------------
// Função principal que decide se há pendências
// e lida com a persistência no BD.
// ------------------------------------------------------
async function handleUserMessage(userNumber, userMsg) {
  // Verifica se já temos uma operação pendente para este usuário
  const userSession = conversationState[userNumber] || {};

  // 1) Se temos algo pendente e o usuário está fornecendo infos:
  if (userSession.pendingOperation) {
    // Tentar ver se o user completou os dados faltantes
    // (exemplo simplificado: assumimos que se user manda "o método de pagamento é pix",
    // então completamos "payment_method":"pix" e finalizamos.)
    // Nesse exemplo, iremos só delegar novamente ao GPT. Em produção, poderia ser algo mais manual.

    // Combine a msg do usuário com a pendência
    const combinedMsg = `${userSession.pendingOperation}\n\n Usuário diz agora: "${userMsg}"`;

    const { fullAnswer, jsonPart } = await processUserMessage(userNumber, combinedMsg);

    // Tenta novamente processar
    let dbMsg = '';
    if (jsonPart) {
      dbMsg = await executeDbOperation(jsonPart, userNumber);
    }

    // Se ainda não resolveu, dbMsg poderia ser "faltam dados..." => Então continua pendente
    // Caso contrário, limpamos a pendência
    if (!dbMsg.includes('faltam dados') && !dbMsg.includes('aguardando')) {
      // Consideramos resolvido
      userSession.pendingOperation = null;
    }

    conversationState[userNumber] = userSession;

    return `${fullAnswer}\n\n[DB INFO]: ${dbMsg}`;
  }

  // 2) Se não há pendência, chamamos GPT diretamente
  const { fullAnswer, jsonPart } = await processUserMessage(userNumber, userMsg);

  // Tenta rodar a operação
  let dbResult = '';
  if (jsonPart) {
    dbResult = await executeDbOperation(jsonPart, userNumber);
    // Se a resposta do BD indicar que faltam dados,
    // guardamos a pendência
    if (dbResult.includes('faltam dados') || dbResult.includes('por favor forneça')) {
      // Deixamos a conversationState com a pendingOperation
      userSession.pendingOperation = userMsg;
      conversationState[userNumber] = userSession;
    }
  } else {
    dbResult = 'Nenhuma operação de BD detectada.';
  }

  return `${fullAnswer}\n\n[DB INFO]: ${dbResult}`;
}

// ------------------------------------------------------
// EXECUTA OPERAÇÕES NO BD
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
      return await handleSelect(table, where, data);

    default:
      return `Operação '${operation}' não reconhecida ou não implementada.`;
  }
}

// ------------------------------------------------------
// Handlers
// ------------------------------------------------------
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

// Insere paciente
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
    // Exemplo de pergunta
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

// Insere transação (ENTRADA ou SAÍDA)
async function insertTransaction(fields) {
  const {
    brand,
    product_name,
    quantity,
    operation_type,   // ENTRADA ou SAÍDA
    patient_name,
    cost_in_real,
    cost_in_dollar,
    exchange_rate,

    // Novos campos para SAÍDA
    sale_type,        // "Sedex", "Portaria", "Envio Direto"
    paid,             // true/false
    payment_method,   // "pix", etc.
    date_of_sale,     // se não vier, usar now()
    sale_code         // para agrupar itens
  } = fields;

  if (!brand || !product_name || !quantity || !operation_type) {
    return 'Campos insuficientes para inserir transação (brand/product_name/quantity/operation_type).';
  }

  // Se for ENTRADA, precisamos de patient_name (ANVISA)
  // Se for SAÍDA, precisamos (ou não) do patient_name? Depende do seu modelo de negócio.
  // Vamos supor que sempre precisa de "patient_name".
  if (!patient_name) {
    return 'Falta o nome do paciente (patient_name). Por favor forneça ou confirme que deseja inserir sem esse dado.';
  }

  // Buscamos no BD
  const patRes = await pool.query(`SELECT id FROM patients WHERE full_name ILIKE $1`, [patient_name]);
  if (patRes.rows.length === 0) {
    return `Paciente '${patient_name}' não encontrado. Cadastre-o primeiro ou corrija o nome.`;
  }
  const patientId = patRes.rows[0].id;

  // Garante inventory
  const inv = await pool.query(`SELECT id, quantity FROM inventory WHERE brand=$1 AND product_name=$2`,
    [brand, product_name]);
  let productId;
  let newQty;
  if (inv.rows.length > 0) {
    productId = inv.rows[0].id;
    const current = inv.rows[0].quantity || 0;
    if (operation_type === 'ENTRADA') {
      newQty = current + quantity;
    } else {
      // SAÍDA
      newQty = current - quantity;
      if (newQty < 0) newQty = 0; // ou pode falhar se não há estoque suficiente
    }
    await pool.query(`UPDATE inventory SET quantity=$1 WHERE id=$2`, [newQty, productId]);
  } else {
    // Se não existe, criamos
    const insInv = await pool.query(`
      INSERT INTO inventory (brand, product_name, quantity)
      VALUES ($1,$2,$3) RETURNING id
    `, [
      brand,
      product_name,
      (operation_type === 'ENTRADA' ? quantity : 0)
    ]);
    productId = insInv.rows[0].id;
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

  // Data da venda
  let finalDateSale = date_of_sale ? new Date(date_of_sale) : null;
  if (!finalDateSale || isNaN(finalDateSale.getTime())) {
    // se for SAÍDA e não veio data, assume now
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
    (paid===true || paid==="true") ? true : false,
    payment_method || null,
    finalDateSale,
    sale_code || null
  ]);

  const tid = transRes.rows[0].id;
  return `Transação ID=${tid} inserida. Estoque de ${brand} / ${product_name} agora é ${newQty}.`;
}

// UPDATE genérico
async function handleUpdate(table, fields, where) {
  if (!Object.keys(where).length) {
    return 'WHERE não informado para UPDATE.';
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

// DELETE genérico
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

// SELECT genérico (poderíamos melhorar para SOMA, GROUP BY, etc.)
async function handleSelect(table, where, data) {
  // Exemplo: se o GPT mandar algo como
  // "operation":"SELECT", "table":"transactions", "fields":{"aggregate":"SUM(cost_in_real)"},"where":{...}
  // poderíamos montar um select custom. Mas aqui é simples.
  let sql = `SELECT * FROM ${table}`;
  const vals = [];
  if (Object.keys(where).length) {
    const clauses = [];
    Object.entries(where).forEach(([k,v], i) => {
      clauses.push(`${k}=$${i+1}`);
      vals.push(v);
    });
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  const rows = (await pool.query(sql, vals)).rows;
  if (!rows.length) return 'Nenhum resultado encontrado.';
  return JSON.stringify(rows, null, 2);
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
  await initDB();
});

client.on('message', async (msg) => {
  try {
    // Filtrar para só aceitar mensagens de certos números
    const allowedNumbers = ['51998682720@c.us','51999551005@c.us'];
    if (!allowedNumbers.includes(msg.from)) {
      return; // ignora
    }

    const userNumber = msg.from;
    const userText = msg.body;
    console.log(`Mensagem de ${userNumber}: ${userText}`);

    // Processa
    const responseText = await handleUserMessage(userNumber, userText);

    await msg.reply(responseText);

  } catch (err) {
    console.error('Erro ao processar mensagem:', err);
    await msg.reply('Desculpe, ocorreu um erro ao processar sua solicitação.');
  }
});

client.initialize();
