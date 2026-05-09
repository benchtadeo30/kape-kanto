const express = require('express');
const router = express.Router();
const { db } = require('../database/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { verifyIdCard } = require('../services/gemini');
const path = require('path');
const fs = require('fs');

// POST /api/verify/upload-id
router.post('/upload-id', requireAuth, upload.single('id_image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded.' });
    }

    const { id_type } = req.body; // 'senior' or 'pwd'
    if (!['senior', 'pwd'].includes(id_type)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Invalid ID type. Must be senior or pwd.' });
    }

    try {
        const imagePath = `/uploads/ids/${req.file.filename}`;
        console.log(`[ID Verification] Starting for user ${req.session.userId}, type: ${id_type}`);
        
        // Save the image path first
        db.prepare(`
            UPDATE users 
            SET ${id_type === 'senior' ? 'senior_id_image' : 'pwd_id_image'} = ?, 
                id_verification_status = 'pending',
                id_verification_message = 'AI is analyzing your ID...'
            WHERE id = ?
        `).run(imagePath, req.session.userId);

        // Call Gemini AI
        const mimeType = req.file.mimetype;
        const aiResult = await verifyIdCard(req.file.path, mimeType, id_type);
        console.log(`[ID Verification] AI Result for user ${req.session.userId}:`, aiResult);

        // Process result
        let finalStatus = 'rejected';
        let isSenior = 0;
        let isPwd = 0;

        // Success if it's valid, high/medium confidence, and matches the expected type
        if (aiResult.isValid && aiResult.isExpectedType && (aiResult.confidence === 'high' || aiResult.confidence === 'medium')) {
            finalStatus = 'verified';
            if (id_type === 'senior') isSenior = 1;
            if (id_type === 'pwd') isPwd = 1;
        }

        // Use the AI provided reason as the primary message
        const displayMessage = aiResult.reason || (finalStatus === 'verified' ? 'ID Verified successfully!' : 'ID verification failed.');

        // Update with result
        db.prepare(`
            UPDATE users 
            SET id_verification_status = ?,
                id_verification_message = ?,
                id_verification_notes = ?,
                is_senior = CASE WHEN ? = 1 THEN 1 ELSE is_senior END,
                is_pwd = CASE WHEN ? = 1 THEN 1 ELSE is_pwd END
            WHERE id = ?
        `).run(finalStatus, displayMessage, JSON.stringify(aiResult), isSenior, isPwd, req.session.userId);

        console.log(`[ID Verification] Completed for user ${req.session.userId}. Status: ${finalStatus}`);

        res.json({
            message: displayMessage,
            status: finalStatus,
            details: aiResult
        });

    } catch (error) {
        console.error('[ID Verification] Error:', error);
        
        // Update user status to rejected so they can try again and the "Analyzing" message is cleared
        db.prepare(`
            UPDATE users 
            SET id_verification_status = 'rejected', 
                id_verification_message = 'The AI service is currently busy or unavailable. Please try again in a few moments.' 
            WHERE id = ?
        `).run(req.session.userId);

        res.status(500).json({ error: 'Failed to analyze ID. AI service may be busy, please try again.' });
    }
});

// POST /api/verify/remove-id
router.post('/remove-id', requireAuth, (req, res) => {
    try {
        db.prepare(`
            UPDATE users 
            SET senior_id_image = NULL, 
                pwd_id_image = NULL, 
                id_verification_status = 'none',
                id_verification_notes = NULL,
                is_senior = 0,
                is_pwd = 0
            WHERE id = ?
        `).run(req.session.userId);
        res.json({ message: 'ID removed successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// GET /api/verify/status
router.get('/status', requireAuth, (req, res) => {
    try {
        const status = db.prepare(`SELECT id_verification_status, id_verification_notes FROM users WHERE id = ?`).get(req.session.userId);
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

module.exports = router;
