require('dotenv').config();
const nodemailer = require('nodemailer');

function cleanCredential(val) {
    return (val || '').trim().replace(/\s+/g, '');
}

const emailUser = cleanCredential(process.env.EMAIL_USER);
const emailPass = cleanCredential(process.env.EMAIL_PASS);

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: emailUser,
        pass: emailPass
    }
});

const to = process.argv[2] || emailUser;

console.log(`Attempting to send test email to: ${to}`);
console.log(`Using sender: ${emailUser || 'MISSING EMAIL_USER'}`);

transporter.sendMail({
    from: emailUser,
    to,
    subject: 'Test Email from Kape Kanto',
    text: 'If you see this, your email configuration is working!'
}).then(info => {
    console.log('Email sent successfully:', info.response);
    process.exit(0);
}).catch(err => {
    console.error('Email failed:', err);
    process.exit(1);
});
