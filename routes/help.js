const express = require('express');
const router = express.Router();
const { generateChatResponse } = require('../services/gemini');

// Render Help Center Page
router.get('/', (req, res) => {
    res.render('help', { title: 'Help Center & AI Support - Kape Kanto Hub' });
});

// Handle AI Chat Messages
router.post('/api/chat', async (req, res) => {
    const { message, history } = req.body;
    
    if (!message) {
        return res.status(400).json({ error: 'Message is required.' });
    }

    try {
        const reply = await generateChatResponse(message, history || []);
        res.json({ reply });
    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({ error: 'Failed to connect to AI Assistant. Please try again later.' });
    }
});

module.exports = router;
