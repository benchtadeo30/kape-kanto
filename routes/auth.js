const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { db } = require('../database/init');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { sendVerificationEmail, sendResetPasswordEmail, sendAccountDeletedEmail } = require('../services/email');
const fs = require('fs');
const path = require('path');

// Debug Routes
router.get('/ping', (req, res) => res.json({ message: 'Auth router is active' }));
router.post('/test-post', (req, res) => res.json({ message: 'POST to Auth router is working' }));

function getEmailFailureResponse(error) {
    if (error.code === 'EMAIL_CONFIG_MISSING') {
        return { code: 'EMAIL_CONFIG_MISSING', error: 'Email service is not configured on the server. Please contact support.' };
    }
    if (error.code === 'EAUTH' || error.responseCode === 535) {
        return { code: 'EMAIL_AUTH_FAILED', error: 'Email sender login failed. Please check the Gmail app password configured on the server.' };
    }
    if (error.code === 'ESOCKET' || error.code === 'ETIMEDOUT' || error.command === 'CONN') {
        return { code: 'EMAIL_SMTP_CONNECTION_FAILED', error: 'Server could not connect to Gmail SMTP. Please try again in a moment.' };
    }
    if (error.code === 'EMAIL_API_FAILED') {
        return { code: 'EMAIL_API_FAILED', error: 'Email API failed to send the verification email. Please check the email provider settings.' };
    }
    return { code: 'EMAIL_SEND_FAILED', error: 'Registration failed to send verification email. Please try again.' };
}

// POST /api/auth/register
router.post('/register', upload.single('profile_image'), async (req, res) => {
    const { username, email: rawEmail, password } = req.body;
    const email = rawEmail ? rawEmail.trim().toLowerCase() : rawEmail;

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are required.' });
    }
    if (!email.endsWith('@gmail.com')) {
        return res.status(400).json({ error: 'Kape Kanto Hub requires a valid @gmail.com address for customer accounts.' });
    }
    const passwordRegex = /^(?=.*[A-Z])(?=.*[0-9].*[0-9])(?=.*[!@#$%^&*_])(?=.{5,})/;
    if (!passwordRegex.test(password)) {
        return res.status(400).json({ error: 'Password needs 5+ chars, 1 uppercase, 2 numbers, 1 special char (including _).' });
    }

    try {
        const existingUser = await db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
        if (existingUser) {
            return res.status(400).json({ error: 'This email address is already registered.' });
        }
        const hash = await bcrypt.hash(password, 10);
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const profileImage = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : null;

        await db.prepare(`
            INSERT OR REPLACE INTO pending_users (username, email, password, profile_image, verification_token)
            VALUES (?, ?, ?, ?, ?)
        `).run(username, email, hash, profileImage, verificationCode);
        
        try {
            await sendVerificationEmail(email, verificationCode);
        } catch (emailError) {
            console.error('Failed to send verification email:', emailError);
            return res.status(500).json(getEmailFailureResponse(emailError));
        }

        res.status(201).json({ message: 'Registration data saved. Please verify your email to complete registration.', email: email, unverified: true });
    } catch (error) {
        if (error.message && error.message.includes('UNIQUE constraint failed')) {
            if (error.message.includes('users.email')) return res.status(400).json({ error: 'This email address is already registered.' });
            return res.status(400).json({ error: 'Email already exists.' });
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
        const newCode = Math.floor(100000 + Math.random() * 900000).toString();
        const user = await db.prepare(`SELECT id, is_verified, pending_email FROM users WHERE email = ? OR pending_email = ?`).get(email, email);
        if (user) {
            await db.prepare(`UPDATE users SET verification_token = ? WHERE id = ?`).run(newCode, user.id);
            await sendVerificationEmail(email, newCode);
            return res.json({ message: 'New verification code sent.' });
        }
        const pending = await db.prepare(`SELECT id FROM pending_users WHERE email = ?`).get(email);
        if (pending) {
            await db.prepare(`UPDATE pending_users SET verification_token = ? WHERE id = ?`).run(newCode, pending.id);
            await sendVerificationEmail(email, newCode);
            return res.json({ message: 'New verification code sent.' });
        }
        return res.status(404).json({ error: 'User not found.' });
    } catch (error) {
        console.error('Resend code error:', error);
        res.status(500).json({ error: 'Failed to resend code.' });
    }
});

// POST /api/auth/verify-email
router.post('/verify-email', async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });

    try {
        let user = await db.prepare(`SELECT id, email, pending_email, role FROM users WHERE (email = ? OR pending_email = ?) AND verification_token = ?`).get(email, email, code);
        
        if (user) {
            if (user.pending_email === email) {
                await db.prepare(`UPDATE users SET email = ?, pending_email = NULL, is_verified = 1, verification_token = NULL WHERE id = ?`).run(email, user.id);
            } else {
                await db.prepare(`UPDATE users SET is_verified = 1, verification_token = NULL WHERE id = ?`).run(user.id);
            }
        } else {
            const pending = await db.prepare(`SELECT * FROM pending_users WHERE email = ? AND verification_token = ?`).get(email, code);
            if (!pending) return res.status(400).json({ error: 'Invalid verification code.' });

            const conflict = await db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
            if (conflict) {
                await db.prepare('DELETE FROM pending_users WHERE id = ?').run(pending.id);
                return res.status(400).json({ error: 'This email address was taken while you were verifying. Please register again.' });
            }

            const info = await db.prepare(`
                INSERT INTO users (username, email, password, role, profile_image, is_verified)
                VALUES (?, ?, ?, 'customer', ?, 1)
            `).run(pending.username, pending.email, pending.password, pending.profile_image);

            user = { id: info.lastInsertRowid, role: 'customer' };
            await db.prepare('DELETE FROM pending_users WHERE id = ?').run(pending.id);
        }
        
        // Evaluate verify_email promo tasks
        const activeTasks = await db.prepare("SELECT * FROM promo_tasks WHERE is_active = 1 AND task_type = 'verify_email' AND (end_date IS NULL OR end_date >= datetime('now'))").all();
        for (const task of activeTasks) {
            let progress = await db.prepare('SELECT * FROM user_promo_progress WHERE user_id = ? AND promo_task_id = ?').get(user.id, task.id);
            if (!progress) {
                const progInfo = await db.prepare('INSERT INTO user_promo_progress (user_id, promo_task_id, current_quantity) VALUES (?, ?, 0)').run(user.id, task.id);
                progress = { id: progInfo.lastInsertRowid, current_quantity: 0, is_completed: 0 };
            }
            if (!progress.is_completed) {
                await db.prepare('UPDATE user_promo_progress SET current_quantity = ?, is_completed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(task.required_quantity || 1, progress.id);
                if (task.reward_promo_id) {
                    await db.prepare('INSERT INTO user_coupons (user_id, promo_id) VALUES (?, ?)').run(user.id, task.reward_promo_id);
                }
            }
        }

        req.session.userId = user.id;
        req.session.role = user.role;
        req.session.isVerifiedInSession = true;

        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ message: 'Email verified successfully.' });
        });
    } catch (error) {
        console.error('Verify email error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    try {
        const identifier = email.trim();
        const user = await db.prepare(`SELECT * FROM users WHERE LOWER(email) = LOWER(?)`).get(identifier);

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        // Block admin/staff from logging in via the customer login page
        if (user.role === 'admin' || user.role === 'staff') {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        req.session.userId = user.id;
        req.session.role = user.role;
        req.session.isVerifiedInSession = (user.role === 'admin' || user.role === 'staff');

        req.session.save(async (err) => {
            if (err) console.error('Session save error:', err);

            if (user.role === 'customer') {
                req.session.isVerifiedInSession = false;
                try {
                    const newCode = Math.floor(100000 + Math.random() * 900000).toString();
                    await db.prepare(`UPDATE users SET verification_token = ? WHERE id = ?`).run(newCode, user.id);
                    await sendVerificationEmail(user.email, newCode);
                    console.log(`[AUTH] Auto-sent mandatory verification code to ${user.email} on login.`);
                } catch (emailErr) {
                    console.error('[AUTH ERROR] Failed to auto-send mandatory verification code on login:', emailErr);
                }
                return res.json({ message: 'Login successful. A security verification code has been sent to your email.', role: user.role, unverified: true, email: user.email });
            }
            res.json({ message: 'Login successful', role: user.role });
        });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/staff-login (Admin & Staff only)
router.post('/staff-login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    try {
        const identifier = email.trim();
        const user = await db.prepare(`SELECT * FROM users WHERE LOWER(email) = LOWER(?)`).get(identifier);

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        // Only allow admin and staff roles through this portal
        if (user.role !== 'admin' && user.role !== 'staff') {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        req.session.userId = user.id;
        req.session.role = user.role;
        req.session.isVerifiedInSession = true;

        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ message: 'Login successful', role: user.role });
        });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    try {
        const user = await db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.trim().toLowerCase());
        if (!user) return res.status(404).json({ error: 'User with this email not found.' });

        const token = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 3600000).toISOString();
        await db.prepare(`UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?`).run(token, expiry, user.id);

        try { await sendResetPasswordEmail(email, token); } catch (e) {
            console.error('Reset email error:', e);
            return res.status(500).json({ error: 'Failed to send reset email. Please try again later.' });
        }
        res.json({ message: 'Password reset link has been successfully sent to your email.' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });

    const passwordRegex = /^(?=.*[A-Z])(?=.*[0-9].*[0-9])(?=.*[!@#$%^&*_])(?=.{5,})/;
    if (!passwordRegex.test(password)) {
        return res.status(400).json({ error: 'Password needs 5+ chars, 1 uppercase, 2 numbers, 1 special char (including _).' });
    }

    try {
        const user = await db.prepare(`SELECT id FROM users WHERE reset_token = ? AND reset_token_expiry > datetime('now')`).get(token);
        if (!user) return res.status(400).json({ error: 'Invalid or expired reset token.' });

        const hash = await bcrypt.hash(password, 10);
        await db.prepare(`UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?`).run(hash, user.id);
        res.json({ message: 'Password reset successfully. You can now login.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: 'Could not log out.' });
        res.json({ message: 'Logout successful' });
    });
});

// POST /api/auth/request-security-code
router.post('/request-security-code', requireAuth, async (req, res) => {
    try {
        const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        await db.prepare('UPDATE users SET verification_token = ? WHERE id = ?').run(code, req.session.userId);
        try { await sendVerificationEmail(user.email, code); } catch (e) {
            console.error('Failed to send security code email:', e);
            return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
        }
        res.json({ message: 'Verification code sent to your email.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send verification code.' });
    }
});

// POST /api/auth/request-account-change
router.post('/request-account-change', requireAuth, async (req, res) => {
    const { type, data } = req.body;
    if (!type) return res.status(400).json({ error: 'Change type is required.' });

    try {
        const user = await db.prepare('SELECT email, username, id_verification_status FROM users WHERE id = ?').get(req.session.userId);
        
        if (type === 'remove_email' && !user.email) return res.status(400).json({ error: 'There is no email address to remove.' });
        if ((type === 'update_id' || type === 'remove_id') && user.id_verification_status !== 'verified') return res.status(400).json({ error: 'You do not have a verified ID to change.' });

        if (type === 'profile' && data) {
            if (data.username === user.username && data.email === user.email) return res.status(400).json({ error: 'No changes detected. Update cancelled.' });
            const role = (await db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId)).role;
            if (role === 'customer' && data.email && !data.email.endsWith('@gmail.com')) return res.status(400).json({ error: 'Kape Kanto Hub requires a valid @gmail.com address for customer accounts.' });
            if (role === 'admin' || role === 'staff') {
                await db.prepare('UPDATE users SET username = ? WHERE id = ?').run(data.username, req.session.userId);
                return res.json({ message: 'Profile updated successfully!', direct: true });
            }
        }

        if (type === 'password' && data) {
            const fullUser = await db.prepare('SELECT password FROM users WHERE id = ?').get(req.session.userId);
            const isSamePassword = await bcrypt.compare(data.new_password, fullUser.password);
            if (isSamePassword) return res.status(400).json({ error: 'New password cannot be the same as your current password.' });
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        req.session.pendingAccountChange = { type, data, code, expires: Date.now() + 600000 };

        try {
            await sendVerificationEmail(user.email, code);
            res.json({ message: 'A verification code has been sent to your email to confirm these changes.' });
        } catch (e) {
            console.error('Failed to send account change email:', e);
            return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/resend-change-code
router.post('/resend-change-code', requireAuth, async (req, res) => {
    const pending = req.session.pendingAccountChange;
    if (!pending) return res.status(400).json({ error: 'No active change request.' });
    try {
        const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
        await sendVerificationEmail(user.email, pending.code);
        res.json({ message: 'Security code resent successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to resend code.' });
    }
});

// POST /api/auth/confirm-account-change
router.post('/confirm-account-change', requireAuth, async (req, res) => {
    const { code } = req.body;
    const pending = req.session.pendingAccountChange;
    if (!pending || Date.now() > pending.expires) return res.status(400).json({ error: 'No active change request or code expired.' });
    if (code !== pending.code) return res.status(400).json({ error: 'Invalid verification code.' });

    try {
        if (pending.type === 'profile') {
            const { username, email } = pending.data;
            const updates = []; const params = [];
            if (username) { updates.push('username = ?'); params.push(username); }
            if (email) { updates.push('email = ?'); params.push(email); }
            params.push(req.session.userId);
            await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        } else if (pending.type === 'password') {
            const passwordRegex = /^(?=.*[A-Z])(?=.*[0-9].*[0-9])(?=.*[!@#$%^&*_])(?=.{5,})/;
            if (!passwordRegex.test(pending.data.new_password)) return res.status(400).json({ error: 'Password does not meet security requirements.' });
            const hash = await bcrypt.hash(pending.data.new_password, 10);
            await db.prepare(`UPDATE users SET password = ? WHERE id = ?`).run(hash, req.session.userId);
        } else if (pending.type === 'remove_email') {
            await db.prepare(`UPDATE users SET email = NULL, pending_email = NULL, is_verified = 0 WHERE id = ?`).run(req.session.userId);
        } else if (pending.type === 'remove_id') {
            await db.prepare(`UPDATE users SET senior_id_image = NULL, pwd_id_image = NULL, id_verification_status = 'none', id_verification_notes = NULL, id_verification_message = NULL, is_senior = 0, is_pwd = 0 WHERE id = ?`).run(req.session.userId);
        } else if (pending.type === 'update_id') {
            req.session.canUpdateID = true;
        } else if (pending.type === 'delete') {
            await db.prepare('DELETE FROM users WHERE id = ?').run(req.session.userId);
            req.session.destroy();
            return res.json({ message: 'Account deleted successfully.', deleted: true });
        }
        delete req.session.pendingAccountChange;
        res.json({ message: 'Changes applied successfully.' });
    } catch (error) {
        if (error.message && error.message.includes('UNIQUE constraint failed')) return res.status(400).json({ error: 'Username or email already in use.' });
        res.status(500).json({ error: 'Failed to apply changes.' });
    }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
    try {
        const user = await db.prepare(`SELECT id, username, email, role, is_senior, is_pwd, id_verification_status FROM users WHERE id = ?`).get(req.session.userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// PATCH /api/auth/update-profile
router.patch('/update-profile', requireAuth, async (req, res) => {
    const { email, username, code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code is required.' });

    const currentUser = await db.prepare('SELECT is_verified, role, email, verification_token FROM users WHERE id = ?').get(req.session.userId);
    if (code !== currentUser.verification_token) return res.status(400).json({ error: 'Invalid verification code.' });

    try {
        const updates = []; const params = [];
        let emailChanged = false; let newEmail = null;
        if (username) { updates.push('username = ?'); params.push(username); }
        if (email && email.trim().toLowerCase() !== currentUser.email) {
            newEmail = email.trim().toLowerCase();
            const existing = await db.prepare('SELECT id FROM users WHERE (email = ? OR pending_email = ?) AND id != ?').get(newEmail, newEmail, req.session.userId);
            if (existing) return res.status(400).json({ error: 'This email is already in use or has a pending verification.' });
            emailChanged = true;
            const newCode = Math.floor(100000 + Math.random() * 900000).toString();
            updates.push('pending_email = ?', 'verification_token = ?');
            params.push(newEmail, newCode);
        }
        if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });
        params.push(req.session.userId);
        const info = await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        if (info.changes === 0) return res.status(404).json({ error: 'User not found.' });

        if (emailChanged && newEmail) {
            const updatedUser = await db.prepare('SELECT verification_token FROM users WHERE id = ?').get(req.session.userId);
            try { await sendVerificationEmail(newEmail, updatedUser.verification_token); } catch (e) {
                console.error('Failed to send re-verification email:', e);
                return res.status(500).json({ error: 'Failed to send verification email to new email address. Profile update cancelled.' });
            }
            return res.json({ message: 'Update request received. Please verify your new email address to complete the change.', emailChanged: true, newEmail: newEmail, emailSent: true });
        }
        res.json({ message: 'Profile updated successfully.' });
    } catch (error) {
        if (error.message && error.message.includes('UNIQUE constraint failed')) return res.status(400).json({ error: 'Username or email already in use.' });
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

    const currentUser = await db.prepare('SELECT verification_token FROM users WHERE id = ?').get(req.session.userId);
    if (code !== currentUser.verification_token) return res.status(400).json({ error: 'Invalid verification code.' });

    try {
        const hash = await bcrypt.hash(new_password, 10);
        await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.session.userId);
        res.json({ message: 'Password updated successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/cancel-email-change
router.post('/cancel-email-change', requireAuth, async (req, res) => {
    try {
        await db.prepare('UPDATE users SET pending_email = NULL, verification_token = NULL WHERE id = ?').run(req.session.userId);
        res.json({ message: 'Email change request cancelled.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// DELETE /api/auth/delete-account
router.delete('/delete-account', requireAuth, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code is required.' });

    const user = await db.prepare('SELECT is_verified, role, verification_token, email FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (code !== user.verification_token) return res.status(400).json({ error: 'Invalid verification code.' });
    if (user.role === 'admin') return res.status(403).json({ error: 'Admins cannot delete their accounts here.' });

    try {
        const userEmail = user.email;
        await db.prepare('DELETE FROM users WHERE id = ?').run(req.session.userId);
        try { await sendAccountDeletedEmail(userEmail); } catch (e) { console.error('Failed to send account deletion email:', e); }
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
        const userId = parseInt(req.session.userId);
        const imageData = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        
        await db.prepare('UPDATE users SET profile_image = ? WHERE id = ?').run(imageData, userId);
        res.json({ message: 'Profile picture updated successfully!', image: imageData });
    } catch (error) {
        console.error('Update avatar error:', error);
        res.status(500).json({ error: 'Failed to update profile picture.' });
    }
});

module.exports = router;
