const nodemailer = require('nodemailer');

// Helper to clean credentials copied from dashboards or Gmail app passwords.
function cleanCredential(val) {
    if (!val) return '';
    let cleaned = val.trim();
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        cleaned = cleaned.slice(1, -1);
    }
    return cleaned.replace(/\s+/g, '');
}

const EMAIL_USER = cleanCredential(process.env.EMAIL_USER);
const EMAIL_PASS = cleanCredential(process.env.EMAIL_PASS);
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'Kape Kanto Hub';

if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn('[EMAIL] WARNING: EMAIL_USER or EMAIL_PASS is not set');
}

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // use TLS
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
    }
});

function assertEmailConfigured() {
    if (!EMAIL_USER || !EMAIL_PASS) {
        const error = new Error('Email service is not configured. Set EMAIL_USER and EMAIL_PASS in Render environment variables.');
        error.code = 'EMAIL_CONFIG_MISSING';
        throw error;
    }
}

function logEmailError(context, email, error) {
    console.error(`[EMAIL ERROR] ${context} failed for ${email}:`, error.message || error);
    console.error('[EMAIL DEBUG]', {
        emailUserSet: Boolean(EMAIL_USER),
        emailPassSet: Boolean(EMAIL_PASS),
        emailPassLength: EMAIL_PASS ? EMAIL_PASS.length : 0,
        code: error.code,
        command: error.command,
        responseCode: error.responseCode
    });
}

/**
 * Sends a verification email to the user.
 * @param {string} email - The user's email address.
 * @param {string} code - The verification code.
 */
async function sendVerificationEmail(email, code) {
    assertEmailConfigured();
    console.log(`[EMAIL] Sending verification email to: ${email} from: ${EMAIL_USER}`);
    const mailOptions = {
        from: `"${EMAIL_FROM_NAME}" <${EMAIL_USER}>`,
        replyTo: EMAIL_USER,
        to: email,
        subject: 'Verify Your Email - Kape Kanto Hub',
        html: `
            <div style="font-family: 'Poppins', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h2 style="color: #6F4E37; text-align: center;">Welcome to Kape Kanto Hub!</h2>
                <p>Hello,</p>
                <p>Thank you for registering. Please use the following code to verify your email address:</p>
                <div style="text-align: center; margin: 30px 0;">
                    <span style="font-size: 2rem; font-weight: bold; letter-spacing: 5px; color: #6F4E37; background: #fdf5e6; padding: 10px 20px; border-radius: 5px; border: 1px dashed #6F4E37;">
                        ${code}
                    </span>
                </div>
                <p>This code will expire in 10 minutes.</p>
                <p>If you didn't create an account, please ignore this email.</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="font-size: 0.8rem; color: #888; text-align: center;">
                    &copy; 2026 Kape Kanto Hub. All rights reserved.
                </p>
            </div>
        `
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`Email sent successfully: ${info.messageId}`);
        return info;
    } catch (error) {
        logEmailError('Verification email', email, error);
        throw error;
    }
}

/**
 * Sends a password reset email.
 * @param {string} email - The user's email address.
 * @param {string} token - The reset token.
 */
async function sendResetPasswordEmail(email, token) {
    assertEmailConfigured();
    const resetUrl = `${(process.env.BASE_URL || 'http://localhost:3000').trim()}/reset-password?token=${token}`;
    console.log(`[EMAIL] Sending reset email to: ${email}`);
    const mailOptions = {
        from: `"${EMAIL_FROM_NAME}" <${EMAIL_USER}>`,
        replyTo: EMAIL_USER,
        to: email,
        subject: 'Reset Your Password - Kape Kanto Hub',
        html: `
            <div style="font-family: 'Poppins', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h2 style="color: #6F4E37; text-align: center;">Password Reset Request</h2>
                <p>Hello,</p>
                <p>We received a request to reset your password. Click the button below to set a new password:</p>
                <div style="text-align: center; margin: 30px 0;">
                    <a href="${resetUrl}" style="background-color: #6F4E37; color: white; padding: 12px 25px; text-decoration: none; border-radius: 50px; font-weight: bold; display: inline-block;">
                        Reset Password
                    </a>
                </div>
                <p>If you didn't request this, you can safely ignore this email.</p>
                <p>The link will expire in 1 hour.</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="font-size: 0.8rem; color: #888; text-align: center;">
                    &copy; 2026 Kape Kanto Hub. All rights reserved.
                </p>
            </div>
        `
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`Reset email sent successfully: ${info.messageId}`);
        return info;
    } catch (error) {
        logEmailError('Reset email', email, error);
        throw error;
    }
}

/**
 * Sends a notification that the account has been deleted.
 * @param {string} email - The user's email address.
 */
async function sendAccountDeletedEmail(email) {
    assertEmailConfigured();
    console.log(`[EMAIL] Sending account deletion notification to: ${email}`);
    const mailOptions = {
        from: `"${EMAIL_FROM_NAME}" <${EMAIL_USER}>`,
        replyTo: EMAIL_USER,
        to: email,
        subject: 'Account Deleted - Kape Kanto Hub',
        html: `
            <div style="font-family: 'Poppins', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h2 style="color: #6F4E37; text-align: center;">Account Deleted</h2>
                <p>Hello,</p>
                <p>Your Kape Kanto Hub account has been permanently deleted. We're sorry to see you go!</p>
                <p>If you did not request this deletion, please contact us immediately at <a href="mailto:benchrafael2@gmail.com">benchrafael2@gmail.com</a>.</p>
                <p>Thank you for being a part of Kape Kanto Hub.</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="font-size: 0.8rem; color: #888; text-align: center;">
                    &copy; 2026 Kape Kanto Hub. All rights reserved.
                </p>
            </div>
        `
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`Account deletion email sent: ${info.messageId}`);
        return info;
    } catch (error) {
        logEmailError('Account deletion email', email, error);
        throw error;
    }
}

module.exports = {
    sendVerificationEmail,
    sendResetPasswordEmail,
    sendAccountDeletedEmail
};
