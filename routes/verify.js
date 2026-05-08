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
        // cleanup file
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Invalid ID type. Must be senior or pwd.' });
    }

    try {
        const imagePath = `/uploads/ids/${req.file.filename}`;
        
        // 1. Update DB immediately to 'pending' to save the file reference
        const updateStmt = db.prepare(`
            UPDATE users 
            SET ${id_type === 'senior' ? 'senior_id_image' : 'pwd_id_image'} = ?, 
                id_verification_status = 'pending',
                id_verification_notes = 'Analyzing...'
            WHERE id = ?
        `);
        updateStmt.run(imagePath, req.session.userId);

        // 2. Call Gemini AI
        const mimeType = req.file.mimetype;
        const aiResult = await verifyIdCard(req.file.path, mimeType);

        // 3. Process result
        let finalStatus = 'pending';
        let isSenior = 0;
        let isPwd = 0;

        if (aiResult.isValid && aiResult.confidence === 'high') {
            finalStatus = 'verified';
            if (id_type === 'senior') isSenior = 1;
            if (id_type === 'pwd') isPwd = 1;
        } else if (!aiResult.isValid && aiResult.confidence === 'high') {
            finalStatus = 'rejected';
        }

        // 4. Update DB with final result
        const finalUpdateStmt = db.prepare(`
            UPDATE users 
            SET id_verification_status = ?,
                id_verification_notes = ?,
                is_senior = CASE WHEN ? = 1 THEN 1 ELSE is_senior END,
                is_pwd = CASE WHEN ? = 1 THEN 1 ELSE is_pwd END
            WHERE id = ?
        `);
        
        const aiNotes = JSON.stringify(aiResult);
        finalUpdateStmt.run(finalStatus, aiNotes, isSenior, isPwd, req.session.userId);

        res.json({
            message: 'Verification complete',
            status: finalStatus,
            details: aiResult
        });

    } catch (error) {
        console.error('Upload ID Error:', error);
        try {
            db.prepare(`UPDATE users SET id_verification_notes = ? WHERE id = ?`).run('Analysis Failed: ' + error.message, req.session.userId);
        } catch (e) {} // ignore DB update error
        res.status(500).json({ error: 'Automated analysis failed. Please try again with a clearer image.' });
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
