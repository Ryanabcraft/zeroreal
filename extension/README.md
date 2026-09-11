# ⚡ ZeroReal — extensão do navegador

> Instalação e uso completos no [README principal](../README.md).

Transforma um chat de IA (ChatGPT, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena, Meta AI, Ox Alpha) num agente do **executor Real**: a extensão vigia as respostas da IA, executa os comandos detectados no jogo via `../bridge/real-bridge.py` e injeta o resultado como a próxima mensagem.

## Carregar (Edge ou Chrome)

1. `edge://extensions` ou `chrome://extensions`
2. **Modo do desenvolvedor** ligado
3. **Carregar sem compactação** → selecione esta pasta `extension/`

## Arquitetura (para contribuir)

Núcleo agnóstico a provider + providers por site:

```
core/config.js        system prompt, feedback, categorias de tools (global ZR)
core/parser.js        parsing de comandos - string pura              (global ZSParse)
core/main.js          loop agêntico, UI, camouflagem, sessão         (usa ZSProvider)
providers/deepseek.js tudo específico do DeepSeek: seletores DOM, detecção de
                      geração, mecânica de envio, modos Pensamento/Pesquisa…
providers/gemini.js   mesma interface p/ o Gemini …
…                     (um arquivo por site, mesma interface ZSProvider)
background.js         WebSocket com o bridge local (ws://127.0.0.1:17614)
```

> \* Os identificadores internos (`ZSParse`, `ZSProvider`, classes CSS `zs-*`)
> foram mantidos para não quebrar nada — só o nome visível e o alvo (Real)
> mudaram.

`core/main.js` nunca toca o DOM do site — só via `ZSProvider`. Para integrar outro site de IA: escreva `providers/<site>.js` com a mesma interface e registre a URL em `manifest.json` (`content_scripts` + `host_permissions`) e em `PROVIDER_URLS` no `background.js`.

## Testes (Node puro, sem dependências — rode nesta pasta)

- `node test-parser.js` — parser de comandos (`core/parser.js`)
- `node test-chatgpt.js` — leitura de respostas (`providers/chatgpt.js`) contra um DOM falso

Ambos imprimem `PASS`/`FAIL` por caso e saem com erro se algo falhar.
