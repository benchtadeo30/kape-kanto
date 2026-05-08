require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'kapekantohub@gmail.com',
        pass: 'gxvf agxn yldo ughg'
    }
});

console.log('Attempting to send test email to: tadeorafael41@gmail.com');
console.log('Using sender: tadeorafael41@gmail.com');

transporter.sendMail({
    from: 'tadeorafael41@gmail.com',
    to: 'tadeorafael41@gmail.com',
    subject: 'Test Email from Kape Kanto',
    text: 'If you see this, your email configuration is working!'
}).then(info => {
    console.log('Email sent successfully:', info.response);
    process.exit(0);
}).catch(err => {
    console.error('Email failed:', err);
    process.exit(1);
});
