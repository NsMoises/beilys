const express = require('express');
const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    const app = req.app;
    
    const status = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      commit: process.env.GIT_COMMIT || 'unknown',
      services: {
        whatsapp: app.locals.socket?.ws?.readyState === 1 ? 'connected' : 'disconnected',
        webhook: process.env.WEBHOOK_URL ? 'configured' : 'not_configured',
        tunnel: global.lastTunnelUrl || 'not_established',
        database: 'connected', // Would need actual check
      },
      queue: {
        pending: 0,
        sent: 0,
        failed: 0,
      },
      lastDelivery: null,
      pendingMessages: 0,
      failedMessages: 0,
    };

    // Get actual stats if services are available
    if (app.locals.messageProcessor) {
      const stats = await app.locals.messageProcessor.getStats();
      Object.assign(status.queue, stats);
    }

    res.json(status);
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;