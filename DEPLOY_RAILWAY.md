# Orkio v6 - Railway Deployment Guide

Este guia detalha o processo completo para deploy do Orkio v6 no Railway.

## Pré-requisitos

- Conta no [Railway](https://railway.app)
- Conta no [OpenAI](https://platform.openai.com) com API key
- Banco de dados PostgreSQL (pode ser provisionado no Railway)

---

## Arquitetura

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│    Frontend     │────▶│    Backend      │────▶│   PostgreSQL    │
│    (Nginx)      │     │    (Node.js)    │     │   (pgvector)    │
│                 │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
       :80                    :3000                  :5432
```

---

## Passo 1: Provisionar Banco de Dados

### Opção A: PostgreSQL no Railway

1. No Railway Dashboard, clique em **"New Project"**
2. Selecione **"Provision PostgreSQL"**
3. Aguarde o provisionamento
4. Copie a **DATABASE_URL** das variáveis de ambiente

### Opção B: PostgreSQL Externo (Neon, Supabase, etc.)

Use qualquer PostgreSQL compatível. Certifique-se de que:
- SSL está habilitado
- A connection string está no formato: `postgresql://user:pass@host:port/db?sslmode=require`

### Habilitar pgvector (Opcional, mas Recomendado)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

> **Nota:** Se pgvector não estiver disponível, o sistema usará fallback com busca por similaridade de texto.

---

## Passo 2: Deploy do Backend

### 2.1 Criar Serviço no Railway

1. No projeto Railway, clique em **"New Service"**
2. Selecione **"Deploy from GitHub"** ou **"Deploy from Local"**
3. Se usando GitHub, conecte seu repositório
4. Se usando Local, faça upload do ZIP ou use Railway CLI:

```bash
cd orkio-backend-railway-final
railway login
railway link
railway up
```

### 2.2 Configurar Variáveis de Ambiente

No painel do serviço, vá em **"Variables"** e adicione:

| Variável | Valor | Obrigatório |
|----------|-------|-------------|
| `DATABASE_URL` | `postgresql://...` | ✅ |
| `JWT_SECRET` | String aleatória 32+ chars | ✅ |
| `OPENAI_API_KEY` | `sk-...` | ✅ |
| `NODE_ENV` | `production` | ✅ |
| `PORT` | `3000` | ✅ |
| `CORS_ORIGIN` | URL do frontend | ✅ |
| `JWT_EXPIRES_IN` | `24h` | ❌ |
| `LOGIN_RATE_LIMIT_MAX` | `5` | ❌ |
| `CHAT_RATE_LIMIT_MAX` | `20` | ❌ |

### 2.3 Verificar Deploy

Após o deploy, acesse:
- `https://seu-backend.railway.app/api/health`

Resposta esperada:
```json
{
  "status": "healthy",
  "database": "connected",
  "pgVector": "available",
  "timestamp": "2026-01-05T..."
}
```

---

## Passo 3: Deploy do Frontend

### 3.1 Build Local (Recomendado)

```bash
cd orkio-frontend-railway-final

# Configurar URL do backend
echo "VITE_ORKIO_API_BASE=https://seu-backend.railway.app" > .env

# Build
npm install
npm run build
```

### 3.2 Deploy no Railway

1. Crie novo serviço no Railway
2. Configure variável de build:

| Variável | Valor |
|----------|-------|
| `VITE_ORKIO_API_BASE` | `https://seu-backend.railway.app` |

3. Deploy usando Dockerfile ou Nixpacks

### 3.3 Alternativa: Vercel/Netlify

O frontend é um build estático e pode ser hospedado em qualquer serviço:

**Vercel:**
```bash
npm i -g vercel
vercel --prod
```

**Netlify:**
```bash
npm i -g netlify-cli
netlify deploy --prod --dir=dist
```

---

## Passo 4: Configuração Inicial

### 4.1 Bootstrap do Admin

Na primeira execução, o sistema cria automaticamente:
- Tenant padrão: `default`
- Admin master: `admin@orkio.local` / `OrkioAdmin2026!`

> ⚠️ **IMPORTANTE:** Altere a senha do admin imediatamente após o primeiro login!

### 4.2 Primeiro Acesso

1. Acesse `https://seu-frontend.railway.app`
2. Faça login com as credenciais padrão
3. Vá em **Settings** e altere a senha
4. Configure um **LLM Provider** com sua API key OpenAI

---

## Passo 5: Configurar LLM Provider

1. Acesse **Admin Console > LLM Providers**
2. Clique em **"Add Provider"**
3. Configure:
   - Name: `OpenAI`
   - API Key: Sua chave OpenAI
   - Models: `gpt-4o, gpt-4o-mini, gpt-3.5-turbo`
   - Marque como **Default** e **Active**
4. Clique em **"Test"** para verificar

---

## Passo 6: Criar Primeiro Agente

1. Vá em **Admin Console > Agents**
2. Clique em **"Create Agent"**
3. Configure:
   - Name: `Assistente Orkio`
   - Model: `gpt-4o`
   - Mode: `HYBRID`
   - Enable RAG: ✅
4. Salve o agente

---

## Passo 7: Upload de Documentos

1. Vá em **Admin Console > Collections**
2. Crie uma collection (ex: `Base de Conhecimento`)
3. Marque como **Global** se desejar acesso por todos os agentes
4. Vá em **Documents** e faça upload de arquivos:
   - PDF, DOCX, TXT, MD suportados
   - Máximo 16MB por arquivo

---

## Troubleshooting

### Erro: "Database connection failed"
- Verifique se `DATABASE_URL` está correta
- Confirme que SSL está habilitado (`?sslmode=require`)
- Verifique se o IP do Railway está na whitelist do banco

### Erro: "OpenAI API error"
- Verifique se a API key está correta
- Confirme que há créditos na conta OpenAI
- Verifique rate limits da API

### Erro: "CORS blocked"
- Configure `CORS_ORIGIN` com a URL exata do frontend
- Não use trailing slash na URL

### RAG não retorna evidências
- Verifique se o agente tem `enableRag: true`
- Confirme que há documentos processados na collection
- Verifique se pgvector está instalado (opcional)

---

## Monitoramento

### Logs
```bash
railway logs
```

### Health Check
```bash
curl https://seu-backend.railway.app/api/health
```

### Métricas
O Railway fornece métricas de CPU, memória e rede no dashboard.

---

## Backup

### Banco de Dados
```bash
pg_dump $DATABASE_URL > backup.sql
```

### Documentos
Os documentos são armazenados no banco. O backup do PostgreSQL inclui todos os dados.

---

## Atualização

1. Faça as alterações no código
2. Commit e push para o repositório
3. O Railway fará deploy automático (se configurado)

Ou manualmente:
```bash
railway up
```

---

## Suporte

Para problemas ou dúvidas:
1. Verifique os logs do Railway
2. Consulte a documentação do Railway
3. Abra uma issue no repositório do projeto

---

## Checklist de Deploy

- [ ] PostgreSQL provisionado
- [ ] pgvector habilitado (opcional)
- [ ] Backend deployed
- [ ] Variáveis de ambiente configuradas
- [ ] Health check funcionando
- [ ] Frontend deployed
- [ ] CORS configurado
- [ ] Admin password alterado
- [ ] LLM Provider configurado
- [ ] Primeiro agente criado
- [ ] Documentos uploaded
- [ ] RAG testado e funcionando
