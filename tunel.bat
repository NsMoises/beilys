@echo off
title Tunel WhatsApp Bot - Cloudflare
cd /d "%~dp0"

echo Iniciando tunel hacia http://localhost:3000 ...
echo.
echo Cuando te muestre la URL https://XXXXX.trycloudflare.com:
echo   - Copiala COMPLETA pero SIN /send-message al final
echo   - En la web (WhatsApp ^> Conexion ^> Conectar bot) pegala tal cual
echo     en el campo "URL de tu bot (tunel)". La web agrega las rutas sola.
echo.
echo Esta URL cambia CADA VEZ que ejecutes este archivo; tendras que
echo actualizarla en la web tras cada reinicio.
echo.

cloudflared.exe tunnel --url http://localhost:3000

pause
