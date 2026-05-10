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
    const userId = parseInt(req.session.userId);
    
    if (!['senior', 'pwd'].includes(id_type)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Invalid ID type. Must be senior or pwd.' });
    }

    try {
        const imagePath = `/uploads/ids/${req.file.filename}`;
        console.log(`[ID Verification] Starting for user ${userId}, type: ${id_type}`);
        
        // Save the image path first
        db.prepare(`
            UPDATE users 
            SET ${id_type === 'senior' ? 'senior_id_image' : 'pwd_id_image'} = ?, 
                id_verification_status = 'pending',
                id_verification_message = 'AI is analyzing your ID...'
            WHERE id = ?
        `).run(imagePath, userId);

        // Call Gemini AI
        const mimeType = req.file.mimetype;
        const aiResult = await verifyIdCard(req.file.path, mimeType, id_type);
        console.log(`[ID Verification] AI Result for user ${userId}:`, aiResult);

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
        `).run(finalStatus, displayMessage, JSON.stringify(aiResult), isSenior, isPwd, userId);

        if (finalStatus === 'verified') {
            req.session.canUpdateID = false;
        }

        console.log(`[ID Verification] Completed for user ${userId}. Status: ${finalStatus}`);

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
        `).run(userId);

        res.status(500).json({ error: 'Failed to analyze ID. AI service may be busy, please try again.' });
    }
});

// POST /api/verify/request-id-change-code
router.post('/request-id-change-code', requireAuth, async (req, res) => {
    try {
        const userId = parseInt(req.session.userId);
        const user = db.prepare('SELECT email, id_verification_status FROM users WHERE id = ?').get(userId);
        
        if (user.id_verification_status !== 'verified') {
            return res.status(400).json({ error: 'Only verified IDs require a security code for changes.' });
        }

        const { sendVerificationEmail } = require('../services/email');
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        db.prepare('UPDATE users SET verification_token = ? WHERE id = ?').run(code, userId);
        
        try {
            await sendVerificationEmail(user.email, code);
            res.json({ message: 'A security code has been sent to your registered email.' });
        } catch (e) {
            console.error('Failed to send ID change code email:', e);
            return res.status(500).json({ error: 'Failed to send security code. Please check your internet connection and try again.' });
        }
    } catch (error) {
        console.error('ID Change Code Error:', error);
        res.status(500).json({ error: 'Failed to process request.' });
    }
});

// POST /api/verify/confirm-id-change
router.post('/confirm-id-change', requireAuth, (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code is required.' });

    try {
        const userId = parseInt(req.session.userId);
        const user = db.prepare('SELECT verification_token FROM users WHERE id = ?').get(userId);
        
        if (!user || user.verification_token !== code) {
            return res.status(400).json({ error: 'Invalid or expired security code.' });
        }

        // Clear ID data and status
        db.prepare(`
            UPDATE users 
            SET senior_id_image = NULL, 
                pwd_id_image = NULL, 
                id_verification_status = 'none',
                id_verification_notes = NULL,
                id_verification_message = NULL,
                is_senior = 0,
                is_pwd = 0,
                verification_token = NULL
            WHERE id = ?
        `).run(userId);

        res.json({ message: 'ID verification cleared. You can now upload a new ID.' });
    } catch (error) {
        console.error('Confirm ID Change Error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/verify/remove-id
router.post('/remove-id', requireAuth, (req, res) => {
    try {
        const userId = parseInt(req.session.userId);
        db.prepare(`
            UPDATE users 
            SET senior_id_image = NULL, 
                pwd_id_image = NULL, 
                id_verification_status = 'none',
                id_verification_notes = NULL,
                is_senior = 0,
                is_pwd = 0
            WHERE id = ?
        `).run(userId);
        res.json({ message: 'ID removed successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// GET /api/verify/status
router.get('/status', requireAuth, (req, res) => {
    try {
        const userId = parseInt(req.session.userId);
        const status = db.prepare(`SELECT id_verification_status, id_verification_notes FROM users WHERE id = ?`).get(userId);
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/verify/cancel-id-update
router.post('/cancel-id-update', requireAuth, (req, res) => {
    req.session.canUpdateID = false;
    res.json({ message: 'ID update cancelled.' });
});

module.exports = router;
