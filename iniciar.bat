@echo off
title WhatsApp Bot - MiBotWhatsApp
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js no esta instalado o no esta en el PATH.
    echo Instala Node.js desde https://nodejs.org y vuelve a ejecutar.
    pause
    exit /b 1
)

echo Iniciando el bot...
echo Deja esta ventana abierta mientras quieras que el bot funcione.
echo.
echo Si WEBHOOK_URL esta configurado, el bot creara solo su tunel publico
echo y registrara la URL en la web. Ya no necesitas ejecutar tunel.bat.
echo Para detenerlo, pulsa Ctrl+C.
echo.

node index.js

echo.
echo El bot se detuvo.
pause