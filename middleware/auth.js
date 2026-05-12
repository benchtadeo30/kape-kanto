module.exports = {
    requireAuth: (req, res, next) => {
        if (!req.session.userId) {
            return res.status(401).json({ error: 'Unauthorized. Please log in.' });
        }
        next();
    },

    requireRole: (...roles) => {
        return async (req, res, next) => {
            if (!req.session.userId) {
                return res.status(401).json({ error: 'Unauthorized. Please log in.' });
            }

            // Fetch fresh user data to avoid stale session roles
            const { db } = require('../database/init');
            try {
                const user = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);

                if (!user || !roles.includes(user.role)) {
                    console.log(`[Auth Guard] Forbidden: User Role "${user ? user.role : 'none'}" not in allowed list [${roles.join(', ')}]`);
                    return res.status(403).json({ error: 'Forbidden. You do not have the required role.' });
                }
                
                // Sync session role just in case
                req.session.role = user.role;
                next();
            } catch (error) {
                console.error('[Auth Guard] Error fetching user:', error);
                return res.status(500).json({ error: 'Internal server error.' });
            }
        };
    }
};
