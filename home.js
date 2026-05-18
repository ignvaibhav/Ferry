// Scroll-triggered fade-in for sections
const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if(e.isIntersecting) {
      e.target.style.opacity = '1';
      e.target.style.transform = 'translateY(0)';
    }
  });
}, {threshold: 0.1});

document.querySelectorAll('.problem-card, .feature-card, .flow-step, .install-step').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(20px)';
  el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
  observer.observe(el);
});

// Stagger feature cards
document.querySelectorAll('.feature-card').forEach((el, i) => {
  el.style.transitionDelay = (i * 0.07) + 's';
});
document.querySelectorAll('.problem-card').forEach((el, i) => {
  el.style.transitionDelay = (i * 0.1) + 's';
});