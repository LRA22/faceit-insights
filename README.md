# Faceit Insights (MVP)

App que busca perfil Faceit CS2 (nick ou URL) e gera insights + treino.

## Chave Faceit (obrigatória)

1. Crie app em [developers.faceit.com](https://developers.faceit.com)
2. Gere uma **Server side API Key**
3. Defina a variável de ambiente `FACEIT_API_KEY`

## Local

```bash
cd faceit-insights
set FACEIT_API_KEY=sua_chave
npm start
```

Abra http://localhost:3847

## Deploy gratuito (Render)

1. Em [render.com](https://render.com) → **New** → **Web Service** → repo `faceit-insights`
2. Settings:
   - **Runtime:** Node
   - **Build Command:** `echo ok`
   - **Start Command:** `node server.js`
   - **Plan:** Free
3. Em **Environment** adicione `FACEIT_API_KEY` = sua chave
4. Deploy → URL tipo `https://faceit-insights.onrender.com`

### Alternativas free

| Serviço | Observação |
|--|--|
| **Render** | Free, dorme ~15 min sem uso (cold start ~30–60s) |
| **Railway** | Crédito free mensal; fácil |
| **Fly.io** | Free tier limitado; precisa CLI |

## Exemplo de uso

`https://SEU-APP.onrender.com/?q=luk-`
