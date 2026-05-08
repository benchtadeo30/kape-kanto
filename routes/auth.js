const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { db } = require('../database/init');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { verifyIdCard } = require('../services/gemini');
const { sendVerificationEmail, sendResetPasswordEmail } = require('../services/email');
const fs = require('fs');

// POST /api/auth/register
router.post('/register', upload.single('profile_image'), async (req, res) => {
    const { username, email: rawEmail, password } = req.body;
    const email = rawEmail ? rawEmail.trim().toLowerCase() : rawEmail;

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are required.' });
    }

    // Password Complexity Validation
    const passwordRegex = /^(?=.*[A-Z])(?=.*[0-9].*[0-9])(?=.*[!@#$%^&*])(?=.{5,})/;
    if (!passwordRegex.test(password)) {
        return res.status(400).json({ 
            error: 'Password needs 5+ chars, 1 uppercase, 2 numbers, 1 special char.' 
        });
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        
        // Generate verification code
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

        const stmt = db.prepare(`
            INSERT INTO users (username, email, password, role, is_senior, is_pwd, id_verification_status, id_verification_notes, senior_id_image, pwd_id_image, profile_image, verification_token, is_verified)
            VALUES (?, ?, ?, 'customer', 0, 0, 'none', NULL, NULL, NULL, ?, ?, 0)
        `);
        
        const profileImage = req.file ? req.file.filename : null;

        const info = stmt.run(
            username, 
            email, 
            hash, 
            profileImage,
            verificationCode
        );
        
        // Send Verification Email
        let emailSent = true;
        try {
            await sendVerificationEmail(email, verificationCode);
        } catch (emailError) {
            console.error('Failed to send verification email:', emailError);
            emailSent = false;
        }

        // Auto-login the user
        req.session.userId = info.lastInsertRowid;
        req.session.role = 'customer';

        res.status(201).json({ 
            message: 'Registration successful. Please verify your email.', 
            email: email,
            userId: info.lastInsertRowid,
            emailSent: emailSent,
            verificationStatus: 'none'
        });
    } catch (error) {
        if (req.file) fs.unlinkSync(req.file.path);
        if (error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Username or email already exists.' });
        }
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/resend-code
router.post('/resend-code', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    try {
        const user = db.prepare(`SELECT id, is_verified, pending_email FROM users WHERE email = ? OR pending_email = ?`).get(email, email);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        
        // If they are verifying their primary email but it's already verified, AND they don't have a pending change
        if (user.is_verified == 1 && user.pending_email !== email) {
            return res.status(400).json({ error: 'Email already verified.' });
        }

        const newCode = Math.floor(100000 + Math.random() * 900000).toString();
        db.prepare(`UPDATE users SET verification_token = ? WHERE id = ?`).run(newCode, user.id);

        await sendVerificationEmail(email, newCode);
        res.json({ message: 'New verification code sent.' });
    } catch (error) {
        console.error('Resend code error:', error);
        res.status(500).json({ error: 'Failed to resend code.' });
    }
});

// POST /api/auth/verify-email
router.post('/verify-email', (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });

    try {
        const user = db.prepare(`SELECT id, email, pending_email FROM users WHERE (email = ? OR pending_email = ?) AND verification_token = ?`).get(email, email, code);
        if (!user) return res.status(400).json({ error: 'Invalid verification code.' });

        if (user.pending_email === email) {
            // This was an email change
            db.prepare(`UPDATE users SET email = ?, pending_email = NULL, is_verified = 1, verification_token = NULL WHERE id = ?`).run(email, user.id);
        } else {
            // This was a standard registration verification
            db.prepare(`UPDATE users SET is_verified = 1, verification_token = NULL WHERE id = ?`).run(user.id);
        }
        
        // Evaluate verify_email promo tasks
        const activeTasks = db.prepare("SELECT * FROM promo_tasks WHERE is_active = 1 AND task_type = 'verify_email' AND (end_date IS NULL OR end_date >= datetime('now'))").all();
        activeTasks.forEach(task => {
            let progress = db.prepare('SELECT * FROM user_promo_progress WHERE user_id = ? AND promo_task_id = ?').get(user.id, task.id);
            if (!progress) {
                const progInfo = db.prepare('INSERT INTO user_promo_progress (user_id, promo_task_id, current_quantity) VALUES (?, ?, 0)').run(user.id, task.id);
                progress = { id: progInfo.lastInsertRowid, current_quantity: 0, is_completed: 0 };
            }
            if (!progress.is_completed) {
                db.prepare('UPDATE user_promo_progress SET current_quantity = ?, is_completed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(task.required_quantity || 1, progress.id);
                if (task.reward_promo_id) {
                    db.prepare('INSERT INTO user_coupons (user_id, promo_id) VALUES (?, ?)').run(user.id, task.reward_promo_id);
                }
            }
        });

        // Log user in automatically after verification
        req.session.userId = user.id;
        req.session.role = 'customer';

        res.json({ message: 'Email verified successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
        const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.trim().toLowerCase());

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        req.session.userId = user.id;
        req.session.role = user.role;

        // Still send unverified info so frontend can decide if it wants to redirect to verify
        if (user.role === 'customer' && user.is_verified != 1) {
            return res.json({ 
                message: 'Login successful, but unverified.',
                role: user.role,
                unverified: true,
                email: user.email
            });
        }

        res.json({ message: 'Login successful', role: user.role });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    try {
        const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
        if (!user) {
            // Don't reveal if user exists or not for security
            return res.json({ message: 'If an account exists with this email, a reset link has been sent.' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 3600000).toISOString(); // 1 hour

        db.prepare(`UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?`).run(token, expiry, user.id);

        try {
            await sendResetPasswordEmail(email, token);
        } catch (e) {
            console.error('Reset email error:', e);
        }

        res.json({ message: 'If an account exists with this email, a reset link has been sent.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });

    try {
        const user = db.prepare(`SELECT id FROM users WHERE reset_token = ? AND reset_token_expiry > datetime('now')`).get(token);
        if (!user) return res.status(400).json({ error: 'Invalid or expired reset token.' });

        const hash = await bcrypt.hash(password, 10);
        db.prepare(`UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?`).run(hash, user.id);

        res.json({ message: 'Password reset successfully. You can now login.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ error: 'Could not log out.' });
        }
        res.json({ message: 'Logout successful' });
    });
});

// POST /api/auth/request-security-code
router.post('/request-security-code', requireAuth, async (req, res) => {
    try {
        const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        db.prepare('UPDATE users SET verification_token = ? WHERE id = ?').run(code, req.session.userId);
        
        await sendVerificationEmail(user.email, code); // Reuse same email service for now
        res.json({ message: 'Verification code sent to your email.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send verification code.' });
    }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
    try {
        const user = db.prepare(`
            SELECT id, username, email, role, is_senior, is_pwd, id_verification_status 
            FROM users WHERE id = ?
        `).get(req.session.userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// PATCH /api/auth/update-profile
router.patch('/update-profile', requireAuth, async (req, res) => {
    const { email, username, code } = req.body;

    if (!code) return res.status(400).json({ error: 'Verification code is required.' });

    const currentUser = db.prepare('SELECT is_verified, role, email, verification_token FROM users WHERE id = ?').get(req.session.userId);
    
    if (code !== currentUser.verification_token) {
        return res.status(400).json({ error: 'Invalid verification code.' });
    }

    try {
        const updates = [];
        const params = [];
        let emailChanged = false;
        let newEmail = null;

        if (username) {
            updates.push('username = ?');
            params.push(username);
        }

        // Check if email is being changed
        if (email && email.trim().toLowerCase() !== currentUser.email) {
            newEmail = email.trim().toLowerCase();
            
            // Check if email is already taken as primary OR pending by someone else
            const existing = db.prepare('SELECT id FROM users WHERE (email = ? OR pending_email = ?) AND id != ?').get(newEmail, newEmail, req.session.userId);
            if (existing) {
                return res.status(400).json({ error: 'This email is already in use or has a pending verification.' });
            }

            emailChanged = true;
            const newCode = Math.floor(100000 + Math.random() * 900000).toString();
            updates.push('pending_email = ?', 'verification_token = ?');
            params.push(newEmail, newCode);
        }

        if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });

        params.push(req.session.userId);
        const info = db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        if (info.changes === 0) return res.status(404).json({ error: 'User not found.' });

        if (emailChanged && newEmail) {
            // Get the new code to send
            const updatedUser = db.prepare('SELECT verification_token FROM users WHERE id = ?').get(req.session.userId);
            let emailSent = false;
            try {
                await sendVerificationEmail(newEmail, updatedUser.verification_token);
                emailSent = true;
            } catch (e) {
                console.error('Failed to send re-verification email:', e);
            }
            return res.json({ 
                message: 'Update request received. Please verify your new email address to complete the change.',
                emailChanged: true,
                newEmail: newEmail,
                emailSent
            });
        }

        res.json({ message: 'Profile updated successfully.' });
    } catch (error) {
        if (error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Username or email already in use.' });
        }
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// PATCH /api/auth/change-password
router.patch('/change-password', requireAuth, async (req, res) => {
    const { new_password, confirm_password, code } = req.body;
    
    if (!code) return res.status(400).json({ error: 'Verification code is required.' });
    if (!new_password) return res.status(400).json({ error: 'New password is required.' });
    if (new_password !== confirm_password) return res.status(400).json({ error: 'Passwords do not match.' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters long.' });

    const currentUser = db.prepare('SELECT verification_token FROM users WHERE id = ?').get(req.session.userId);
    if (code !== currentUser.verification_token) {
        return res.status(400).json({ error: 'Invalid verification code.' });
    }

    try {
        const hash = await bcrypt.hash(new_password, 10);
        db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.session.userId);
        res.json({ message: 'Password updated successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/cancel-email-change
router.post('/cancel-email-change', requireAuth, (req, res) => {
    try {
        db.prepare('UPDATE users SET pending_email = NULL, verification_token = NULL WHERE id = ?').run(req.session.userId);
        res.json({ message: 'Email change request cancelled.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});



// DELETE /api/auth/delete-account
router.delete('/delete-account', requireAuth, (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code is required.' });

    const user = db.prepare('SELECT is_verified, role, verification_token FROM users WHERE id = ?').get(req.session.userId);
    
    if (code !== user.verification_token) {
        return res.status(400).json({ error: 'Invalid verification code.' });
    }

    
    // Admins shouldn't delete themselves via this customer endpoint
    if (user.role === 'admin') {
        return res.status(403).json({ error: 'Admins cannot delete their accounts here.' });
    }

    try {
        const info = db.prepare('DELETE FROM users WHERE id = ?').run(req.session.userId);
        if (info.changes === 0) return res.status(404).json({ error: 'User not found.' });

        req.session.destroy(err => {
            if (err) return res.status(500).json({ error: 'Failed to destroy session.' });
            res.json({ message: 'Account deleted successfully.' });
        });
    } catch (error) {
        console.error('Delete account error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// PATCH /api/auth/update-avatar
router.patch('/update-avatar', requireAuth, upload.single('profile_image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

    try {
        const user = db.prepare('SELECT profile_image FROM users WHERE id = ?').get(req.session.userId);
        
        // Delete old image if it exists
        if (user.profile_image) {
            const oldPath = path.join(__dirname, '..', 'public', 'uploads', 'profiles', user.profile_image);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        db.prepare('UPDATE users SET profile_image = ? WHERE id = ?').run(req.file.filename, req.session.userId);
        res.json({ message: 'Profile picture updated successfully!', filename: req.file.filename });
    } catch (error) {
        console.error('Update avatar error:', error);
        res.status(500).json({ error: 'Failed to update profile picture.' });
    }
});

module.exports = router;
