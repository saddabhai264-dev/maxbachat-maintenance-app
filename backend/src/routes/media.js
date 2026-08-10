const express = require('express');
const crypto = require('crypto');
const { requireAuth, requirePasswordReady } = require('../auth');
const { presignPutUrl, publicUrlFor, uploadObject } = require('../spaces');

const router = express.Router();
router.use(requireAuth);
router.use(requirePasswordReady);

// POST /api/media/presign  { filename, contentType, size }
// Returns a short-lived URL the browser can PUT the file to directly.
router.post('/presign', async (req, res) => {
  if (!['captain', 'reporter', 'coordinator'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { filename, contentType, size } = req.body || {};
  if (!filename || !contentType || !Number.isFinite(Number(size))) {
    return res.status(400).json({ error: 'filename, contentType and size required' });
  }
  if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
    return res.status(400).json({ error: 'Only image or video files are allowed' });
  }
  const maxBytes = contentType.startsWith('video/') ? 60 * 1024 * 1024 : 15 * 1024 * 1024;
  if (Number(size) <= 0 || Number(size) > maxBytes) {
    return res.status(400).json({ error: `File is too large. Max ${contentType.startsWith('video/') ? '60MB for video' : '15MB for photos'}.` });
  }

  const ext = (filename.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = `issues/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;

  try {
    const uploadUrl = await presignPutUrl(key, contentType);
    res.json({
      uploadUrl,
      key,
      publicUrl: publicUrlFor(key),
      acl: process.env.MEDIA_PUBLIC_READ === 'true' ? 'public-read' : null,
      type: contentType.startsWith('video/') ? 'video' : 'image'
    });
  } catch (e) {
    console.error('Media presign failed', {
      code: e.code,
      message: e.message,
      contentType,
      size,
      hasEndpoint: Boolean(process.env.SPACES_ENDPOINT),
      hasRegion: Boolean(process.env.SPACES_REGION),
      hasBucket: Boolean(process.env.SPACES_BUCKET),
      hasUrl: Boolean(process.env.SPACES_URL)
    });
    const configMissing = e.code === 'STORAGE_CONFIG_MISSING';
    res.status(500).json({
      error: configMissing
        ? 'Upload storage is not configured. Please contact admin.'
        : 'Could not prepare video upload. Please try a photo, or contact admin if video proof is required.'
    });
  }
});

// POST /api/media/upload { filename, contentType, dataBase64, size }
// Server-side upload path for compressed photos. Avoids browser-to-Spaces CORS issues.
router.post('/upload', async (req, res) => {
  if (!['captain', 'reporter', 'coordinator'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { filename, contentType, dataBase64, size } = req.body || {};
  if (!filename || !contentType || !dataBase64 || !Number.isFinite(Number(size))) {
    return res.status(400).json({ error: 'filename, contentType, dataBase64 and size required' });
  }
  if (!contentType.startsWith('image/')) {
    return res.status(400).json({ error: 'Server upload supports photos only' });
  }
  if (Number(size) <= 0 || Number(size) > 3 * 1024 * 1024) {
    return res.status(400).json({ error: 'Photo is too large. Please choose a smaller photo.' });
  }

  const ext = (filename.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const key = `issues/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;

  try {
    await uploadObject(key, contentType, Buffer.from(dataBase64, 'base64'));
    res.json({
      key,
      publicUrl: publicUrlFor(key),
      type: 'image'
    });
  } catch (e) {
    console.error('Media photo upload failed', {
      code: e.code,
      message: e.message,
      contentType,
      size,
      hasEndpoint: Boolean(process.env.SPACES_ENDPOINT),
      hasRegion: Boolean(process.env.SPACES_REGION),
      hasKey: Boolean(process.env.SPACES_KEY),
      hasSecret: Boolean(process.env.SPACES_SECRET),
      hasBucket: Boolean(process.env.SPACES_BUCKET),
      hasUrl: Boolean(process.env.SPACES_URL)
    });
    const configMissing = e.code === 'STORAGE_CONFIG_MISSING';
    res.status(500).json({
      error: configMissing
        ? 'Upload storage is not configured. Please contact admin.'
        : 'Could not upload photo to storage. Please contact admin.'
    });
  }
});

module.exports = router;
