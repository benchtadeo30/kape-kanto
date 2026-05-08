const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directories exist
const uploadDirs = ['menu', 'promos', 'ids', 'profiles'].map(dir => path.join(__dirname, '..', 'public', 'uploads', dir));
uploadDirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        let folder = 'menu';
        if (req.originalUrl.includes('promos')) {
            folder = 'promos';
        } else if (req.originalUrl.includes('verify') || req.originalUrl.includes('auth')) {
            folder = req.originalUrl.includes('update-avatar') || req.originalUrl.includes('register') ? 'profiles' : 'ids';
        }
        cb(null, path.join(__dirname, '..', 'public', 'uploads', folder));
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only JPEG, PNG and WEBP are allowed.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

module.exports = upload;
