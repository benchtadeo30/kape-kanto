let lastActivityTime = Date.now();

function trackActivity() {
    lastActivityTime = Date.now();
    console.log(`[ACTIVITY] Global database change registered at: ${lastActivityTime}`);
}

function getActivityTime() {
    return lastActivityTime;
}

module.exports = {
    trackActivity,
    getActivityTime
};
