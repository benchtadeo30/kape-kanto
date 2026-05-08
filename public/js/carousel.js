document.addEventListener('DOMContentLoaded', () => {
    const slides = document.querySelectorAll('.carousel-slide');
    const dotsContainer = document.querySelector('.carousel-controls');
    
    if (!slides.length) return;

    let currentSlide = 0;
    const totalSlides = slides.length;
    let autoPlayInterval;

    // Create dots
    slides.forEach((_, index) => {
        const dot = document.createElement('div');
        dot.className = `carousel-dot ${index === 0 ? 'active' : ''}`;
        dot.addEventListener('click', () => goToSlide(index));
        dotsContainer.appendChild(dot);
    });

    const dots = document.querySelectorAll('.carousel-dot');

    function goToSlide(index) {
        slides[currentSlide].classList.remove('active');
        dots[currentSlide].classList.remove('active');
        
        currentSlide = index;
        
        slides[currentSlide].classList.add('active');
        dots[currentSlide].classList.add('active');
        
        resetAutoPlay();
    }

    function nextSlide() {
        let next = currentSlide + 1;
        if (next >= totalSlides) next = 0;
        goToSlide(next);
    }

    function startAutoPlay() {
        autoPlayInterval = setInterval(nextSlide, 5000);
    }

    function resetAutoPlay() {
        clearInterval(autoPlayInterval);
        startAutoPlay();
    }

    startAutoPlay();
});
