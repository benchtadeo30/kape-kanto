const express = require('express');
const router = express.Router();
const { db } = require('../database/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const upload = require('../middleware/upload');
const path = require('path');
const fs = require('fs');

// POST /api/verify/upload-id — Submit ID + Selfie for Admin Review
router.post('/upload-id', requireAuth, upload.fields([
    { name: 'id_image', maxCount: 1 },
    { name: 'selfie_image', maxCount: 1 }
]), async (req, res) => {
    const idFile = req.files?.id_image?.[0];
    const selfieFile = req.files?.selfie_image?.[0];

    if (!idFile) {
        return res.status(400).json({ error: 'ID image is required.' });
    }
    if (!selfieFile) {
        if (idFile) fs.unlinkSync(idFile.path);
        return res.status(400).json({ error: 'Selfie holding your ID is required.' });
    }

    const { id_type, id_number } = req.body;
    const userId = parseInt(req.session.userId);
    
    if (!['senior', 'pwd'].includes(id_type)) {
        fs.unlinkSync(idFile.path);
        fs.unlinkSync(selfieFile.path);
        return res.status(400).json({ error: 'Invalid ID type. Must be senior or pwd.' });
    }

    if (!id_number || id_number.trim().length < 3) {
        fs.unlinkSync(idFile.path);
        fs.unlinkSync(selfieFile.path);
        return res.status(400).json({ error: 'Please enter a valid ID number.' });
    }

    try {
        // Check for duplicate ID numbers on OTHER accounts
        const duplicate = await db.prepare(`
            SELECT id, username FROM users 
            WHERE id_number = ? AND id != ? AND id_verification_status = 'verified'
        `).get(id_number.trim(), userId);

        if (duplicate) {
            fs.unlinkSync(idFile.path);
            fs.unlinkSync(selfieFile.path);
            return res.status(400).json({ 
                error: 'This ID number is already registered to another verified account. If this is an error, please contact support.' 
            });
        }

        const idImagePath = `/uploads/ids/${idFile.filename}`;
        const selfieImagePath = `/uploads/ids/${selfieFile.filename}`;

        const isUpdate = req.session.canUpdateID || false;
        
        await db.prepare(`
            UPDATE users 
            SET ${id_type === 'senior' ? 'senior_id_image' : 'pwd_id_image'} = ?, 
                selfie_image = ?,
                id_number = ?,
                id_verification_status = 'pending',
                id_verification_message = 'Your ID has been submitted and is under review by our team. You will be notified once verified.',
                id_verification_notes = ?
            WHERE id = ?
        `).run(idImagePath, selfieImagePath, id_number.trim(), JSON.stringify({ id_type, submitted_at: new Date().toISOString(), is_update: isUpdate }), userId);

        if (isUpdate) {
            req.session.canUpdateID = false;
        }

        res.json({
            message: 'Your ID and selfie have been submitted for review. Our team will verify your identity shortly.',
            status: 'pending'
        });

    } catch (error) {
        console.error('[ID Verification] Error:', error);
        res.status(500).json({ error: 'Failed to submit ID for verification. Please try again.' });
    }
});

// POST /api/verify/request-id-change-code
router.post('/request-id-change-code', requireAuth, async (req, res) => {
    try {
        const userId = parseInt(req.session.userId);
        const user = await db.prepare('SELECT email, id_verification_status FROM users WHERE id = ?').get(userId);
        
        if (user.id_verification_status !== 'verified') {
            return res.status(400).json({ error: 'Only verified IDs require a security code for changes.' });
        }

        const { sendVerificationEmail } = require('../services/email');
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        await db.prepare('UPDATE users SET verification_token = ? WHERE id = ?').run(code, userId);
        
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
router.post('/confirm-id-change', requireAuth, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code is required.' });

    try {
        const userId = parseInt(req.session.userId);
        const user = await db.prepare('SELECT verification_token FROM users WHERE id = ?').get(userId);
        
        if (!user || user.verification_token !== code) {
            return res.status(400).json({ error: 'Invalid or expired security code.' });
        }

        await db.prepare(`
            UPDATE users 
            SET senior_id_image = NULL, 
                pwd_id_image = NULL, 
                selfie_image = NULL,
                id_number = NULL,
                id_verification_status = 'none',
                id_verification_notes = NULL,
                id_verification_message = NULL,
                is_senior = 0,
                is_pwd = 0,
                verified_by = NULL,
                verified_at = NULL,
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
router.post('/remove-id', requireAuth, async (req, res) => {
    try {
        const userId = parseInt(req.session.userId);
        await db.prepare(`
            UPDATE users 
            SET senior_id_image = NULL, 
                pwd_id_image = NULL, 
                selfie_image = NULL,
                id_number = NULL,
                id_verification_status = 'none',
                id_verification_notes = NULL,
                id_verification_message = NULL,
                is_senior = 0,
                is_pwd = 0,
                verified_by = NULL,
                verified_at = NULL
            WHERE id = ?
        `).run(userId);
        res.json({ message: 'ID removed successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// GET /api/verify/status
router.get('/status', requireAuth, async (req, res) => {
    try {
        const userId = parseInt(req.session.userId);
        const status = await db.prepare(`SELECT id_verification_status, id_verification_notes FROM users WHERE id = ?`).get(userId);
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

// ── Phone Verification (Twilio SMS OTP) ─────────────────────────────────

// POST /api/verify/request-phone-otp
router.post('/request-phone-otp', requireAuth, async (req, res) => {
    const { phone_number } = req.body;
    if (!phone_number || phone_number.trim().length < 10) {
        return res.status(400).json({ error: 'Please enter a valid phone number.' });
    }

    try {
        const userId = req.session.userId;
        const otp = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit OTP
        const expiresAt = new Date(Date.now() + 10 * 60000).toISOString(); // 10 mins expiry

        await db.prepare(`
            UPDATE users 
            SET phone_otp = ?, phone_otp_expires = ?
            WHERE id = ?
        `).run(otp, expiresAt, userId);

        const { sendOTP } = require('../services/twilio');
        await sendOTP(phone_number.trim(), otp);

        res.json({ message: 'OTP sent successfully.' });
    } catch (error) {
        console.error('Request Phone OTP Error:', error);
        res.status(500).json({ error: 'Failed to send OTP.' });
    }
});

// POST /api/verify/verify-phone-otp
router.post('/verify-phone-otp', requireAuth, async (req, res) => {
    const { otp, phone_number } = req.body;
    if (!otp || !phone_number) {
        return res.status(400).json({ error: 'OTP and phone number are required.' });
    }

    try {
        const userId = req.session.userId;
        const user = await db.prepare(`
            SELECT phone_otp, phone_otp_expires 
            FROM users WHERE id = ?
        `).get(userId);

        if (!user || user.phone_otp !== otp.trim()) {
            return res.status(400).json({ error: 'Invalid OTP.' });
        }

        const expiresAt = new Date(user.phone_otp_expires);
        if (new Date() > expiresAt) {
            return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
        }

        await db.prepare(`
            UPDATE users 
            SET is_phone_verified = 1, phone_number = ?, phone_otp = NULL, phone_otp_expires = NULL
            WHERE id = ?
        `).run(phone_number.trim(), userId);

        res.json({ message: 'Phone number verified successfully.' });
    } catch (error) {
        console.error('Verify Phone OTP Error:', error);
        res.status(500).json({ error: 'Failed to verify OTP.' });
    }
});

module.exports = router;
