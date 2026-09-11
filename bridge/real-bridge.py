# real-bridge.py - WebSocket shim: ZeroReal extension <-> Real MCP (HTTP).
# Mantem o mesmo protocolo WS do bridge ZeroScript/Studio (background.js espera
# exatamente essas mensagens), mas traduz para o Real MCP via HTTP JSON-RPC.
#
# WS  (extensao, porta 17614 para coexistir com Studio 17613):
#   <- {"type":"ping","id":N}                       -> {"type":"pong","id":N}
#   <- {"type":"studio_status"|"client_status","id":N} -> {"type":"studio_status","id":N}
#        + campos top-level studio/studio_app/studio_proc (compat: studio=true = cliente Real vivo)
#   <- {"type":"list_tools","id":N}                 -> {"type":"tools","id":N,"tools":[...],"servers":[...],"mcp_alive":bool}
#   <- {"type":"call_tool","name":str,"arguments":dict,"timeout":s,"id":N}
#                                                   -> {"type":"tool_result","id":N,"ok":bool,"text":str,"images":[]}
#   + {"type":"connected","mcp_alive":bool,"tools":[...],"servers":[...]} no handshake
#
# Real (HTTP JSON-RPC MCP):
#   POST {real_url}  Authorization: Bearer {token}
#   {"jsonrpc":"2.0","id":N,"method":"tools/list","params":{}}
#   {"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":...,"arguments":{...}}}
#
# Sem dependencias alem de websockets + requests (ambas ja comuns no Windows).
# Roda com:  python real-bridge.py   (ou start-real.bat)
import asyncio
import json
import os
import sys
import time
import traceback

try:
    import websockets
except ImportError:
    print("Falta 'websockets': pip install websockets requests", flush=True)
    sys.exit(1)

try:
    import requests
except ImportError:
    print("Falta 'requests': pip install websockets requests", flush=True)
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")

DEFAULT_CONFIG = {
    "ws_port": 17614,
    "real_urls": ["http://127.0.0.1:3872/mcp"],
    "token": "",
    "request_timeout": 110,
    "tools_ttl": 15,
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            user = json.load(f)
        for k, v in user.items():
            cfg[k] = v
    except FileNotFoundError:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        print(f"[bridge] config criada em {CONFIG_PATH} - edite o token se preciso.", flush=True)
    except Exception as e:
        print(f"[bridge] config invalida ({e}), usando padrao.", flush=True)
    # token via env tem prioridade (evita deixar fixo no arquivo se preferir)
    if os.environ.get("REAL_MCP_TOKEN"):
        cfg["token"] = os.environ["REAL_MCP_TOKEN"]
    return cfg


CONFIG = load_config()

# O token do print/screenshot pode estar errado ou girar. Fonte da verdade:
# os arquivos de sessao que o proprio Real mantem em disco.
#   %LOCALAPPDATA%\Real\data\sessions\mcp\endpoint.json -> {"port":3872,"token":"..."}
#   %LOCALAPPDATA%\Real\data\sessions\mcp\token       -> token puro
# Lidos no boot e sempre que o Real responder 401 (token girado).
def real_session_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local")
    return os.path.join(base, "Real", "data", "sessions", "mcp")


def load_real_session():
    changed = False
    try:
        ep = os.path.join(real_session_dir(), "endpoint.json")
        with open(ep, "r", encoding="utf-8") as f:
            data = json.load(f)
        port = int(data.get("port") or 0)
        tok = (data.get("token") or "").strip()
        if port:
            url = f"http://127.0.0.1:{port}/mcp"
            urls = CONFIG.get("real_urls") or []
            if url not in urls:
                urls.insert(0, url)
                CONFIG["real_urls"] = urls
            changed = True
        if tok and tok != CONFIG.get("token"):
            CONFIG["token"] = tok
            changed = True
            log("token sincronizado com a sessao do Real")
    except FileNotFoundError:
        pass
    except Exception as e:
        log("sessao Real ilegivel:", e)
    if not (CONFIG.get("token") or "").strip():
        try:
            with open(os.path.join(real_session_dir(), "token"), "r", encoding="utf-8") as f:
                tok = f.read().strip()
            if tok:
                CONFIG["token"] = tok
                changed = True
                log("token lido do arquivo de sessao do Real")
        except Exception:
            pass
    return changed


load_real_session()

# Nomes antigos do Studio que modelos antigos podem escrever -> equivalentes Real.
# O parser novo ja mira os nomes Real; isso aqui e rede de seguranca.
ALIASES = {
    "execute_luau": ("get-data-by-code", lambda a: {"code": a.get("code", "")}),
    "script_read": ("get-script-content", lambda a: {"scriptPath": a.get("target_file") or a.get("file_path") or a.get("path", "")}),
    "script_grep": ("script-grep", lambda a: {"query": a.get("query") or a.get("pattern", "")}),
    "search_game_tree": ("search-instances", lambda a: {"selector": a.get("selector") or a.get("query", "")}),
    "inspect_instance": ("get-instance-properties", lambda a: {"path": a.get("path", "")}),
    "get_studio_state": ("get-game-info", lambda a: {}),
    "screen_capture": ("screenshot-window", lambda a: {}),
    "user_keyboard_input": None,  # sem equivalente direto; tratado abaixo
    "user_mouse_input": None,
    "multi_edit": None,
}

_state = {
    "tools": [],          # lista MCP com {"name","description","inputSchema","server":"real"}
    "servers": [{"id": "real", "alive": False, "tools": 0}],
    "mcp_alive": False,
    "tools_at": 0,
    "rpc_id": 1,
    "active_url": None,
}


def log(*a):
    print("[real-bridge]", *a, flush=True)


def real_headers():
    h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if CONFIG.get("token"):
        h["Authorization"] = f"Bearer {CONFIG['token']}"
    return h


_http = None  # requests.Session persistente
_mcp_sid = None  # Mcp-Session-Id apos initialize


def http_session():
    global _http
    if _http is None:
        _http = requests.Session()
    return _http


def parse_rpc_response(r, rid):
    # Resposta pode ser JSON direto ou SSE (text/event-stream). Extrai o objeto
    # com nosso id; notification (sem id) retorna {}.
    text = r.text or ""
    ctype = (r.headers.get("Content-Type") or "").lower()
    if "text/event-stream" in ctype or "data:" in text[:200]:
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                blob = line[5:].strip()
                if not blob or blob == "[DONE]":
                    continue
                try:
                    obj = json.loads(blob)
                except Exception:
                    continue
                if obj.get("id") == rid or "id" not in obj:
                    return obj
        raise RuntimeError(f"resposta SSE sem data JSON (HTTP {r.status_code}): {text[:300]}")
    if not text.strip():
        return {}
    try:
        return r.json()
    except Exception:
        raise RuntimeError(f"resposta nao-JSON (HTTP {r.status_code}): {text[:300]}")


def mcp_initialize(timeout=10, _retried=False):
    # Handshake MCP Streamable HTTP: initialize -> notifications/initialized.
    # O Real (rmcp) exige isso antes de tools/list (senao 422 "expect initialize").
    global _mcp_sid
    global _http
    _http = requests.Session()  # sessao limpa
    _mcp_sid = None
    rid = _state["rpc_id"]
    _state["rpc_id"] += 1
    r = _http.post(_state.get("init_url") or CONFIG["real_urls"][0],
                   headers=real_headers(),
                   json={"jsonrpc": "2.0", "id": rid, "method": "initialize",
                         "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                                    "clientInfo": {"name": "zeroreal-bridge", "version": "1.6.0"}}},
                   timeout=timeout)
    if r.status_code == 401 and not _retried:
        log("401 no initialize - ressincronizando token e retentando")
        load_real_session()
        return mcp_initialize(timeout=timeout, _retried=True)
    if r.status_code == 401:
        raise RuntimeError("401 no initialize (token invalido)")
    sid = r.headers.get("Mcp-Session-Id")
    resp = parse_rpc_response(r, rid)
    if "error" in resp and resp["error"]:
        raise RuntimeError(f"initialize falhou: {str(resp['error'])[:200]}")
    if sid:
        _mcp_sid = sid
    # notification de pronto (sem id; 202 vazio e esperado)
    try:
        _http.post(_state.get("init_url") or CONFIG["real_urls"][0],
                   headers=real_headers(),
                   json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                   timeout=timeout)
    except Exception:
        pass
    return True


def rpc_call(url, method, params, timeout, _retried=False):
    # Chamada JSON-RPC com sessao MCP (initialize) e Mcp-Session-Id.
    # _state["init_url"] = URL onde a sessao foi aberta; se a URL mudar,
    # reabre a sessao la. 401 -> ressincroniza token e tenta 1x.
    global _mcp_sid
    if _state.get("init_url") != url or _mcp_sid is None:
        _state["init_url"] = url
        mcp_initialize(timeout=min(timeout, 10))
    rid = _state["rpc_id"]
    _state["rpc_id"] += 1
    headers = real_headers()
    if _mcp_sid:
        headers["Mcp-Session-Id"] = _mcp_sid
    r = http_session().post(url, headers=headers,
                            json={"jsonrpc": "2.0", "id": rid, "method": method,
                                  "params": params or {}},
                            timeout=timeout)
    if r.status_code == 401 and not _retried:
        log("401 do Real - ressincronizando token da sessao e retentando")
        load_real_session()
        _state["init_url"] = None
        _mcp_sid = None
        return rpc_call(url, method, params, timeout, _retried=True)
    if r.status_code in (400, 404) and not _retried:
        # sessao expirada/invalida ("Unknown session", 422 de protocolo): reabre 1x
        log(f"HTTP {r.status_code} no {method} - reabrindo sessao MCP e retentando")
        _state["init_url"] = None
        _mcp_sid = None
        return rpc_call(url, method, params, timeout, _retried=True)
    return parse_rpc_response(r, rid)


def call_urls():
    urls = []
    if _state["active_url"]:
        urls.append(_state["active_url"])
    for u in CONFIG.get("real_urls", []):
        if u not in urls:
            urls.append(u)
    return urls


def mcp_list_tools(timeout=5, scan_timeout=1.5):
    last_err = "sem URL"
    configured = list(CONFIG.get("real_urls", []))
    saw_timeout = False
    # 1) URLs configuradas com timeout curto.
    for url in configured:
        try:
            resp = rpc_call(url, "tools/list", {}, timeout)
            if "error" in resp and resp["error"]:
                last_err = str(resp["error"])[:200]
                continue
            result = resp.get("result") or {}
            tools = result.get("tools") or []
            norm = []
            for t in tools:
                norm.append({
                    "name": t.get("name", "?"),
                    "description": t.get("description", ""),
                    "inputSchema": t.get("inputSchema") or t.get("input_schema") or {"type": "object"},
                    "server": "real",
                })
            _state["active_url"] = url
            return norm, None
        except requests.exceptions.Timeout:
            saw_timeout = True
            last_err = f"{url}: timeout apos {timeout}s (algo escuta mas nao respondeu tools/list)"
            continue
        except Exception as e:
            last_err = f"{url}: {e}"[:250]
            continue
    if saw_timeout:
        # Algo ESCUTA na URL configurada (nao e refused) - nao varre portas,
        # so aguardaria. Retorna o erro de timeout para diagnostico.
        return None, last_err
    # 2) Fallback de porta (Real muda se 3872 ocupada): refused fecha na hora,
    #    entao isso so custa tempo se houver algo pendurado em outra porta.
    base = "http://127.0.0.1:{}/mcp"
    for p in range(3872, 3891):
        u = base.format(p)
        if u in configured:
            continue
        try:
            resp = rpc_call(u, "tools/list", {}, scan_timeout)
            if "error" in resp and resp["error"]:
                continue
            result = resp.get("result") or {}
            tools = result.get("tools") or []
            norm = [{
                "name": t.get("name", "?"),
                "description": t.get("description", ""),
                "inputSchema": t.get("inputSchema") or t.get("input_schema") or {"type": "object"},
                "server": "real",
            } for t in tools]
            _state["active_url"] = u
            log(f"Real achado em porta alternativa: {u}")
            return norm, None
        except Exception:
            continue
    return None, last_err


def extract_result_text(result):
    # MCP tools/call -> result.content: [{type:"text",text:...},{type:"image",data,mimeType}]
    if result is None:
        return "", []
    if isinstance(result, str):
        return result, []
    if isinstance(result, dict) and "content" not in result:
        # alguns servidores retornam o objeto direto
        try:
            return json.dumps(result, ensure_ascii=False)[:20000], []
        except Exception:
            return str(result)[:20000], []
    content = (result.get("content") or []) if isinstance(result, dict) else []
    texts, images = [], []
    for item in content:
        if not isinstance(item, dict):
            texts.append(str(item))
            continue
        t = item.get("type")
        if t == "text":
            texts.append(item.get("text", ""))
        elif t == "image":
            images.append({"data": item.get("data", ""), "mimeType": item.get("mimeType", "image/png")})
        elif t == "resource":
            texts.append(json.dumps(item.get("resource", item), ensure_ascii=False))
        else:
            texts.append(item.get("text") or json.dumps(item, ensure_ascii=False))
    text = "\n".join(texts).strip()
    if not text and not images:
        try:
            text = json.dumps(result, ensure_ascii=False)[:20000]
        except Exception:
            text = str(result)[:20000]
    return text[:20000], images


def mcp_call_tool(name, args, timeout):
    # aplica alias Studio->Real quando preciso
    if name in ALIASES:
        mapped = ALIASES[name]
        if mapped is None:
            if name == "multi_edit":
                return False, "ERROR: 'multi_edit' nao existe no Real. Use 'open-script' para criar o arquivo e 'live-reload' para rodar/atualizar sem empilhar copias.", []
            return False, (
                f"ERROR: '{name}' do Studio nao existe no Real. "
                "Para teclado/mouse use 'send-input' (janela do Roblox focada). "
                "Para codigo use get-data-by-code (retorno unico) ou live-reload (loop)."
            ), []
        name, fn = mapped
        try:
            args = fn(args or {})
        except Exception:
            pass
    last_err = "sem URL"
    for url in call_urls():
        try:
            resp = rpc_call(url, "tools/call", {"name": name, "arguments": args or {}}, timeout)
            if "error" in resp and resp["error"]:
                err = resp["error"]
                msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                # tool desconhecida: tenta uma vez sem prefixo/sufixo de servidor
                return False, f"ERROR calling '{name}': {msg}", []
            result = resp.get("result") or {}
            if isinstance(result, dict) and result.get("isError"):
                text, _imgs = extract_result_text(result)
                return False, f"ERROR calling '{name}': {text or 'tool reported an error'}", []
            text, images = extract_result_text(result)
            _state["active_url"] = url
            return True, text, images
        except Exception as e:
            last_err = f"{url}: {e}"[:300]
            continue
    return False, f"ERROR: Real MCP inalcançavel. {last_err}. Confira se o Real esta aberto com o servidor MCP ativo.", []


def refresh_tools(force=False):
    now = time.time()
    ttl = float(CONFIG.get("tools_ttl", 15) or 15)
    if not force and _state["tools"] and (now - _state["tools_at"]) < ttl:
        return _state["tools"]
    tools, err = mcp_list_tools(timeout=5)
    if tools is None:
        # Pode ser porta/token novos apos restart do Real: ressincroniza e tenta 1x.
        if load_real_session():
            tools, err = mcp_list_tools(timeout=5)
    if tools is not None:
        _state["tools"] = tools
        _state["tools_at"] = now
        _state["mcp_alive"] = True
        _state["servers"] = [{"id": "real", "alive": True, "tools": len(tools)}]
    else:
        _state["mcp_alive"] = False
        _state["servers"] = [{"id": "real", "alive": False, "tools": 0}]
        log("tools/list falhou:", err)
    return _state["tools"]


def check_client():
    # Equivalente do studio_status: ha cliente injetado e vivo?
    ok, text, _imgs = mcp_call_tool("list-clients", {}, timeout=15)
    if not ok:
        return None  # desconhecido (Real pode estar offline)
    try:
        low = (text or "").lower()
        # heuristica simples: lista vazia / nenhum responsivo = false
        if any(k in low for k in ["responsive:true", "responsive true", "\"alive\":true", "alive", "clientid", "process", "place", "game"]):
            # se menciona lista vazia explicitamente, considera false
            if any(k in low for k in ["no clients", "no injected", "empty", "[]", "0 client"]) and "clientid" not in low:
                return False
            return True
        if text.strip() in ("[]", "{}", "null", ""):
            return False
        return True  # respondeu com conteudo: assume algum cliente
    except Exception:
        return None


async def handle(ws):
    # handshake imediato com o cache atual (pode estar vazio no boot) - a
    # extensao nunca espera o Real para conectar. O catalogo chega via refresh
    # em background + mensagem "connected" atualizada.
    try:
        await ws.send(json.dumps({"type": "connected", "mcp_alive": _state["mcp_alive"],
                                  "tools": _state["tools"], "servers": _state["servers"]}))
    except Exception:
        pass
    log("extensao conectada; tools:", len(_state["tools"]), "alive:", _state["mcp_alive"])
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        mtype = msg.get("type")
        mid = msg.get("id")
        try:
            if mtype == "ping":
                await ws.send(json.dumps({"type": "pong", "id": mid}))
            elif mtype in ("studio_status", "client_status"):
                loop = asyncio.get_running_loop()
                v = await loop.run_in_executor(None, check_client)
                await ws.send(json.dumps({
                    "type": "studio_status", "id": mid,
                    "studio": v, "studio_app": v, "studio_proc": None,
                }))
            elif mtype == "list_tools":
                loop = asyncio.get_running_loop()
                tools = await loop.run_in_executor(None, lambda: refresh_tools(force=False))
                await ws.send(json.dumps({"type": "tools", "id": mid, "tools": tools,
                                          "servers": _state["servers"], "mcp_alive": _state["mcp_alive"]}))
            elif mtype == "call_tool":
                name = msg.get("name", "")
                args = msg.get("arguments") or {}
                timeout = int(msg.get("timeout") or 120)
                timeout = max(5, min(timeout + 10, 130))
                loop = asyncio.get_running_loop()
                ok, text, images = await loop.run_in_executor(
                    None, mcp_call_tool, name, args, timeout)
                # atualiza saude apos cada chamada
                _state["mcp_alive"] = True if ok else _state["mcp_alive"]
                await ws.send(json.dumps({"type": "tool_result", "id": mid, "ok": ok,
                                          "text": text if ok else None,
                                          "error": None if ok else text,
                                          "images": images or []}))
            elif mtype == "restart_mcp":
                _state["tools"] = []
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, lambda: refresh_tools(force=True))
                await ws.send(json.dumps({"type": "mcp_status", "id": mid, "ok": _state["mcp_alive"],
                                          "alive": _state["mcp_alive"], "tools": _state["tools"]}))
            elif mtype in ("add_server", "remove_server"):
                await ws.send(json.dumps({"type": "error", "id": mid,
                                          "error": "servidor 'real' e fixo neste bridge (gerenciado pelo app Real)."}))
            else:
                await ws.send(json.dumps({"type": "error", "id": mid, "error": f"tipo desconhecido: {mtype}"}))
        except Exception as e:
            log("erro tratando", mtype, ":", e)
            traceback.print_exc()
            try:
                await ws.send(json.dumps({"type": "error", "id": mid, "error": str(e)[:300]}))
            except Exception:
                pass


async def amain():
    port = int(CONFIG.get("ws_port", 17614))
    log(f"WS em ws://127.0.0.1:{port}  -> Real MCP {[u for u in CONFIG.get('real_urls', [])]}")
    async with websockets.serve(handle, "127.0.0.1", port, max_size=64 * 1024 * 1024):
        log("ouvindo. Descobrindo o Real em background...")
        loop = asyncio.get_running_loop()
        # descoberta inicial fora do caminho do handshake (nao bloqueia a extensao)
        tools = await loop.run_in_executor(None, lambda: refresh_tools(force=True))
        log(f"handshake Real: alive={_state['mcp_alive']} tools={len(tools)}"
            + (f" url={_state['active_url']}" if _state["active_url"] else " (Real offline - tentando mesmo assim)"))
        await asyncio.Future()  # roda para sempre


def main():
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        print("\n[real-bridge] encerrado.", flush=True)


if __name__ == "__main__":
    main()
