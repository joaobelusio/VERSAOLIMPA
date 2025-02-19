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
// Se seu Railway fornecer DATABASE_URL, poderia ser:
//   const pool = new Pool({
//     connectionString: process.env.DATABASE_URL,
//     ssl: { rejectUnauthorized: false },
//   });
// Mas aqui seguimos usando as variáveis separadas (PGHOST, etc.)
// ------------------------------------------------------
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }, // Importante em Railway
});

// ------------------------------------------------------
// Função para criar tabelas se não existirem
// ------------------------------------------------------
async function initDB() {
  // Cria tabela 'inventory' caso não exista
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      brand TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Cria tabela 'transactions' caso não exista
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES inventory(id),
      operation_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("Tabelas 'inventory' e 'transactions' prontas (se não existiam).");
}

// ------------------------------------------------------
// Prompt (mensagem de sistema) para o GPT
// ------------------------------------------------------
const systemPrompt = `
Você é um assistente que gerencia o estoque de produtos (óleos de CBD etc.) em um banco de dados PostgreSQL.
O usuário falará de forma livre/informal.

Regras:
1) Sempre dê ao usuário uma breve resposta explicando o que você entendeu e fará.
2) Em seguida, SEMPRE inclua um bloco de JSON (delimitado por 3 crases \`\`\`) descrevendo a operação a ser feita no BD.
3) Se a mensagem do usuário não exigir mexer no BD, defina "operation":"NONE" no JSON.
4) Se precisar inserir, use "operation":"INSERT", "table":"inventory" ou "transactions" (ou outra) e "fields": {...}.
5) Se precisar atualizar, use "operation":"UPDATE", "table":"inventory" etc. e "fields": {...}, "where": {...}.
6) Se precisar apagar algo, "operation":"DELETE", com "table":"inventory" etc., "where": {...}.
7) Se precisar consultar, "operation":"SELECT", "table":"inventory" etc., e indique "where": {...} se necessário.
8) O JSON deve ser **válido**. Se não precisar de where ou fields, use {}.
9) Você pode adicionar quaisquer chaves em "fields" ou "where" que forem relevantes (brand, product_name, quantity etc.).

Exemplo de resposta:
"Ok, vou adicionar 5 frascos da marca 1Drop."
\`\`\`
{
  "operation":"INSERT",
  "table":"inventory",
  "fields":{
    "brand":"1Drop",
    "product_name":"6000mg Full Spectrum",
    "quantity":5
  }
}
\`\`\`

Por favor, siga esse formato sempre.
`;

// ------------------------------------------------------
// Função que processa a mensagem do usuário via GPT
// ------------------------------------------------------
async function processUserMessage(userMessage) {
  // 1) Chama ChatGPT com a role 'system' e 'user'
  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo', // ou 'gpt-4' se você tiver acesso
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ]
  });

  const fullAnswer = response.choices[0]?.message?.content || '';

  // 2) Extrai o JSON que está entre ``` e ```
  const jsonRegex = /```([^`]+)```/s; // /s para dotall
  const match = fullAnswer.match(jsonRegex);

  let jsonPart = null;
  if (match) {
    jsonPart = match[1].trim(); // Conteúdo dentro de ```
  }

  return { fullAnswer, jsonPart };
}

// ------------------------------------------------------
// Executa a query no BD baseado no JSON do GPT
// ------------------------------------------------------
async function executeDbOperation(jsonStr) {
  try {
    if (!jsonStr) {
      return 'Nenhuma operação de BD detectada.';
    }

    const data = JSON.parse(jsonStr);
    const { operation, table, fields = {}, where = {} } = data;

    if (!operation || operation === 'NONE') {
      return 'O GPT decidiu que não há nada para fazer no BD.';
    }

    switch (operation) {
      case 'INSERT':
        if (table === 'inventory') {
          // Se brand+product_name já existe, soma quantidades
          const { brand, product_name, quantity } = fields;
          if (!brand || !product_name) {
            return 'Faltam campos obrigatórios para INSERT em inventory.';
          }
          const checkRes = await pool.query(
            'SELECT id, quantity FROM inventory WHERE brand=$1 AND product_name=$2',
            [brand, product_name]
          );
          if (checkRes.rows.length > 0) {
            // Atualiza
            const existingId = checkRes.rows[0].id;
            const newQty = checkRes.rows[0].quantity + (quantity || 0);
            await pool.query('UPDATE inventory SET quantity=$1 WHERE id=$2', [newQty, existingId]);
            // Adiciona no transactions
            await pool.query(
              'INSERT INTO transactions (product_id, operation_type, quantity) VALUES ($1,$2,$3)',
              [existingId, 'ENTRADA', quantity || 0]
            );
            return `Atualizado estoque de ${brand} / ${product_name} para ${newQty}.`;
          } else {
            // Insere novo
            const insertRes = await pool.query(
              'INSERT INTO inventory (brand, product_name, quantity) VALUES ($1,$2,$3) RETURNING id',
              [brand, product_name, quantity || 0]
            );
            const newId = insertRes.rows[0].id;
            await pool.query(
              'INSERT INTO transactions (product_id, operation_type, quantity) VALUES ($1,$2,$3)',
              [newId, 'ENTRADA', quantity || 0]
            );
            return `Inserido novo produto ${brand} / ${product_name} (qtd: ${quantity || 0}).`;
          }
        }
        return 'INSERT em outra tabela não implementado neste exemplo.';

      case 'UPDATE':
        if (table === 'inventory') {
          // Monta um UPDATE genérico
          const setParts = [];
          const values = [];
          let idx = 1;
          for (const [k, v] of Object.entries(fields)) {
            setParts.push(`${k}=$${idx++}`);
            values.push(v);
          }
          if (!Object.keys(where).length) {
            return 'WHERE não informado para UPDATE.';
          }
          const whereParts = [];
          for (const [k, v] of Object.entries(where)) {
            whereParts.push(`${k}=$${idx++}`);
            values.push(v);
          }
          const sql = `UPDATE inventory SET ${setParts.join(', ')} WHERE ${whereParts.join(' AND ')}`;
          await pool.query(sql, values);
          return 'Registro(s) atualizado(s) em inventory.';
        }
        return 'UPDATE em outra tabela não implementado neste exemplo.';

      case 'DELETE':
        if (table === 'inventory') {
          // Monta um DELETE genérico
          const whereKeys = Object.keys(where);
          if (!whereKeys.length) {
            return 'WHERE não informado para DELETE.';
          }
          const clauses = [];
          const vals = [];
          whereKeys.forEach((k, i) => {
            clauses.push(`${k}=$${i + 1}`);
            vals.push(where[k]);
          });
          const sqlDel = `DELETE FROM inventory WHERE ${clauses.join(' AND ')}`;
          await pool.query(sqlDel, vals);
          return `DELETE realizado em inventory (where: ${JSON.stringify(where)})`;
        }
        return 'DELETE em outra tabela não implementado neste exemplo.';

      case 'SELECT':
        if (table === 'inventory') {
          // SELECT simples
          const whereKeys = Object.keys(where);
          let rows;
          if (whereKeys.length) {
            const clauses = [];
            const vals = [];
            whereKeys.forEach((k, i) => {
              clauses.push(`${k}=$${i + 1}`);
              vals.push(where[k]);
            });
            const sqlSel = `SELECT * FROM inventory WHERE ${clauses.join(' AND ')}`;
            rows = (await pool.query(sqlSel, vals)).rows;
          } else {
            rows = (await pool.query('SELECT * FROM inventory')).rows;
          }
          if (rows.length === 0) {
            return 'Nenhum resultado encontrado.';
          }
          let resp = 'Resultados:\n';
          rows.forEach(r => {
            resp += `ID=${r.id} | ${r.brand} / ${r.product_name} => Qtd: ${r.quantity}\n`;
          });
          return resp;
        }
        return 'SELECT em outra tabela não implementado neste exemplo.';

      default:
        return `Operação '${operation}' não reconhecida ou não implementada.`;
    }
  } catch (err) {
    console.error('Erro ao executar operação no BD:', err);
    return 'Erro ao executar operação no BD.';
  }
}

// ------------------------------------------------------
// Configura o cliente do WhatsApp
// ------------------------------------------------------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    // Flags para rodar sem sandbox (Railway root)
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

// Exibe QR code no terminal
client.on('qr', (qr) => {
  console.log('QR Code gerado, aponte a câmera do WhatsApp para autenticar:');
  qrcode.generate(qr, { small: true });
});

// Quando o bot estiver pronto
client.on('ready', async () => {
  console.log('Bot conectado com sucesso!');
  // Inicializa DB e cria tabelas se não existirem
  await initDB();
});

// Evento disparado ao receber mensagem
client.on('message', async (message) => {
  try {
    const userMsg = message.body;
    console.log(`Mensagem de ${message.from}: ${userMsg}`);

    // 1) Chama o GPT com systemPrompt e userMsg
    const { fullAnswer, jsonPart } = await processUserMessage(userMsg);

    // 2) Tenta executar operação no BD (se houver)
    const dbResult = await executeDbOperation(jsonPart);

    // 3) Monta resposta final para o WhatsApp
    // GPT já fez uma frase explicando;
    // dbResult diz o que ocorreu no BD
    const finalReply = `${fullAnswer}\n\n[DB INFO]: ${dbResult}`;

    await message.reply(finalReply);

  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
    await message.reply('Desculpe, ocorreu um erro ao processar sua solicitação.');
  }
});

// Inicializa o cliente
client.initialize();
