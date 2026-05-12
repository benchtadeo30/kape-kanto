const express = require('express');
const router = express.Router();
const { db } = require('../database/init');
const { requireRole } = require('../middleware/auth');
const bcrypt = require('bcrypt');
const { sendVerificationEmail } = require('../services/email');

// All routes here require Admin role
router.use(requireRole('admin'));

// GET /api/users
router.get('/', async (req, res) => {
    const limit = parseInt(req.query.limit);
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search || '';

    try {
        let query = `SELECT id, username, email, role, created_at, profile_image FROM users`;
        let countQuery = `SELECT COUNT(*) as total FROM users`;
        const params = [];
        const countParams = [];

        if (search) {
            const whereClause = ` WHERE username LIKE ? OR email LIKE ?`;
            query += whereClause;
            countQuery += whereClause;
            const searchVal = `%${search}%`;
            params.push(searchVal, searchVal);
            countParams.push(searchVal, searchVal);
        }

        if (!isNaN(limit)) {
            query += ` LIMIT ? OFFSET ?`;
            params.push(limit, offset);
        }

        const users = await db.prepare(query).all(...params);
        const total = (await db.prepare(countQuery).get(...countParams)).total;

        if (!isNaN(limit)) {
            res.json({ items: users, total });
        } else {
            res.json(users);
        }
    } catch (error) {
        console.error('User list error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// ── ID Verification Admin Endpoints (must be before /:id) ───────────

// GET /api/users/id-verifications/pending
router.get('/id-verifications/pending', async (req, res) => {
    const limit = parseInt(req.query.limit) || 5;
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search || '';

    try {
        let baseQuery = `FROM users WHERE id_verification_status IN ('pending', 'resubmit')`;
        const params = [];

        if (search) {
            baseQuery += ` AND (id_number LIKE ? OR username LIKE ? OR email LIKE ?)`;
            const searchVal = `%${search}%`;
            params.push(searchVal, searchVal, searchVal);
        }

        const countQuery = `SELECT COUNT(*) as total ${baseQuery}`;
        const total = (await db.prepare(countQuery).get(...params)).total;

        const selectQuery = `
            SELECT id, username, email, is_senior, is_pwd, 
                   senior_id_image, pwd_id_image, selfie_image, id_number,
                   id_verification_status, id_verification_message, id_verification_notes,
                   created_at
            ${baseQuery}
            ORDER BY 
                CASE WHEN id_verification_status = 'pending' THEN 0 ELSE 1 END,
                created_at DESC
            LIMIT ? OFFSET ?
        `;
        
        const pending = await db.prepare(selectQuery).all(...params, limit, offset);

        // Check for duplicate ID numbers
        for (const user of pending) {
            if (user.id_number) {
                const dup = await db.prepare(`
                    SELECT id, username FROM users 
                    WHERE id_number = ? AND id != ? AND id_verification_status = 'verified'
                `).get(user.id_number, user.id);
                user.duplicate_warning = dup ? `This ID number is already used by ${dup.username} (ID: ${dup.id})` : null;
            }
        }

        res.json({ items: pending, total });
    } catch (error) {
        console.error('Pending verifications error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// GET /api/users/:id
router.get('/:id', async (req, res) => {
    try {
        const user = await db.prepare(`
            SELECT id, username, email, role, created_at 
            FROM users WHERE id = ?
        `).get(req.params.id);
        
        if (!user) return res.status(404).json({ error: 'User not found.' });
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/users
router.post('/', async (req, res) => {
    const { username, email: rawEmail, password, role } = req.body;
    const email = rawEmail ? rawEmail.trim().toLowerCase() : rawEmail;
    
    if (!username || !email || !password || !role) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }

    if (role === 'customer' && !email.endsWith('@gmail.com')) {
        return res.status(400).json({ error: 'Customer accounts require a valid @gmail.com address.' });
    }
    if (role !== 'customer' && !email.endsWith('@kapekantohub.com')) {
        return res.status(400).json({ error: 'Internal accounts (Admin/Staff) must use @kapekantohub.com.' });
    }

    const passwordRegex = /^(?=.*[A-Z])(?=.*[0-9].*[0-9])(?=.*[!@#$%^&*_])(?=.{5,})/;
    if (!passwordRegex.test(password)) {
        return res.status(400).json({ 
            error: 'Password needs 5+ chars, 1 uppercase, 2 numbers, 1 special char (including _).' 
        });
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

        const info = await db.prepare(`
            INSERT INTO users (username, email, password, role, is_senior, is_pwd, id_verification_status, verification_token, is_verified)
            VALUES (?, ?, ?, ?, 0, 0, 'none', ?, 0)
        `).run(username, email, hash, role, verificationCode);

        try {
            await sendVerificationEmail(email, verificationCode);
        } catch (emailError) {
            console.error('Failed to send verification email for admin-created user:', emailError);
        }

        res.status(201).json({ message: 'User created. Verification email sent.', id: info.lastInsertRowid });
    } catch (error) {
        if (error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'This email address is already in use.' });
        }
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// PUT /api/users/:id
router.put('/:id', async (req, res) => {
    const { username, email: rawEmail, role, is_senior, is_pwd, id_verification_status, password } = req.body;
    const email = rawEmail ? rawEmail.trim().toLowerCase() : rawEmail;

    if (email) {
        if (role === 'customer' && !email.endsWith('@gmail.com')) {
            return res.status(400).json({ error: 'Customer accounts require a valid @gmail.com address.' });
        }
        if (role !== 'customer' && !email.endsWith('@kapekantohub.com')) {
            return res.status(400).json({ error: 'Internal accounts (Admin/Staff) must use @kapekantohub.com.' });
        }
    }
    
    try {
        let info;
        
        if (password) {
            const hash = await bcrypt.hash(password, 10);
            info = await db.prepare(`
                UPDATE users 
                SET username=?, email=?, role=?, password=?
                WHERE id=?
            `).run(username, email, role, hash, req.params.id);
        } else {
            info = await db.prepare(`
                UPDATE users 
                SET username=?, email=?, role=?
                WHERE id=?
            `).run(username, email, role, req.params.id);
        }

        if (info.changes === 0) return res.status(404).json({ error: 'User not found.' });
        res.json({ message: 'User updated.' });
    } catch (error) {
        if (error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'This email address is already in use.' });
        }
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// DELETE /api/users/:id
router.delete('/:id', async (req, res) => {
    if (req.params.id == req.session.userId) {
        return res.status(400).json({ error: 'Cannot delete your own account.' });
    }

    try {
        const info = await db.prepare(`DELETE FROM users WHERE id=?`).run(req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'User not found.' });
        res.json({ message: 'User deleted.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// ── ID Verification Admin Actions ───────────────────────────────────────

// POST /api/users/:id/approve-id
router.post('/:id/approve-id', async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const adminId = req.session.userId;

        const user = await db.prepare(`
            SELECT id, id_number, id_verification_notes, senior_id_image, pwd_id_image
            FROM users WHERE id = ?
        `).get(userId);

        if (!user) return res.status(404).json({ error: 'User not found.' });

        // Determine ID type from notes or uploaded images
        let notes = {};
        try { notes = JSON.parse(user.id_verification_notes || '{}'); } catch(e) {}
        const idType = notes.id_type || (user.senior_id_image ? 'senior' : 'pwd');

        // Check for duplicate ID number one final time
        if (user.id_number) {
            const dup = await db.prepare(`
                SELECT id FROM users 
                WHERE id_number = ? AND id != ? AND id_verification_status = 'verified'
            `).get(user.id_number, userId);
            if (dup) {
                return res.status(400).json({ error: 'Cannot approve: this ID number is already verified on another account.' });
            }
        }

        const isSenior = idType === 'senior' ? 1 : 0;
        const isPwd = idType === 'pwd' ? 1 : 0;
        const now = new Date().toISOString();

        await db.prepare(`
            UPDATE users 
            SET id_verification_status = 'verified',
                id_verification_message = 'Your ID has been verified by our team. You now enjoy a 20% discount!',
                is_senior = ?,
                is_pwd = ?,
                verified_by = ?,
                verified_at = ?
            WHERE id = ?
        `).run(isSenior, isPwd, adminId, now, userId);

        console.log(`[ID Verification] Admin ${adminId} APPROVED user ${userId} as ${idType}`);
        res.json({ message: `User verified as ${idType === 'senior' ? 'Senior Citizen' : 'PWD'} successfully.` });
    } catch (error) {
        console.error('Approve ID error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/users/:id/reject-id
router.post('/:id/reject-id', async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const { reason } = req.body;

        const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        await db.prepare(`
            UPDATE users 
            SET id_verification_status = 'rejected',
                id_verification_message = ?,
                is_senior = 0,
                is_pwd = 0,
                verified_by = NULL,
                verified_at = NULL
            WHERE id = ?
        `).run(reason || 'Your ID verification was rejected. Please contact support for more details.', userId);

        console.log(`[ID Verification] Admin ${req.session.userId} REJECTED user ${userId}`);
        res.json({ message: 'User ID verification rejected.' });
    } catch (error) {
        console.error('Reject ID error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/users/:id/resubmit-id
router.post('/:id/resubmit-id', async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const { reason } = req.body;

        const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        await db.prepare(`
            UPDATE users 
            SET id_verification_status = 'rejected',
                id_verification_message = ?,
                senior_id_image = NULL,
                pwd_id_image = NULL,
                selfie_image = NULL
            WHERE id = ?
        `).run(reason || 'Please resubmit clearer photos of your ID and selfie.', userId);

        console.log(`[ID Verification] Admin ${req.session.userId} requested RESUBMISSION from user ${userId}`);
        res.json({ message: 'Resubmission request sent to user.' });
    } catch (error) {
        console.error('Resubmit ID error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

module.exports = router;

