const bcrypt = require('bcrypt');
const { db, initDb } = require('../database/init');

const [role, email, password, usernameArg] = process.argv.slice(2);
const allowedRoles = new Set(['customer', 'admin', 'staff']);

async function main() {
    if (!allowedRoles.has(role) || !email || !password) {
        console.error('Usage: node scripts/create-user.js <customer|admin|staff> <email> <password> [username]');
        process.exit(1);
    }

    initDb();

    const normalizedEmail = email.trim().toLowerCase();
    const username = usernameArg || normalizedEmail.split('@')[0];
    const hash = await bcrypt.hash(password, 10);
    const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(normalizedEmail);

    if (existing) {
        db.prepare(`
            UPDATE users
            SET username = ?, password = ?, role = ?, is_verified = 1
            WHERE id = ?
        `).run(username, hash, role, existing.id);
        console.log(`Updated ${role} user: ${normalizedEmail}`);
        return;
    }

    db.prepare(`
        INSERT INTO users (username, email, password, role, is_verified, id_verification_status)
        VALUES (?, ?, ?, ?, 1, 'none')
    `).run(username, normalizedEmail, hash, role);

    console.log(`Created ${role} user: ${normalizedEmail}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
