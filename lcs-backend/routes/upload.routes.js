const express = require('express');
const router = express.Router();
const { put } = require('@vercel/blob');

router.post('/', async (req, res) => {
  try {
    const filename = req.query.filename || 'school-document'; 
    
    const blob = await put(filename, req, {
      access: 'public',
    });

    res.status(200).json({ 
      message: 'File uploaded successfully', 
      url: blob.url 
    });
    
  } catch (error) {
    console.error("Blob upload error:", error);
    res.status(500).json({ error: "Failed to upload file to Vercel" });
  }
});

module.exports = router;