@echo off
rem F1 Challenge CMT 2025 Web - prueba local en Chrome.
rem Sirve la web, el juego (solo lectura) y las instantaneas; luego abre Chrome.
set "JUEGO=D:\descargas2\CMT 2025 F1C (8th gear)\F1 Challenge 2025 CMT"
cd /d "%~dp0"
start "" "http://localhost:8150/?snap=menu-principal"
node tools\dev-server.mjs "%JUEGO%" 8150 snap
pause
