@echo off
REM start-real.bat - sobe o bridge ZeroReal (extensao dos sites -> Real MCP).
REM Requer Python 3.10+ com:  pip install websockets requests
title ZeroReal Bridge (Sites -> Real MCP)
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo [erro] Python nao encontrado no PATH. Instale https://www.python.org/downloads/
  pause
  exit /b 1
)
python -c "import websockets, requests" >nul 2>nul
if errorlevel 1 (
  echo Instalando dependencias (websockets requests)...
  python -m pip install --quiet websockets requests
)
echo.
echo ZeroReal Bridge rodando: WS ws://127.0.0.1:17614  -^> Real MCP http://127.0.0.1:3872/mcp
echo Deixe esta janela aberta. Na extensao, clique Start session.
echo.
python real-bridge.py
pause
