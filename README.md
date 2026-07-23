# Faceit Insights (MVP)

App que busca perfil Faceit CS2 (nick ou URL) e gera insights + treino únicos via Gemini.

## Chaves obrigatórias

### Faceit

1. Crie app em [developers.faceit.com](https://developers.faceit.com)
2. Gere uma **Server side API Key**
3. Defina `FACEIT_API_KEY`

### Gemini

1. Crie chave em [Google AI Studio](https://aistudio.google.com/apikey)
2. Defina `GEMINI_API_KEY`
3. Opcional: `GEMINI_MODEL` (default `gemini-2.0-flash`)

Sem `GEMINI_API_KEY`, a análise falha — não há insights fixos de fallback.

## Local

```bash
cd faceit-insights
set FACEIT_API_KEY=sua_chave_faceit
set GEMINI_API_KEY=sua_chave_gemini
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
3. Em **Environment** adicione:
   - `FACEIT_API_KEY` = chave Faceit
   - `GEMINI_API_KEY` = chave Gemini
4. Deploy → URL tipo `https://faceit-insights.onrender.com`

### Alternativas free

| Serviço | Observação |
|--|--|
| **Render** | Free, dorme ~15 min sem uso (cold start ~30–60s) |
| **Railway** | Crédito free mensal; fácil |
| **Fly.io** | Free tier limitado; precisa CLI |

## Exemplo de uso

`https://SEU-APP.onrender.com/?q=luk-`
