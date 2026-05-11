const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { db } = require('../database/init');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { verifyIdCard } = require('../services/gemini');
const { sendVerificationEmail, sendResetPasswordEmail, sendAccountDeletedEmail } = require('../services/email');
const fs = require('fs');
const path = require('path');

// Debug Routes
router.get('/ping', (req, res) => res.json({ message: 'Auth router is active' }));
router.post('/test-post', (req, res) => res.json({ message: 'POST to Auth router is working' }));

// POST /api/auth/register
router.post('/register', upload.single('profile_image'), async (req, res) => {
    const { username, email: rawEmail, password } = req.body;
    const email = rawEmail ? rawEmail.trim().toLowerCase() : rawEmail;

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are required.' });
    }

    // Domain Validation: Only @gmail.com allowed for customers
    if (!email.endsWith('@gmail.com')) {
        return res.status(400).json({ error: 'Kape Kanto Hub requires a valid @gmail.com address for customer accounts.' });
    }

    // Password Complexity Validation
    const passwordRegex = /^(?=.*[A-Z])(?=.*[0-9].*[0-9])(?=.*[!@#$%^&*_])(?=.{5,})/;
    if (!passwordRegex.test(password)) {
        return res.status(400).json({ 
            error: 'Password needs 5+ chars, 1 uppercase, 2 numbers, 1 special char (including _).' 
        });
    }

    try {
        // Check uniqueness on main users table (Email only)
        const existingUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
        if (existingUser) {
            return res.status(400).json({ error: 'This email address is already registered.' });
        }

        const hash = await bcrypt.hash(password, 10);
        
        // Generate verification code
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

        const profileImage = req.file ? req.file.filename : null;

        // Store in pending_users instead of users
        // We use REPLACE to allow users to retry registration if they made a mistake or didn't get the code
        db.prepare(`
            INSERT OR REPLACE INTO pending_users (username, email, password, profile_image, verification_token)
            VALUES (?, ?, ?, ?, ?)
        `).run(username, email, hash, profileImage, verificationCode);
        
        // Send Verification Email
        try {
            await sendVerificationEmail(email, verificationCode);
        } catch (emailError) {
            console.error('Failed to send verification email:', emailError);
            if (emailError.code === 'EMAIL_CONFIG_MISSING') {
                return res.status(500).json({ error: 'Email service is not configured on the server. Please contact support.' });
            }
            return res.status(500).json({ error: 'Registration failed to send verification email. Please try again.' });
        }

        res.status(201).json({ 
            message: 'Registration data saved. Please verify your email to complete registration.', 
            email: email,
            unverified: true
        });
    } catch (error) {
        if (req.file) {
            try { fs.unlinkSync(req.file.path); } catch(e) {}
        }
        
        if (error.message.includes('UNIQUE constraint failed')) {
            if (error.message.includes('users.email')) {
                return res.status(400).json({ error: 'This email address is already registered.' });
            }
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

        // 1. Check existing users
        const user = db.prepare(`SELECT id, is_verified, pending_email FROM users WHERE email = ? OR pending_email = ?`).get(email, email);
        if (user) {
            db.prepare(`UPDATE users SET verification_token = ? WHERE id = ?`).run(newCode, user.id);
            await sendVerificationEmail(email, newCode);
            return res.json({ message: 'New verification code sent.' });
        }

        // 2. Check pending_users
        const pending = db.prepare(`SELECT id FROM pending_users WHERE email = ?`).get(email);
        if (pending) {
            db.prepare(`UPDATE pending_users SET verification_token = ? WHERE id = ?`).run(newCode, pending.id);
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
router.post('/verify-email', (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });

    try {
        // 1. Check if email change/re-verification for existing user
        let user = db.prepare(`SELECT id, email, pending_email, role FROM users WHERE (email = ? OR pending_email = ?) AND verification_token = ?`).get(email, email, code);
        
        if (user) {
            if (user.pending_email === email) {
                db.prepare(`UPDATE users SET email = ?, pending_email = NULL, is_verified = 1, verification_token = NULL WHERE id = ?`).run(email, user.id);
            } else {
                db.prepare(`UPDATE users SET is_verified = 1, verification_token = NULL WHERE id = ?`).run(user.id);
            }
        } else {
            // 2. Check pending_users (New Registration)
            const pending = db.prepare(`SELECT * FROM pending_users WHERE email = ? AND verification_token = ?`).get(email, code);
            if (!pending) return res.status(400).json({ error: 'Invalid verification code.' });

            // Final check: did someone take the email in the meantime?
            const conflict = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
            if (conflict) {
                db.prepare('DELETE FROM pending_users WHERE id = ?').run(pending.id);
                return res.status(400).json({ error: 'This email address was taken while you were verifying. Please register again.' });
            }

            // Move to main users table
            const info = db.prepare(`
                INSERT INTO users (username, email, password, role, profile_image, is_verified)
                VALUES (?, ?, ?, 'customer', ?, 1)
            `).run(pending.username, pending.email, pending.password, pending.profile_image);

            user = { id: info.lastInsertRowid, role: 'customer' };
            db.prepare('DELETE FROM pending_users WHERE id = ?').run(pending.id);
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
        req.session.role = user.role;
        req.session.isVerifiedInSession = true; // Mark as verified for this session

        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.json({ message: 'Email verified successfully.' });
        });
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
        // Support login by either email or username
        const identifier = email.trim();
        const user = db.prepare(`
            SELECT * FROM users 
            WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)
        `).get(identifier, identifier);

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        req.session.userId = user.id;
        req.session.role = user.role;
        // Admin and Staff do not need to verify email every session
        req.session.isVerifiedInSession = (user.role === 'admin' || user.role === 'staff'); 

        req.session.save(async (err) => {
            if (err) console.error('Session save error:', err);

            if (user.role === 'customer') {
                // For customers, ensure they are NOT marked verified until they enter code
                req.session.isVerifiedInSession = false;
                
                // AUTO-SEND CODE ON LOGIN EVERY TIME
                try {
                    const newCode = Math.floor(100000 + Math.random() * 900000).toString();
                    db.prepare(`UPDATE users SET verification_token = ? WHERE id = ?`).run(newCode, user.id);
                    await sendVerificationEmail(user.email, newCode);
                    console.log(`[AUTH] Auto-sent mandatory verification code to ${user.email} on login.`);
                } catch (emailErr) {
                    console.error('[AUTH ERROR] Failed to auto-send mandatory verification code on login:', emailErr);
                }

                return res.json({ 
                    message: 'Login successful. A security verification code has been sent to your email.',
                    role: user.role,
                    unverified: true, // Frontend will redirect to /verify-email
                    email: user.email
                });
            }

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
        const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.trim().toLowerCase());
        if (!user) {
            return res.status(404).json({ error: 'User with this email not found.' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 3600000).toISOString(); // 1 hour

        db.prepare(`UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?`).run(token, expiry, user.id);

        try {
            await sendResetPasswordEmail(email, token);
        } catch (e) {
            console.error('Reset email error:', e);
            // Explicitly return error to user if email fails to send
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

    // Password Complexity Validation
    const passwordRegex = /^(?=.*[A-Z])(?=.*[0-9].*[0-9])(?=.*[!@#$%^&*_])(?=.{5,})/;
    if (!passwordRegex.test(password)) {
        return res.status(400).json({ 
            error: 'Password needs 5+ chars, 1 uppercase, 2 numbers, 1 special char (including _).' 
        });
    }

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
        
        try {
            await sendVerificationEmail(user.email, code);
        } catch (e) {
            console.error('Failed to send security code email:', e);
            // Explicitly return error to user if email fails to send
            return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
        }
        res.json({ message: 'Verification code sent to your email.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send verification code.' });
    }
});

// POST /api/auth/request-account-change
router.post('/request-account-change', requireAuth, async (req, res) => {
    const { type, data } = req.body; // type: 'profile', 'password', 'delete', 'remove_email', 'update_id', 'remove_id'
    
    if (!type) return res.status(400).json({ error: 'Change type is required.' });

    try {
        const user = db.prepare('SELECT email, username, id_verification_status FROM users WHERE id = ?').get(req.session.userId);
        
        if (type === 'remove_email' && !user.email) {
            return res.status(400).json({ error: 'There is no email address to remove.' });
        }

        if ((type === 'update_id' || type === 'remove_id') && user.id_verification_status !== 'verified') {
            return res.status(400).json({ error: 'You do not have a verified ID to change.' });
        }

        if (type === 'profile' && data) {
            if (data.username === user.username && data.email === user.email) {
                return res.status(400).json({ error: 'No changes detected. Update cancelled.' });
            }

            // Domain Validation for customers
            const role = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId).role;
            if (role === 'customer' && data.email && !data.email.endsWith('@gmail.com')) {
                return res.status(400).json({ error: 'Kape Kanto Hub requires a valid @gmail.com address for customer accounts.' });
            }

            // Direct update for Admin/Staff (Internal domain)
            if (role === 'admin' || role === 'staff') {
                db.prepare('UPDATE users SET username = ? WHERE id = ?').run(data.username, req.session.userId);
                return res.json({ message: 'Profile updated successfully!', direct: true });
            }
        }

        if (type === 'password' && data) {
            const fullUser = db.prepare('SELECT password FROM users WHERE id = ?').get(req.session.userId);
            const isSamePassword = await bcrypt.compare(data.new_password, fullUser.password);
            if (isSamePassword) {
                return res.status(400).json({ error: 'New password cannot be the same as your current password.' });
            }
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        // Stage the changes in the session
        req.session.pendingAccountChange = {
            type,
            data,
            code,
            expires: Date.now() + 600000 // 10 minutes
        };

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
        const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
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

    if (!pending || Date.now() > pending.expires) {
        return res.status(400).json({ error: 'No active change request or code expired.' });
    }

    if (code !== pending.code) {
        return res.status(400).json({ error: 'Invalid verification code.' });
    }

    try {
        if (pending.type === 'profile') {
            const { username, email } = pending.data;
            const updates = [];
            const params = [];
            if (username) { updates.push('username = ?'); params.push(username); }
            if (email) { updates.push('email = ?'); params.push(email); }
            params.push(req.session.userId);
            db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        } else if (pending.type === 'password') {
            const { new_password } = pending.data;
            
            // Re-validate complexity on backend
            const passwordRegex = /^(?=.*[A-Z])(?=.*[0-9].*[0-9])(?=.*[!@#$%^&*_])(?=.{5,})/;
            if (!passwordRegex.test(new_password)) {
                return res.status(400).json({ error: 'Password does not meet security requirements.' });
            }

            const hash = await bcrypt.hash(new_password, 10);
            db.prepare(`UPDATE users SET password = ? WHERE id = ?`).run(hash, req.session.userId);
        } else if (pending.type === 'remove_email') {
            db.prepare(`UPDATE users SET email = NULL, pending_email = NULL, is_verified = 0 WHERE id = ?`).run(req.session.userId);
        } else if (pending.type === 'remove_id') {
            db.prepare(`
                UPDATE users 
                SET senior_id_image = NULL, 
                    pwd_id_image = NULL, 
                    id_verification_status = 'none',
                    id_verification_notes = NULL,
                    id_verification_message = NULL,
                    is_senior = 0,
                    is_pwd = 0
                WHERE id = ?
            `).run(req.session.userId);
        } else if (pending.type === 'update_id') {
            req.session.canUpdateID = true;
        } else if (pending.type === 'delete') {
            db.prepare('DELETE FROM users WHERE id = ?').run(req.session.userId);
            req.session.destroy();
            return res.json({ message: 'Account deleted successfully.', deleted: true });
        }

        delete req.session.pendingAccountChange;
        res.json({ message: 'Changes applied successfully.' });
    } catch (error) {
        if (error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Username or email already in use.' });
        }
        res.status(500).json({ error: 'Failed to apply changes.' });
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
            const updatedUser = db.prepare('SELECT verification_token FROM users WHERE id = ?').get(req.session.userId);
            try {
                await sendVerificationEmail(newEmail, updatedUser.verification_token);
            } catch (e) {
                console.error('Failed to send re-verification email:', e);
                // Explicitly return error to user if email fails to send
                return res.status(500).json({ error: 'Failed to send verification email to new email address. Profile update cancelled.' });
            }
            return res.json({ 
                message: 'Update request received. Please verify your new email address to complete the change.',
                emailChanged: true,
                newEmail: newEmail,
                emailSent: true
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
router.delete('/delete-account', requireAuth, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code is required.' });

    const user = db.prepare('SELECT is_verified, role, verification_token, email FROM users WHERE id = ?').get(req.session.userId);
    
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (code !== user.verification_token) {
        return res.status(400).json({ error: 'Invalid verification code.' });
    }

    if (user.role === 'admin') {
        return res.status(403).json({ error: 'Admins cannot delete their accounts here.' });
    }

    try {
        const userEmail = user.email;

        db.prepare('DELETE FROM users WHERE id = ?').run(req.session.userId);

        try {
            await sendAccountDeletedEmail(userEmail);
        } catch (e) {
            console.error('Failed to send account deletion email:', e);
        }

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
        const user = db.prepare('SELECT profile_image FROM users WHERE id = ?').get(userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        // Delete old image if it exists
        if (user.profile_image) {
            const oldPath = path.join(__dirname, '..', 'public', 'uploads', 'profiles', user.profile_image);
            if (fs.existsSync(oldPath)) {
                try {
                    fs.unlinkSync(oldPath);
                } catch (e) {
                    console.error('Failed to delete old avatar:', e);
                }
            }
        }

        db.prepare('UPDATE users SET profile_image = ? WHERE id = ?').run(req.file.filename, userId);
        res.json({ message: 'Profile picture updated successfully!', filename: req.file.filename });
    } catch (error) {
        console.error('Update avatar error:', error);
        res.status(500).json({ error: 'Failed to update profile picture.' });
    }
});
module.exports = router;
