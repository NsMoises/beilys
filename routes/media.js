const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const router = express.Router();

// Middleware to verify API token
function verifyApiToken(req, res, next) {
  const apiToken = process.env.API_TOKEN;
  const authHeader = req.headers['authorization'] || '';
  
  if (!apiToken || authHeader !== `Bearer ${process.env.API_TOKEN}`) {
    return res.status(401).json({ 
      ok: false, 
      error: 'No autorizado. Envia Authorization: Bearer <API_TOKEN>' 
    });
  }
  
  next();
}

// GET /media/:downloadId - Download media file
router.get('/:downloadId', async (req, res) => {
  try {
    const { downloadId } = req.params;
    
    if (!downloadId || !/^[a-f0-9]{32}$/i.test(downloadId)) {
      return res.status(400).json({ ok: false, error: 'ID de descarga inválido' });
    }

    // Get media file from database
    const mediaFile = await req.app.locals.mediaService.getMediaForDownload(req.params.downloadId);
    
    if (!mediaFile) {
      return res.status(404).json({ ok: false, error: 'Archivo no encontrado' });
    }

    // Check if expired
    if (mediaFile.expiresAt && new Date(mediaFile.expiresAt) < new Date()) {
      return res.status(410).json({ ok: false, error: 'El archivo ha expirado' });
    }

    // Check if file exists
    if (!mediaFile.filePath || !require('fs').existsSync(mediaFile.filePath)) {
      return res.status(404).json({ ok: false, error: 'Archivo no encontrado en almacenamiento' });
    }

    // Check file size
    const stats = require('fs').statSync(mediaFile.filePath);
    const maxSize = parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024;
    
    if (stats.size > maxSize) {
      return res.status(413).json({ ok: false, error: 'Archivo demasiado grande' });
    }

    // Mark as downloaded
    await req.app.locals.mediaService.markAsDownloaded(req.params.downloadId);

    // Set headers
    res.setHeader('Content-Type', mediaFile.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', mediaFile.size || require('fs').statSync(mediaFile.filePath).size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(mediaFile.filename || 'file')}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Stream the file
    const fileStream = require('fs').createReadStream(mediaFile.filePath);
    
    fileStream.on('error', (err) => {
      console.error('Error streaming file:', err);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'Error al leer el archivo' });
      }
    });

    fileStream.pipe(res);
  } catch (error) {
    console.error('Error in media download:', error);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'Error interno del servidor' });
    }
  }
});

module.exports = router;