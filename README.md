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
3. Opcional: `GEMINI_MODEL` (default `gemini-3.5-flash-lite` — ~500 RPD no free; evite Flash “cheio” com ~20 RPD)

Sem `GEMINI_API_KEY`, a análise falha — não há insights fixos de fallback.

### Economia de cota

- Modelo default: `gemini-3.5-flash-lite` (~500 pedidos/dia no free). Evite `gemini-flash-latest` / 3.6 Flash (~20/dia).
- Cache exato por **nick + fingerprint das stats** (default **6h**)
- **Banco de padrões**: se um perfil novo for muito parecido (similaridade ≥ `PATTERN_MATCH_THRESHOLD`, default **0.90**), reutiliza o diagnóstico adaptando os números — **sem gastar RPD**
- Ajuste: `INSIGHT_CACHE_TTL_MS`, `PATTERN_MATCH_THRESHOLD` (ex.: `0.92` = mais rigoroso)

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
