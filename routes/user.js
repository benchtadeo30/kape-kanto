const express = require('express');
const router = express.Router();
const { db } = require('../database/init');
const { requireRole } = require('../middleware/auth');
const bcrypt = require('bcrypt');
const { sendVerificationEmail } = require('../services/email');

// All routes here require Admin role
router.use(requireRole('admin'));

// GET /api/users
router.get('/', (req, res) => {
    const limit = parseInt(req.query.limit);
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search || '';

    try {
        let query = `SELECT id, username, email, role, created_at FROM users`;
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

        const users = db.prepare(query).all(...params);
        const total = db.prepare(countQuery).get(...countParams).total;

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

// GET /api/users/:id
router.get('/:id', (req, res) => {
    try {
        const user = db.prepare(`
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

    // Validation: Must be Gmail
    if (!email.endsWith('@gmail.com')) {
        return res.status(400).json({ error: 'Only Gmail addresses are allowed.' });
    }

    // Validation: Password Complexity (Same as registration)
    const passwordRegex = /^(?=.*[A-Z])(?=.*[0-9].*[0-9])(?=.*[!@#$%^&*])(?=.{5,})/;
    if (!passwordRegex.test(password)) {
        return res.status(400).json({ 
            error: 'Password needs 5+ chars, 1 uppercase, 2 numbers, 1 special char.' 
        });
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

        const stmt = db.prepare(`
            INSERT INTO users (username, email, password, role, is_senior, is_pwd, id_verification_status, verification_token, is_verified)
            VALUES (?, ?, ?, ?, 0, 0, 'none', ?, 0)
        `);
        const info = stmt.run(username, email, hash, role, verificationCode);

        // Send Verification Email
        try {
            await sendVerificationEmail(email, verificationCode);
        } catch (emailError) {
            console.error('Failed to send verification email for admin-created user:', emailError);
        }

        res.status(201).json({ message: 'User created. Verification email sent.', id: info.lastInsertRowid });
    } catch (error) {
        if (error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Username or email already exists.' });
        }
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// PUT /api/users/:id
router.put('/:id', async (req, res) => {
    const { username, email, role, is_senior, is_pwd, id_verification_status, password } = req.body;
    
    try {
        let stmt;
        let info;
        
        if (password) {
            const hash = await bcrypt.hash(password, 10);
            stmt = db.prepare(`
                UPDATE users 
                SET username=?, email=?, role=?, password=?
                WHERE id=?
            `);
            info = stmt.run(username, email, role, hash, req.params.id);
        } else {
            stmt = db.prepare(`
                UPDATE users 
                SET username=?, email=?, role=?
                WHERE id=?
            `);
            info = stmt.run(username, email, role, req.params.id);
        }

        if (info.changes === 0) return res.status(404).json({ error: 'User not found.' });
        res.json({ message: 'User updated.' });
    } catch (error) {
        if (error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Username or email already exists.' });
        }
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// DELETE /api/users/:id
router.delete('/:id', (req, res) => {
    // Prevent admin from deleting themselves
    if (req.params.id == req.session.userId) {
        return res.status(400).json({ error: 'Cannot delete your own account.' });
    }

    try {
        const info = db.prepare(`DELETE FROM users WHERE id=?`).run(req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'User not found.' });
        res.json({ message: 'User deleted.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

module.exports = router;
