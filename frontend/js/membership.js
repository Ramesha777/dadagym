import { renderPlanCards, setupBillingToggle } from './plan-render.js';

var grid = document.getElementById('plansGrid');
var billingBtns = document.querySelectorAll('.ms-billing-btn');
var menuBtn = document.getElementById('menuToggle');
var navLinks = document.getElementById('navLinks');

var initialPeriod = (new URLSearchParams(window.location.search).get('period') === 'yearly')
    ? 'yearly'
    : 'monthly';

var period = initialPeriod;

setupBillingToggle(billingBtns, function(p) {
    period = p;
    renderPlanCards(grid, period);
}, initialPeriod);

renderPlanCards(grid, period);

/* ─── Mobile nav toggle ─── */
if (menuBtn && navLinks) {
    menuBtn.addEventListener('click', function() {
        navLinks.classList.toggle('open');
        menuBtn.classList.toggle('open');
    });
}
