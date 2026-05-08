require('dotenv').config();
const { db } = require('./database/init');
const nodemailer = require('./node_modules/nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Generate a fresh code for the user
const email = process.argv[2] || 'tadeorafael41@gmail.com';
const newCode = Math.floor(100000 + Math.random() * 900000).toString();

// Update in DB
const result = db.prepare('UPDATE users SET verification_token = ? WHERE email = ?').run(newCode, email);

if (result.changes === 0) {
    console.error('No user found with email:', email);
    process.exit(1);
}

console.log('Updated verification code for', email, '=> CODE:', newCode);

transporter.sendMail({
    from: `"Kape Kanto Hub" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Verify Your Email - Kape Kanto Hub',
    html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:30px;border:1px solid #eee;border-radius:10px;">
            <h2 style="color:#6F4E37;text-align:center;">☕ Kape Kanto Hub</h2>
            <p>Your email verification code:</p>
            <div style="text-align:center;margin:25px 0;">
                <span style="font-size:2.5rem;font-weight:bold;letter-spacing:8px;color:#6F4E37;background:#fdf5e6;padding:12px 24px;border-radius:8px;border:2px dashed #6F4E37;">${newCode}</span>
            </div>
            <p>This code expires in 10 minutes.</p>
        </div>
    `
}).then(r => {
    console.log('Verification email sent! MessageId:', r.messageId);
    process.exit(0);
}).catch(e => {
    console.error('Email failed:', e.message);
    process.exit(1);
});
