const nodemailer = require('nodemailer');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');

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
const MAILJET_API_KEY = cleanCredential(process.env.MAILJET_API_KEY);
const MAILJET_SECRET_KEY = cleanCredential(process.env.MAILJET_SECRET_KEY);
const MAILJET_FROM = process.env.MAILJET_FROM || process.env.EMAIL_FROM;

if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn('[EMAIL] WARNING: EMAIL_USER or EMAIL_PASS is not set');
} else {
    console.log('[EMAIL] Config loaded', {
        emailUserSet: true,
        emailPassLength: EMAIL_PASS.length
    });
}

if (MAILJET_API_KEY && MAILJET_SECRET_KEY) {
    console.log('[EMAIL] Mailjet API provider enabled');
}

const transportConfigs = [
    { name: 'gmail-starttls-587', port: 587, secure: false },
    { name: 'gmail-ssl-465', port: 465, secure: true }
];

function createTransport(config) {
    return nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: config.port,
        secure: config.secure,
        family: 4,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
        }
    });
}

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
        mailjetApiKeySet: Boolean(MAILJET_API_KEY),
        provider: error.provider,
        transport: error.transport,
        code: error.code,
        command: error.command,
        responseCode: error.responseCode
    });
}

function parseEmailAddress(value) {
    const fallback = { email: EMAIL_USER, name: EMAIL_FROM_NAME };
    if (!value) return fallback;

    const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
    if (match) {
        return {
            name: match[1].replace(/^"|"$/g, '').trim() || EMAIL_FROM_NAME,
            email: match[2].trim()
        };
    }

    return {
        email: value.trim(),
        name: EMAIL_FROM_NAME
    };
}

async function sendMailWithMailjet(mailOptions, context, email) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const from = parseEmailAddress(MAILJET_FROM || mailOptions.from);
    const auth = Buffer.from(`${MAILJET_API_KEY}:${MAILJET_SECRET_KEY}`).toString('base64');

    try {
        const response = await fetch('https://api.mailjet.com/v3.1/send', {
            method: 'POST',
            headers: {
                Authorization: `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                Messages: [
                    {
                        From: {
                            Email: from.email,
                            Name: from.name
                        },
                        To: [
                            {
                                Email: email
                            }
                        ],
                        Subject: mailOptions.subject,
                        HTMLPart: mailOptions.html
                    }
                ]
            }),
            signal: controller.signal
        });

        const payload = await response.json().catch(() => ({}));
        const message = payload.Messages && payload.Messages[0];

        if (!response.ok || (message && message.Status === 'error')) {
            const apiError = message && message.Errors && message.Errors[0];
            const error = new Error(
                (apiError && (apiError.ErrorMessage || apiError.ErrorIdentifier)) ||
                payload.ErrorMessage ||
                `Mailjet API failed with status ${response.status}`
            );
            error.code = 'EMAIL_API_FAILED';
            error.provider = 'mailjet';
            error.responseCode = response.status;
            throw error;
        }

        console.log(`[EMAIL] ${context} sent via mailjet: ${message && message.To && message.To[0] ? message.To[0].MessageID : 'queued'}`);
        return payload;
    } finally {
        clearTimeout(timeout);
    }
}

async function sendMailWithFallback(mailOptions, context, email) {
    let lastError;

    if (MAILJET_API_KEY && MAILJET_SECRET_KEY) {
        try {
            console.log(`[EMAIL] Trying mailjet API for ${email}`);
            return await sendMailWithMailjet(mailOptions, context, email);
        } catch (error) {
            lastError = error;
            logEmailError(`${context} via mailjet`, email, error);

            if (error.responseCode === 401 || error.responseCode === 403 || error.responseCode === 422) {
                throw error;
            }
        }
    }

    for (const config of transportConfigs) {
        try {
            console.log(`[EMAIL] Trying ${config.name} for ${email}`);
            const info = await createTransport(config).sendMail(mailOptions);
            console.log(`[EMAIL] ${context} sent via ${config.name}: ${info.messageId}`);
            return info;
        } catch (error) {
            error.transport = config.name;
            lastError = error;
            logEmailError(`${context} via ${config.name}`, email, error);

            if (error.code === 'EAUTH' || error.responseCode === 535) {
                throw error;
            }
        }
    }

    throw lastError;
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

    return sendMailWithFallback(mailOptions, 'Verification email', email);
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

    return sendMailWithFallback(mailOptions, 'Reset email', email);
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

    return sendMailWithFallback(mailOptions, 'Account deletion email', email);
}

module.exports = {
    sendVerificationEmail,
    sendResetPasswordEmail,
    sendAccountDeletedEmail
};
