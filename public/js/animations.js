/* =====================================================
   KAPE KANTO HUB — Page Animations
   Intro screen (first visit / after auth events) + Scroll-reveal
   ===================================================== */

// ── INTRO SCREEN ──────────────────────────────────────
(function initIntro() {
    const intro = document.getElementById('kk-intro');
    if (!intro) return;

    const SESSION_KEY  = 'kk_visited';        // set after first intro plays
    const TRIGGER_KEY  = 'kk_show_intro';     // set by login / register / verify pages
    const INTRO_DURATION = 2800;

    const shouldShow =
        !sessionStorage.getItem(SESSION_KEY) ||   // first visit this session
        sessionStorage.getItem(TRIGGER_KEY) === '1'; // explicitly triggered

    if (!shouldShow) {
        // Skip intro — remove element immediately
        intro.style.display = 'none';
        return;
    }

    // Clear trigger flag so it only fires once
    sessionStorage.removeItem(TRIGGER_KEY);

    // Prevent body scroll during intro
    document.body.style.overflow = 'hidden';

    // Backup: Force exit intro if load event takes too long (e.g. 4.5s)
    const backupTimeout = setTimeout(() => {
        exitIntro();
    }, 4500);

    window.addEventListener('load', () => {
        setTimeout(exitIntro, INTRO_DURATION);
    });

    function exitIntro() {
        if (intro.classList.contains('intro--exit')) return;
        clearTimeout(backupTimeout);
        
        intro.classList.add('intro--exit');
        intro.addEventListener('transitionend', () => {
            intro.style.display = 'none';
            document.body.style.overflow = '';
        }, { once: true });
        
        // Fallback if transitionend doesn't fire
        setTimeout(() => {
            intro.style.display = 'none';
            document.body.style.overflow = '';
        }, 800);
    }

    // Mark this session as visited
    sessionStorage.setItem(SESSION_KEY, '1');
})();

// ── PUBLIC HELPER: call before redirecting to / ──────
window.KKIntro = {
    /** Set flag so the next home-page load shows the intro */
    trigger() {
        sessionStorage.setItem('kk_show_intro', '1');
    }
};

// ── SCROLL REVEAL ─────────────────────────────────────
(function initScrollReveal() {
    const THRESHOLD = 0.15;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('revealed');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: THRESHOLD });

    // Stagger-children: add .reveal to each child with delay
    document.querySelectorAll('.stagger-children').forEach(parent => {
        Array.from(parent.children).forEach((child, i) => {
            child.style.transitionDelay = `${i * 0.12}s`;
            child.classList.add('reveal');
            observer.observe(child);
        });
    });

    // Observe individual reveal elements
    document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale').forEach(el => {
        if (!el.classList.contains('revealed')) observer.observe(el);
    });
})();
