# WhatsApp Bot con Baileys

Bot de WhatsApp basado en [Baileys](https://github.com/WhiskeySockets/Baileys) con integración web, túnel automático Cloudflare y despliegue en Render.

## Características

- ✅ Conexión a WhatsApp Web via Baileys (Multi-device)
- ✅ Túnel automático Cloudflare (URL pública dinámica)
- ✅ Auto-registro de URL en web externa
- ✅ Webhook bidireccional (recibe/envía mensajes)
- ✅ API REST para envío de mensajes (`/send-message`)
- ✅ Health check endpoint (`/`)
- ✅ Persistencia de sesión (archivos locales o MongoDB)
- ✅ Auto-reconexión y reintentos
- ✅ Docker + Docker Compose listo para producción
- ✅ CI/CD con GitHub Actions
- ✅ Despliegue en Render

## Arquitectura

```
┌─────────────────┐     HTTPS      ┌─────────────────┐
│   WhatsApp      │◄──────────────►│   Baileys Bot   │
│   (Teléfono)    │   WebSocket    │   (Baileys)     │
└─────────────────┘                └────────┬────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
                                        ┌─────────────┐
                                        │  Cloudflare │
                                        │   Tunnel    │
                                        └──────┬──────┘
                                               │
                    ┌──────────────────────────┼──────────────────┐
                    ▼                          ▼                  ▼
              ┌───────────────┐        ┌───────────────┐  ┌───────────────┐
              │   Web App     │        │   Webhook     │  │  API /send-   │
              │   (Render)    │◄──────►│   /webhook    │  │  message      │
              └───────────────┘        └───────────────┘  └───────────────┘
```

## Requisitos

- Node.js 18+
- Cuenta de WhatsApp (número personal, no virtual)
- Cloudflared (incluido en Docker)
- Opcional: MongoDB Atlas para persistencia de sesión

## Variables de Entorno

| Variable | Requerida | Descripción | Ejemplo |
|----------|-----------|-------------|---------|
| `PREFIX` | No | Prefijo comandos | `!` |
| `BOT_NAME` | No | Nombre del bot | `MiBotWhatsApp` |
| `PORT` | No | Puerto HTTP | `3000` |
| `LOG_LEVEL` | No | Nivel log | `info` |
| `API_TOKEN` | **Sí** | Token API envío | `abc123...` |
| `WEBHOOK_URL` | Sí* | URL webhook web | `https://app.com/webhook` |
| `WEBHOOK_TOKEN` | Sí* | Token webhook | `mismo-que-api` |
| `MONGODB_URI` | No | MongoDB Atlas URI | `mongodb+srv://...` |
| `MONGODB_DB` | No | Nombre BD | `whatsapp-bot` |

*Requerido si se usa integración web.

## Instalación Local

```bash
# Clonar repo
git clone https://github.com/NsMoises/baileys.git
cd baileys

# Instalar dependencias
npm install

# Configurar variables
cp .env.example .env
# Editar .env con tus valores

# Ejecutar
npm start
```

## Despliegue en Render (Recomendado)

### 1. Crear repositorio en GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TU_USUARIO/baileys.git
git push -u origin main
```

### 2. Crear servicio en Render
1. Ve a [Render Dashboard](https://dashboard.render.com)
2. New → Web Service
3. Conecta tu repositorio GitHub
4. Configuración:
   - **Build Command**: `npm ci`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (o Starter para mejor rendimiento)

### 3. Variables de entorno en Render
Ve a Environment → Add Environment Variable:

| Key | Value |
|-----|-------|
| `API_TOKEN` | `tu-token-seguro-aqui` |
| `WEBHOOK_URL` | `https://TU_APP.onrender.com/api/webhooks/whatsapp-bot` |
| `WEBHOOK_TOKEN` | `mismo-que-API_TOKEN` |
| `MONGODB_URI` | `mongodb+srv://usuario:pass@cluster.mongodb.net/` (opcional) |
| `MONGODB_DB` | `whatsapp-bot` |

### 4. Render Deploy Hook (para auto-deploy)
1. En Render → Settings → Deploy Hook → Copy URL
2. En GitHub → Settings → Secrets → Actions → `RENDER_DEPLOY_HOOK_URL` = URL del hook

### 5. Despliegue automático
Cada push a `main`:
1. GitHub Actions: lint → test → build Docker → push a GHCR
2. Render Deploy Hook → auto-deploy en Render

## Docker Local

```bash
# Construir
docker compose build

# Levantar
docker compose up -d

# Ver logs
docker compose logs -f whatsapp-bot

# Parar
docker compose down
```

## Uso del Bot

### Comandos (prefijo `!` por defecto)
| Comando | Descripción |
|---------|-------------|
| `!ping` | Verifica bot activo |
| `!info` | Estado conexión |
| `!help` | Muestra ayuda |

### API REST

#### Enviar mensaje
```bash
curl -X POST https://TU_BOT_URL/send-message \
  -H "Authorization: Bearer TU_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "51999999999", "text": "Hola desde API"}'
```

Respuesta exitosa:
```json
{"ok": true, "id": "3EB0...", "to": "51999999999@s.whatsapp.net"}
```

#### Health Check
```bash
curl https://TU_BOT_URL/
# {"bot":"MiBotWhatsApp","status":"connected","uptime":123.45}
```

## Flujo de Integración Web

### 1. Configurar en la Web (Panel admin)
1. Ir a **WhatsApp > Conexión**
2. Sección "Sin Cloud API: usa tu propio bot"
2. Pegar:
   - **URL**: `https://TU_TUNEL.trycloudflare.com` (salida del bot)
   - **Token**: `API_TOKEN` del `.env`
   - **Número**: `51993807551` (tu número con código país, sin +)
3. Click **"Conectar bot"**

### 2. Auto-registro
El bot se **auto-registra** cada vez que inicia:
- Crea túnel Cloudflare
- Registra URL en la web automáticamente
- Renueva si el túnel cambia

### 3. Webhook entrante
El bot reenvía mensajes a: `WEBHOOK_URL` con header `Authorization: Bearer WEBHOOK_TOKEN`

```json
{
  "messages": [{
    "id": "3EB0...",
    "from": "51999999999",
    "text": "Hola",
    "timestamp": 1720000000,
    "name": "Juan"
  }]
}
```

### 4. Estados de entrega
El bot reenvía confirmaciones:
```json
{
  "statuses": [{
    "id": "3EB0...",
    "status": "delivered",
    "timestamp": 1720000005
  }]
}
```

## Anti-Ban & Mejores Prácticas

| Práctica | Por qué |
|----------|---------|
| Usar número personal real | WhatsApp detecta números virtuales |
| Lotes ≤ 20 msg/corrida | Evita detección de spam |
| 1 campaña/30 días/cliente | Política Marketing WhatsApp |
| Solo contactos con opt-in | Requisito política WhatsApp |
| Incluir "SALIR" en Marketing | Obligatorio por política |
| Ventana 24h para sesión libre | Fuera de 24h = solo plantillas |

## Solución de Problemas

### Bot no conecta a WhatsApp
```bash
# Borrar sesión y re-escanear QR
rm -rf auth_info/
npm start
```

### Túnel no levanta
- Verificar que `cloudflared.exe` existe (Windows) o está en PATH (Docker)
- Verificar puerto 3000 libre

### Webhook no recibe mensajes
1. Verificar `WEBHOOK_URL` apunta a `/api/webhooks/whatsapp-bot`
2. `WEBHOOK_TOKEN` = `API_TOKEN` en ambos lados
2. Túnel activo y registrado en web

### Mensajes no llegan a destinatario
- Error 463 = número sin WhatsApp / bloqueado / privacidad
- Solo envía a contactos con **opt-in** (te escribieron primero)

## Estructura del Proyecto

```
whatsapp-bot/
├── .github/workflows/ci.yml    # CI/CD Pipeline
├── .github/dependabot.yml      # Auto-update deps
├── Dockerfile                  # Multi-stage build
├── docker-compose.yml          # Desarrollo local
├── .dockerignore
├── .gitignore
├── .env.example                # Template variables
├── .env                        # Variables locales (no commitear)
├── package.json
├── package-lock.json
├── index.js                    # Bot principal
├── iniciar.bat                 # Inicio Windows
├── tunel.bat                   # Túnel manual (legacy)
├── cloudflared.exe             # Binary Windows
├── auth_info/                  # Sesión WhatsApp (gitignored)
├── .github/
│   └── workflows/ci.yml        # CI/CD Pipeline
└── README.md
```

## Despliegue en Otras Plataformas

### Railway
```bash
railway login
railway init
railway up
```

### Fly.io
```bash
fly launch
fly deploy
```

### VPS (Ubuntu/Debian)
```bash
# Instalar Node.js 20, PM2, cloudflared
pm2 start index.js --name whatsapp-bot
pm2 startup
pm2 save
```

## Variables de Entorno para CI/CD (GitHub Secrets)

| Secret | Descripción |
|--------|-------------|
| `RENDER_DEPLOY_HOOK_URL` | URL Deploy Hook de Render |
| `DOCKER_USERNAME` | Usuario Docker Hub (opcional) |
| `DOCKER_PASSWORD` | Token Docker Hub (opcional) |

## Licencia

MIT - Libre para uso personal y comercial.

## Soporte

- Issues: [GitHub Issues](https://github.com/NsMoises/baileys/issues)
- Documentación Baileys: [WhatsApp Web API](https://github.com/WhiskeySockets/Baileys)
- Cloudflare Tunnel: [Cloudflare Docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)