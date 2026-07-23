# Faceit Insights (MVP)

App que busca perfil Faceit CS2 (nick ou URL) e gera insights + treino únicos via LLM (Gemini ou Groq).

## Chaves obrigatórias

### Faceit

1. Crie app em [developers.faceit.com](https://developers.faceit.com)
2. Gere uma **Server side API Key**
3. Defina `FACEIT_API_KEY`

### LLM (Groq principal + Gemini fallback)

Default: `LLM_PROVIDER=groq` com fallback automático para Gemini se o Groq falhar (`LLM_FALLBACK=true`).

**Groq** (principal)

1. Crie chave em [console.groq.com/keys](https://console.groq.com/keys)
2. Defina `GROQ_API_KEY`
3. Opcional: `GROQ_MODEL` (default `llama-3.1-8b-instant` — ~14.4k RPD no free)

**Gemini** (fallback)

1. Crie chave em [Google AI Studio](https://aistudio.google.com/apikey)
2. Defina `GEMINI_API_KEY`
3. Opcional: `GEMINI_MODEL` (default `gemini-3.5-flash-lite` — ~500 RPD no free)

Sem nenhuma das chaves, a análise falha — não há insights fixos de fallback.

### Economia de cota

- Principal: Groq `llama-3.1-8b-instant` (~14.4k/dia). Fallback: Gemini Flash Lite (~500/dia).
- Cache exato por **provider + nick + fingerprint das stats** (default **24h**, em `.cache/`)
- Ajuste: `INSIGHT_CACHE_TTL_MS` (ex.: `21600000` = 6h)
- Plano de treino cobre mira, posicionamento, munição, arma por situação e spray vs tap/burst.

## Local

```bash
cd faceit-insights
# .env com FACEIT_API_KEY + (GEMINI_API_KEY ou GROQ_API_KEY)
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
