# Faceit Insights (MVP)

App que busca perfil Faceit CS2 (nick ou URL) e gera insights + treino.

## Local

```bash
cd faceit-insights
npm start
```

Abra http://localhost:3847

## Deploy gratuito (Render)

1. Crie um repo no GitHub com esta pasta
2. Em [render.com](https://render.com) → **New** → **Web Service** → conecte o repo
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `echo ok` (não precisa build)
   - **Start Command:** `node server.js`
   - **Plan:** Free
4. Deploy → URL tipo `https://faceit-insights.onrender.com`

Ou use o `render.yaml` (Blueprint) se preferir.

### Alternativas free

| Serviço | Observação |
|--|--|
| **Render** | Free, dorme ~15 min sem uso (cold start ~30–60s) |
| **Railway** | Crédito free mensal; fácil |
| **Fly.io** | Free tier limitado; precisa CLI |
| **Vercel** | Só se virar serverless; este app precisa de Node contínuo |

## Limite importante

A Faceit pode bloquear IPs de datacenter (Cloudflare). Se no ar der erro 502/403:
- tente de novo (às vezes passa)
- depois migre para API oficial Faceit (chave em https://developers.faceit.com)

## Exemplo de uso

`https://SEU-APP.onrender.com/?q=luk-`
