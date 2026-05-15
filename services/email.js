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
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #fcfaf8; border-radius: 16px; overflow: hidden; border: 1px solid #e0d4c8;">
                <div style="background-color: #6F4E37; padding: 40px 20px; text-align: center;">
                    <h1 style="color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 2px;">KAPE KANTO HUB</h1>
                </div>
                <div style="padding: 40px; background-color: #ffffff;">
                    <h2 style="color: #2d2d2d; margin-top: 0; text-align: center;">Welcome to the Family!</h2>
                    <p style="color: #666; line-height: 1.6; text-align: center; font-size: 16px;">We're thrilled to have you here. To complete your registration and unlock your 20% lifetime discount (after ID verification), please use the verification code below:</p>
                    
                    <div style="text-align: center; margin: 40px 0;">
                        <div style="display: inline-block; background-color: #fdf5e6; padding: 20px 40px; border-radius: 12px; border: 2px dashed #6F4E37;">
                            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #6F4E37;">${code}</span>
                        </div>
                        <p style="color: #888; font-size: 13px; margin-top: 15px;">This code expires in 10 minutes.</p>
                    </div>

                    <p style="color: #666; line-height: 1.6; font-size: 14px;">If you did not create an account with us, you can safely ignore this email.</p>
                </div>
                <div style="background-color: #f3e9e0; padding: 25px; text-align: center; border-top: 1px solid #e0d4c8;">
                    <p style="color: #8c7b6d; font-size: 12px; margin: 0;">&copy; 2026 Kape Kanto Hub. 123 Coffee St., Metro Manila, Philippines</p>
                </div>
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
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #fcfaf8; border-radius: 16px; overflow: hidden; border: 1px solid #e0d4c8;">
                <div style="background-color: #6F4E37; padding: 40px 20px; text-align: center;">
                    <h1 style="color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 2px;">KAPE KANTO HUB</h1>
                </div>
                <div style="padding: 40px; background-color: #ffffff;">
                    <h2 style="color: #2d2d2d; margin-top: 0;">Password Reset Request</h2>
                    <p style="color: #666; line-height: 1.6; font-size: 16px;">We received a request to reset your password. No worries, it happens! Click the button below to secure your account with a new password:</p>
                    
                    <div style="text-align: center; margin: 40px 0;">
                        <a href="${resetUrl}" style="background-color: #6F4E37; color: #ffffff; padding: 15px 35px; text-decoration: none; border-radius: 50px; font-weight: bold; display: inline-block; font-size: 16px; box-shadow: 0 4px 10px rgba(111, 78, 55, 0.3);">Reset My Password</a>
                        <p style="color: #888; font-size: 13px; margin-top: 15px;">This link expires in 1 hour.</p>
                    </div>

                    <p style="color: #666; line-height: 1.6; font-size: 14px;">If you didn't request this change, you can safely ignore this email. Your password will remain unchanged.</p>
                </div>
                <div style="background-color: #f3e9e0; padding: 25px; text-align: center; border-top: 1px solid #e0d4c8;">
                    <p style="color: #8c7b6d; font-size: 12px; margin: 0;">&copy; 2026 Kape Kanto Hub. All rights reserved.</p>
                </div>
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
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #fcfaf8; border-radius: 16px; overflow: hidden; border: 1px solid #e0d4c8;">
                <div style="background-color: #6F4E37; padding: 40px 20px; text-align: center;">
                    <h1 style="color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 2px;">KAPE KANTO HUB</h1>
                </div>
                <div style="padding: 40px; background-color: #ffffff;">
                    <h2 style="color: #2d2d2d; margin-top: 0;">Account Deactivation</h2>
                    <p style="color: #666; line-height: 1.6; font-size: 16px;">This is a confirmation that your Kape Kanto Hub account has been permanently deleted as requested. We're sorry to see you go!</p>
                    
                    <div style="background-color: #fef1f1; padding: 20px; border-radius: 12px; border: 1px solid #fadbd8; margin: 30px 0;">
                        <p style="margin: 0; color: #c0392b; font-size: 14px; line-height: 1.5;"><strong>Important:</strong> All your data, including order history and loyalty progress, has been removed from our active systems.</p>
                    </div>

                    <p style="color: #666; line-height: 1.6; font-size: 14px;">If you did not request this deletion, please contact our security team immediately at <a href="mailto:benchrafael2@gmail.com" style="color: #6F4E37; text-decoration: none; font-weight: 600;">benchrafael2@gmail.com</a>.</p>
                </div>
                <div style="background-color: #f3e9e0; padding: 25px; text-align: center; border-top: 1px solid #e0d4c8;">
                    <p style="color: #8c7b6d; font-size: 12px; margin: 0;">&copy; 2026 Kape Kanto Hub. Thank you for the memories.</p>
                </div>
            </div>
        `
    };

    return sendMailWithFallback(mailOptions, 'Account deletion email', email);
}

/**
 * Sends contact form feedback to the administrator.
 */
async function sendContactFeedbackEmail(name, email, subject, message) {
    assertEmailConfigured();
    const timestamp = new Date().toLocaleString('en-US', { 
        timeZone: 'Asia/Manila',
        dateStyle: 'full',
        timeStyle: 'long'
    });

    console.log(`[EMAIL] Sending contact feedback from ${email} to admin`);
    const mailOptions = {
        from: `"${EMAIL_FROM_NAME} Support" <${EMAIL_USER}>`,
        replyTo: email,
        to: EMAIL_USER,
        subject: `[FEEDBACK] ${subject} - ${name}`,
        html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #fcfaf8; border-radius: 16px; overflow: hidden; border: 1px solid #e0d4c8; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <!-- Header -->
                <div style="background-color: #6F4E37; padding: 30px; text-align: center;">
                    <h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 1px;">KAPE KANTO HUB</h1>
                    <p style="color: #d2b48c; margin: 5px 0 0; font-size: 14px; text-transform: uppercase;">Customer Feedback Center</p>
                </div>
                
                <!-- Body -->
                <div style="padding: 30px; background-color: #ffffff;">
                    <div style="margin-bottom: 25px; border-bottom: 2px solid #f3e9e0; padding-bottom: 15px;">
                        <h2 style="color: #2d2d2d; margin: 0 0 10px; font-size: 18px;">New Message Received</h2>
                        <p style="color: #666; font-size: 14px; margin: 0;">Submitted on ${timestamp}</p>
                    </div>

                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;">
                        <tr>
                            <td style="padding: 8px 0; color: #888; font-size: 13px; width: 100px;">Customer:</td>
                            <td style="padding: 8px 0; color: #2d2d2d; font-weight: 600; font-size: 15px;">${name}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #888; font-size: 13px;">Email:</td>
                            <td style="padding: 8px 0;"><a href="mailto:${email}" style="color: #6F4E37; text-decoration: none; font-weight: 600;">${email}</a></td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #888; font-size: 13px;">Subject:</td>
                            <td style="padding: 8px 0; color: #2d2d2d; font-weight: 600; font-size: 15px;">${subject.toUpperCase()}</td>
                        </tr>
                    </table>

                    <div style="background-color: #faf7f4; padding: 20px; border-radius: 12px; border-left: 4px solid #6F4E37;">
                        <p style="margin: 0; color: #4a4a4a; line-height: 1.6; white-space: pre-wrap; font-style: italic;">"${message}"</p>
                    </div>

                    <div style="margin-top: 30px; text-align: center;">
                        <a href="mailto:${email}?subject=RE: ${subject}" style="background-color: #6F4E37; color: #ffffff; padding: 12px 25px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 14px;">Reply to Customer</a>
                    </div>
                </div>

                <!-- Footer -->
                <div style="background-color: #f3e9e0; padding: 20px; text-align: center;">
                    <p style="color: #8c7b6d; font-size: 12px; margin: 0;">This is an automated notification from your website's contact form.</p>
                    <p style="color: #8c7b6d; font-size: 12px; margin: 5px 0 0;">&copy; 2026 Kape Kanto Hub System</p>
                </div>
            </div>
        `
    };

    return sendMailWithFallback(mailOptions, 'Contact feedback email', EMAIL_USER);
}

module.exports = {
    sendVerificationEmail,
    sendResetPasswordEmail,
    sendAccountDeletedEmail,
    sendContactFeedbackEmail
};
