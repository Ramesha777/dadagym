import { firebaseConfig } from './firebase-config.js';
import { isMemberPlanActive } from './membership-utils.js';
import { getPlan } from './plans.js';
import { ensureGymPublicId, isValidGymPublicId } from './gym-public-id.js';
import { openIDCardModal } from './IDCard.js';
firebase.initializeApp(firebaseConfig);

var auth = firebase.auth();
var db   = firebase.firestore();
var $ = function(id) { return document.getElementById(id); };

var currentUid = null;
var currentUser = null;
var memberData = null;

function refreshMemberGymPublicIdUi(gymPid) {
    var side = $('sidebarGymPublicId');
    if (side) {
        if (gymPid && isValidGymPublicId(gymPid)) {
            side.textContent = 'Member ID · ' + gymPid;
            side.classList.remove('d-none');
        } else {
            side.textContent = '';
            side.classList.add('d-none');
        }
    }
    var heroBlk = $('profileHeroPublicIdBlock');
    var heroCode = $('profileHeroMemberId');
    if (heroBlk && heroCode) {
        if (gymPid && isValidGymPublicId(gymPid)) {
            heroBlk.classList.remove('is-pending');
            heroCode.textContent = gymPid;
        } else {
            heroBlk.classList.add('is-pending');
            heroCode.textContent = 'Assigning\u2026';
        }
        heroBlk.classList.remove('d-none');
        heroBlk.hidden = false;
    }
    var profRo = $('memberGymPublicId');
    if (profRo)
        profRo.value = gymPid && isValidGymPublicId(gymPid) ? gymPid : '';
}

function runEnsureMemberGymPublicId(email) {
    if (!currentUid || !email) return;
    ensureGymPublicId(db, currentUid, email, 'member')
        .then(function(pid) {
            if (!pid || !memberData) return;
            memberData.gymPublicId = pid;
            refreshMemberGymPublicIdUi(pid);
        })
        .catch(function(err) {
            console.warn('Gym public ID:', err && err.message ? err.message : err);
        });
}

/**
 * Without membership: one active class booking at a time; after trainer starts session (completed), no more until they buy a plan.
 */
function evaluateClassBookingGate(memberDoc, bookingsSnap) {
    if (isMemberPlanActive(memberDoc)) return { ok: true, reason: '' };

    var completed = 0;
    var confirmed = 0;
    bookingsSnap.forEach(function(doc) {
        var b = doc.data();
        if ((b.status || '').trim() === 'cancelled') return;
        if (b.sessionStarted === true) completed++;
        if ((b.status || '').trim() === 'confirmed') confirmed++;
    });
    if (completed >= 1) {
        return {
            ok: false,
            reason: 'You\'ve completed your complimentary session. Purchase a membership to book more classes.'
        };
    }
    if (confirmed >= 1) {
        return {
            ok: false,
            reason: 'Without a membership you can hold one active booking at a time. Cancel it or purchase a membership for unlimited bookings.'
        };
    }
    return { ok: true, reason: '' };
}

/* ═══════════════════════════════════════
   AUTH GATE
   ═══════════════════════════════════════ */
auth.onAuthStateChanged(function(user) {
    if (!user || !user.emailVerified) {
        window.location.href = 'login.html';
        return;
    }
    currentUid = user.uid;
    currentUser = user;

    db.collection('users').doc(user.uid).get().then(function(uDoc) {
        if (uDoc.exists) {
            var role = uDoc.data().role;
            if (role === 'admin')   { window.location.href = 'admin.html'; return; }
            if (role === 'trainer') { window.location.href = 'trainer.html'; return; }
        }
        return db.collection('members').doc(user.uid).get();
    }).then(function(doc) {
        if (doc === undefined) return;
        memberData = doc.exists ? doc.data() : {};
        showDashboard(user);
        runEnsureMemberGymPublicId(user.email || '');
    }).catch(function() { window.location.href = 'login.html'; });
});

/** Sidebar footer: show member name (not raw email). */
function syncMemberSidebarFooterName(user) {
    var el = $('userEmail');
    if (!el || !user) return;
    var nm =
        memberData &&
        typeof memberData.displayName === 'string' &&
        memberData.displayName.trim()
            ? memberData.displayName.trim()
            : '';
    if (!nm && user.displayName && String(user.displayName).trim()) {
        nm = String(user.displayName).trim();
    }
    if (!nm && user.email && user.email.indexOf('@') > 0) {
        nm = user.email.split('@')[0];
    }
    if (!nm) nm = 'Member';
    el.textContent = nm;
    if (user.email) el.title = user.email;
    else el.removeAttribute('title');
}

function showDashboard(user) {
    $('loadingGate').style.display = 'none';
    $('mainContent').style.display = 'block';
    syncMemberSidebarFooterName(user);
    refreshMemberGymPublicIdUi(
        memberData && memberData.gymPublicId && isValidGymPublicId(memberData.gymPublicId)
            ? memberData.gymPublicId
            : ''
    );
    loadProfile();
    loadClasses();
}

function doMemberLogout() {
    auth.signOut().then(function() {
        window.location.href = 'login.html';
    });
}

if ($('btnLogout')) {
    $('btnLogout').addEventListener('click', function() {
        var modalEl = $('logoutConfirmModal');
        if (!modalEl || typeof bootstrap === 'undefined') {
            if (window.confirm('Are you sure you want to log out?')) doMemberLogout();
            return;
        }
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
    });
}
if ($('btnLogoutConfirm')) {
    $('btnLogoutConfirm').addEventListener('click', function() {
        var modalEl = $('logoutConfirmModal');
        if (modalEl && typeof bootstrap !== 'undefined') {
            var inst = bootstrap.Modal.getInstance(modalEl);
            if (inst) inst.hide();
        }
        doMemberLogout();
    });
}

/* ═══════════════════════════════════════
   SIDEBAR NAVIGATION
   ═══════════════════════════════════════ */
var sidebarLinks = document.querySelectorAll('.sidebar-nav a[data-section]');
var sections = document.querySelectorAll('.member-section');
var titles = {
    profile:  '<i class="fas fa-user me-2"></i>My Profile',
    membership: '<i class="fas fa-id-card-alt me-2"></i>Membership',
    classes:  '<i class="fas fa-dumbbell me-2"></i>Available Classes',
    trainers: '<i class="fas fa-chalkboard-teacher me-2"></i>Our Trainers',
    bookings: '<i class="fas fa-calendar-check me-2"></i>My Bookings'
};

sidebarLinks.forEach(function(link) {
    link.addEventListener('click', function(e) {
        e.preventDefault();
        switchSection(this.getAttribute('data-section'));
        closeSidebar();
    });
});

function switchSection(name) {
    sidebarLinks.forEach(function(a) { a.classList.remove('active'); });
    sections.forEach(function(s) { s.classList.remove('active'); });
    var lnk = document.querySelector('[data-section="' + name + '"]');
    if (lnk) lnk.classList.add('active');
    var sec = $('sec-' + name);
    if (sec) sec.classList.add('active');
    $('topbarTitle').innerHTML = titles[name] || name;

    if (name === 'classes')  loadClasses();
    if (name === 'trainers') loadTrainers();
    if (name === 'bookings') loadBookings();
    if (name === 'membership') loadMembership();
}

var sidebar = $('sidebar');
var overlay = $('sidebarOverlay');
$('menuToggle').addEventListener('click', function() { sidebar.classList.add('open'); overlay.classList.add('open'); });
function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('open'); }
$('sidebarClose').addEventListener('click', closeSidebar);
overlay.addEventListener('click', closeSidebar);

/* ═══════════════════════════════════════
   PROFILE
   ═══════════════════════════════════════ */
function getInitials(name, fallback) {
    var src = (name && String(name).trim()) || fallback || '';
    if (!src) return '?';
    return src.split(/\s+/).map(function(w) { return w[0]; }).join('').substring(0, 2).toUpperCase();
}

function renderProfileAvatar(name, email, photoURL) {
    var box = $('profileAvatar');
    var initEl = $('profileAvatarInitials');
    if (!box || !initEl) return;
    var initials = getInitials(name, email);
    initEl.textContent = initials;
    var existing = box.querySelector('img');
    if (existing) existing.remove();
    if (photoURL && /^https?:\/\//i.test(photoURL)) {
        var img = document.createElement('img');
        img.alt = name || 'Profile photo';
        img.src = photoURL;
        initEl.style.display = 'none';
        img.onerror = function() {
            img.remove();
            initEl.style.display = '';
        };
        box.appendChild(img);
    } else {
        initEl.style.display = '';
    }
}

function loadProfile() {
    if (!currentUid) return;
    db.collection('members').doc(currentUid).get().then(function(doc) {
        if (!doc.exists) {
            if ($('profileStatus')) $('profileStatus').innerHTML = '';
            $('profEmail').value = currentUser.email;
            if ($('profileHeroEmail')) $('profileHeroEmail').textContent = currentUser.email;
            if ($('profileHeroName')) $('profileHeroName').textContent = 'New member';
            renderProfileAvatar('', currentUser.email, '');
            refreshMemberGymPublicIdUi(null);
            syncMemberSidebarFooterName(currentUser);
            return;
        }
        var d = doc.data();
        memberData = d;
        $('profName').value    = d.displayName || '';
        $('profEmail').value   = d.email || currentUser.email;
        $('profPhone').value   = d.phone || '';
        $('profAddress').value = d.address || '';
        if ($('profPhotoURL')) $('profPhotoURL').value = d.photoURL || '';

        if ($('profileHeroName')) $('profileHeroName').textContent = d.displayName || 'Member';
        if ($('profileHeroEmail')) $('profileHeroEmail').textContent = d.email || currentUser.email || '';
        renderProfileAvatar(d.displayName, d.email || currentUser.email, d.photoURL);

        var planLabel = d.plan || '—';
        if (d.planPeriod) planLabel += ' (' + (d.planPeriod === 'yearly' ? 'Yearly' : 'Monthly') + ')';
        var planBadge = '';
        var access = isMemberPlanActive(d);
        if (access && d.cancelAtPeriodEnd) {
            planBadge = ' <span class="badge bg-warning text-dark ms-2">Active · not renewing</span>';
        } else if (access) {
            planBadge = ' <span class="badge bg-success ms-2">Active</span>';
        } else if (d.planStatus === 'expired') {
            planBadge = ' <span class="badge bg-secondary ms-2">Expired</span>';
        } else if (d.planId) {
            planBadge = ' <span class="badge bg-secondary ms-2">Inactive</span>';
        }
        $('profPlan').innerHTML = planLabel + planBadge;
        if ($('profileStatus')) $('profileStatus').innerHTML = '';
        refreshMemberGymPublicIdUi(
            memberData.gymPublicId && isValidGymPublicId(memberData.gymPublicId) ? memberData.gymPublicId : ''
        );
        syncMemberSidebarFooterName(currentUser);
        if (!(memberData.gymPublicId && isValidGymPublicId(memberData.gymPublicId)) && currentUser && currentUser.email) {
            runEnsureMemberGymPublicId(currentUser.email);
        }
    });
}

$('profileForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var data = {
        displayName: $('profName').value.trim(),
        email: currentUser.email,
        phone: $('profPhone').value.trim(),
        address: $('profAddress').value.trim(),
        photoURL: ($('profPhotoURL') ? $('profPhotoURL').value.trim() : '')
    };
    db.collection('members').doc(currentUid).get().then(function(doc) {
        if (doc.exists) {
            return db.collection('members').doc(currentUid).update(data);
        } else {
            data.plan = 'Basic';
            data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            return db.collection('members').doc(currentUid).set(data);
        }
    }).then(function() {
        showAlert($('profileAlert'), 'Profile saved!', 'success');
        loadProfile();
    }).catch(function(err) { showAlert($('profileAlert'), err.message, 'danger'); });
});

/** Line shown on digital ID card (matches dashboard membership wording). */
function formatMemberIdCardMembershipStatus(d) {
    if (!d || !d.planId) return 'No active membership';
    var planLabel = (d.plan && String(d.plan).trim()) || 'Membership';
    if (d.planPeriod) planLabel += ' · ' + (d.planPeriod === 'yearly' ? 'Yearly' : 'Monthly');
    var access = isMemberPlanActive(d);
    if (access && d.cancelAtPeriodEnd) return planLabel + ' — Active · not renewing';
    if (access) return planLabel + ' — Active';
    if (d.planStatus === 'expired') return planLabel + ' — Expired';
    return planLabel + ' — Inactive';
}

var btnGenerateIdCard = $('btnGenerateIdCard');
if (btnGenerateIdCard) {
    btnGenerateIdCard.addEventListener('click', function() {
        if (!currentUser) return;
        var d = memberData || {};
        var nm =
            (d.displayName && String(d.displayName).trim()) ||
            (currentUser.displayName && String(currentUser.displayName).trim()) ||
            '';
        if (!nm && currentUser.email) nm = currentUser.email.split('@')[0];
        if (!nm) nm = 'Member';
        var pid =
            d.gymPublicId && isValidGymPublicId(d.gymPublicId) ? d.gymPublicId : '';
        openIDCardModal({
            name: nm,
            role: 'member',
            joinDate: d.createdAt || null,
            photoURL: (d.photoURL && String(d.photoURL).trim()) || (currentUser.photoURL || '') || '',
            firebaseUid: currentUser.uid,
            gymPublicId: pid,
            phone: (d.phone && String(d.phone).trim()) || '',
            membershipStatus: formatMemberIdCardMembershipStatus(d),
            gymLocation: 'RA1 2SU, 7 Krishal Road',
            gymWebsiteUrl: 'https://dadagym.netlify.app',
            gymWebsiteLabel: 'dadagym.netlify.app'
        });
    });
}

var photoInput = $('profPhotoURL');
if (photoInput) {
    photoInput.addEventListener('input', function() {
        renderProfileAvatar(
            $('profName').value || (memberData && memberData.displayName),
            currentUser ? currentUser.email : '',
            photoInput.value.trim()
        );
    });
}

function showAlert(el, msg, type) {
    el.className = 'alert alert-' + type;
    el.textContent = msg;
    el.classList.remove('d-none');
    setTimeout(function() { el.classList.add('d-none'); }, 4000);
}

/** Safe HTML text */
function escapeHtml(s) {
    if (s == null || s === '') return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
}

/** Embed in single-quoted JS string (e.g. onclick args) */
function escapeJsString(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Safe URL for img[src] when scheme is http(s) */
function escapeAttrUrl(u) {
    if (!u || typeof u !== 'string') return '';
    var t = u.trim();
    if (!/^https?:\/\//i.test(t)) return '';
    return t.replace(/"/g, '&quot;').replace(/</g, '');
}

function memberCurrencySym(code) {
    if (code === 'GBP') return '\u00A3';
    if (code === 'USD') return '$';
    if (code === 'EUR') return '\u20AC';
    return '';
}

function formatMemberTs(ts) {
    if (!ts || typeof ts.toDate !== 'function') return '\u2014';
    return ts.toDate().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatMemberDateOnly(ts) {
    if (!ts || typeof ts.toDate !== 'function') return '\u2014';
    return ts.toDate().toLocaleDateString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function formatMembershipStatusHtml(d) {
    if (!d || !d.planId) return '<span class="badge bg-secondary">No plan</span>';
    if (isMemberPlanActive(d)) {
        if (d.cancelAtPeriodEnd === true) {
            return '<span class="badge bg-warning text-dark">Active &middot; not renewing</span>';
        }
        return '<span class="badge bg-success">Active</span>';
    }
    if (d.planStatus === 'expired') return '<span class="badge bg-secondary">Expired</span>';
    if (d.planStatus === 'cancelled') return '<span class="badge bg-secondary">Ended</span>';
    return '<span class="badge bg-secondary">Inactive</span>';
}

function memberAppendLedgerEntry(type, extra) {
    var base = {
        memberId: currentUid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        type: type,
        planId: (memberData && memberData.planId) || '',
        planName: (memberData && memberData.plan) || '',
        period: (memberData && memberData.planPeriod) || ''
    };
    return db.collection('members').doc(currentUid).collection('membershipPurchases').add(
        Object.assign(base, extra || {})
    );
}

/** Latest pending payout request per origin (credit vs refund owing); refreshed in loadMembership. */
var memberRefundPendingByOrigin = { credit: null, refund: null };

function applyPendingRefundRequests(pendSnap) {
    memberRefundPendingByOrigin = { credit: null, refund: null };
    if (!pendSnap || pendSnap.empty) return;
    var rows = [];
    pendSnap.forEach(function(doc) {
        rows.push({ id: doc.id, d: doc.data() });
    });
    rows.sort(function(a, b) {
        var ta =
            a.d.createdAt && typeof a.d.createdAt.toMillis === 'function'
                ? a.d.createdAt.toMillis()
                : 0;
        var tb =
            b.d.createdAt && typeof b.d.createdAt.toMillis === 'function'
                ? b.d.createdAt.toMillis()
                : 0;
        return tb - ta;
    });
    rows.forEach(function(row) {
        var o = row.d.requestOrigin === 'refund' ? 'refund' : 'credit';
        if (memberRefundPendingByOrigin[o]) return;
        var amt =
            typeof row.d.amount === 'number' && !isNaN(row.d.amount) ? row.d.amount : null;
        memberRefundPendingByOrigin[o] = {
            id: row.id,
            amount: amt,
            currency: row.d.currency || 'GBP'
        };
    });
}

function pendingPayoutBlockedMessage(sym, pend) {
    if (!pend || typeof pend.amount !== 'number') {
        return 'You already have a payout request awaiting staff review.';
    }
    return (
        'Already requested ' +
        sym +
        pend.amount.toFixed(2) +
        ' — waiting for staff to review.'
    );
}

function syncMembershipPayoutButtons(d) {
    var cr = $('btnRequestCreditPayout');
    var rr = $('btnRequestRefundOwed');
    var noteC = $('membCreditPayoutPending');
    var noteR = $('membRefundOwedPending');
    var sym = memberCurrencySym(d.planCurrency || 'GBP');
    var creditVal = typeof d.planCredit === 'number' ? Math.max(0, d.planCredit) : 0;
    var refVal = typeof d.lastRefundAmount === 'number' ? Math.max(0, d.lastRefundAmount) : 0;

    var pendC = memberRefundPendingByOrigin.credit;
    var pendR = memberRefundPendingByOrigin.refund;

    if (cr) cr.disabled = creditVal <= 0 || !!pendC;
    if (rr) rr.disabled = refVal <= 0 || !!pendR;

    if (noteC) {
        if (pendC) {
            noteC.classList.remove('d-none');
            noteC.textContent = pendingPayoutBlockedMessage(sym, pendC);
        } else {
            noteC.classList.add('d-none');
            noteC.textContent = '';
        }
    }
    if (noteR) {
        if (pendR) {
            noteR.classList.remove('d-none');
            noteR.textContent = pendingPayoutBlockedMessage(sym, pendR);
        } else {
            noteR.classList.add('d-none');
            noteR.textContent = '';
        }
    }
}

/** Pending account deletion request (member); refreshed in loadMembership. */
var pendingAccountDeletionDoc = null;
var accountDeletionPickModalInstance = null;
var accountDeletionConfirmModalInstance = null;
var accountDeletionChosenType = null;

function applyPendingAccountDeletionSnap(delSnap) {
    pendingAccountDeletionDoc = null;
    if (!delSnap || delSnap.empty) return;
    var rows = [];
    delSnap.forEach(function(doc) {
        rows.push({ id: doc.id, d: doc.data() });
    });
    rows.sort(function(a, b) {
        var ta =
            a.d.createdAt && typeof a.d.createdAt.toMillis === 'function'
                ? a.d.createdAt.toMillis()
                : 0;
        var tb =
            b.d.createdAt && typeof b.d.createdAt.toMillis === 'function'
                ? b.d.createdAt.toMillis()
                : 0;
        return tb - ta;
    });
    pendingAccountDeletionDoc = rows[0] || null;
}

function canWithdrawAccountDeletion(rd) {
    if (!rd || (rd.status || '') !== 'pending') return false;
    if ((rd.requestType || '') !== 'permanent') return true;
    var cd = rd.cancelDeadlineAt;
    if (!cd || typeof cd.toMillis !== 'function') return false;
    try {
        return Date.now() < cd.toMillis();
    } catch (e) {
        return false;
    }
}

function formatMemberDateTimeLocal(ts) {
    if (!ts || typeof ts.toDate !== 'function') return '\u2014';
    try {
        return ts.toDate().toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
        });
    } catch (e) {
        return '\u2014';
    }
}

function syncAccountDeletionBannerAndButton() {
    var box = $('membAccountDeletionBanner');
    var body = $('membAccountDeletionBannerBody');
    var btnW = $('btnWithdrawAccountDeletion');
    var btnDel = $('btnDeleteAccount');
    if (!box || !body) return;

    if (!pendingAccountDeletionDoc || (pendingAccountDeletionDoc.d.status || '') !== 'pending') {
        box.classList.add('d-none');
        box.classList.remove('memb-acct-del-banner--perm', 'memb-acct-del-banner--temp');
        body.textContent = '';
        if (btnW) {
            btnW.classList.add('d-none');
            btnW.disabled = false;
        }
        if (btnDel) btnDel.disabled = false;
        return;
    }

    var rd = pendingAccountDeletionDoc.d;
    var kind = (rd.requestType || '') === 'permanent' ? 'permanent' : 'temporary';

    box.classList.remove('memb-acct-del-banner--perm', 'memb-acct-del-banner--temp');
    box.classList.add(kind === 'permanent' ? 'memb-acct-del-banner--perm' : 'memb-acct-del-banner--temp');
    box.classList.remove('d-none');

    body.textContent = '';

    if (kind === 'permanent') {
        var p1 = document.createElement('p');
        p1.className = 'mb-2';
        p1.textContent =
            'You asked for permanent deletion. Account will be deleted 24 hours after you submitted—once staff process it. Until then, you can still sign in unless staff act earlier.';
        body.appendChild(p1);
        var cd = rd.cancelDeadlineAt;
        if (cd && typeof cd.toDate === 'function') {
            var p2 = document.createElement('p');
            p2.className = 'mb-2';
            p2.textContent =
                'You may withdraw this request on the dashboard until ' +
                formatMemberDateTimeLocal(cd) +
                ' (about 20 hours from when you submitted). After that deadline, contact DaDaGym urgently if this was a mistake.';
            body.appendChild(p2);
        }
        var de = rd.deletionEligibleAfterAt;
        if (de && typeof de.toDate === 'function') {
            var p3 = document.createElement('p');
            p3.className = 'mb-0';
            p3.textContent =
                'From ' +
                formatMemberDateTimeLocal(de) +
                ' on your timeline, staff may treat the account as cleared for removal.';
            body.appendChild(p3);
        }
    } else {
        var pq = document.createElement('p');
        pq.className = 'mb-0';
        pq.textContent =
            'You requested a temporary removal. Staff may deactivate or restrict your access; contact DaDaGym if you need the account reopened.';
        body.appendChild(pq);
    }

    var canW = canWithdrawAccountDeletion(rd);
    if (btnW) {
        btnW.classList.toggle('d-none', !canW);
        btnW.disabled = false;
    }
    if (btnDel) btnDel.disabled = true;
}

function getAccountDeletionPickModal() {
    var el = $('accountDeletePickModal');
    if (!el || !window.bootstrap) return null;
    if (typeof bootstrap.Modal.getOrCreateInstance === 'function') {
        accountDeletionPickModalInstance = bootstrap.Modal.getOrCreateInstance(el);
    } else if (!accountDeletionPickModalInstance && window.bootstrap && bootstrap.Modal) {
        accountDeletionPickModalInstance = new bootstrap.Modal(el);
    }
    return accountDeletionPickModalInstance;
}

function getAccountDeletionConfirmModal() {
    var el = $('accountDeleteConfirmModal');
    if (!el || !window.bootstrap) return null;
    if (typeof bootstrap.Modal.getOrCreateInstance === 'function') {
        accountDeletionConfirmModalInstance = bootstrap.Modal.getOrCreateInstance(el);
    } else if (!accountDeletionConfirmModalInstance && window.bootstrap && bootstrap.Modal) {
        accountDeletionConfirmModalInstance = new bootstrap.Modal(el);
    }
    return accountDeletionConfirmModalInstance;
}

function openAccountDeletionConfirmForType(t) {
    accountDeletionChosenType = t;
    var pk = getAccountDeletionPickModal();
    var cm = getAccountDeletionConfirmModal();
    if (pk) pk.hide();
    var title = $('accountDeleteConfirmTitleText');
    var explained = $('accountDeleteConfirmExplained');
    var ack = $('accountDeleteAcknowledged');
    var sub = $('accountDeleteSubmitRequest');
    if (ack) {
        ack.checked = false;
    }
    if (sub) sub.disabled = true;
    if (t === 'permanent') {
        if (title) title.textContent = 'Permanent deletion request';
        if (explained) {
            explained.innerHTML =
                 
                '<p class="mb-2 fw-semibold text-warning">Deletion is intended about 24 hours after you submit. During the first <strong>~20 hours</strong> you may withdraw below; after that, contact staff urgently if needed.</p>';
        }
    } else {
        if (title) title.textContent = 'Temporary account removal';
        if (explained) {
            explained.innerHTML =
                '<p class="mb-0">You are asking DaDaGym staff to deactivate or temporarily close access. Recovery may be possible later by contacting DaDaGym.</p>';
        }
    }
    if (cm) cm.show();
}

function submitMemberAccountDeletionRequest() {
    if (!currentUid || !currentUser || !memberData || !accountDeletionChosenType) return;
    var sub = $('accountDeleteSubmitRequest');
    if (!$('accountDeleteAcknowledged') || !$('accountDeleteAcknowledged').checked) return;
    if (sub) sub.disabled = true;

    db.collection('accountDeletionRequests')
        .where('memberId', '==', currentUid)
        .where('status', '==', 'pending')
        .get()
        .then(function(snap) {
            if (snap && !snap.empty) {
                closeAccountDeletionConfirmModal();
                showAlert(
                    $('membershipAlert'),
                    'You already have a pending account request. Withdraw it first or wait for staff.',
                    'info'
                );
                loadMembership();
                return Promise.resolve(null);
            }
            var nowMs = Date.now();
            var MS_20H = 20 * 60 * 60 * 1000;
            var MS_24H = 24 * 60 * 60 * 1000;
            var basePayload = {
                memberId: currentUid,
                memberEmail: currentUser.email || '',
                memberName:
                    typeof memberData.displayName === 'string' && memberData.displayName.trim()
                        ? memberData.displayName.trim()
                        : '',
                notes: '',
                requestType: accountDeletionChosenType,
                status: 'pending',
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            if (accountDeletionChosenType === 'permanent') {
                basePayload.cancelDeadlineAt = firebase.firestore.Timestamp.fromMillis(nowMs + MS_20H);
                basePayload.deletionEligibleAfterAt = firebase.firestore.Timestamp.fromMillis(nowMs + MS_24H);
            }
            return db.collection('accountDeletionRequests').add(basePayload);
        })
        .then(function(refOrNull) {
            if (!refOrNull) return;
            accountDeletionChosenType = null;
            closeAccountDeletionConfirmModal();
            showAlert(
                $('membershipAlert'),
                'Your deletion request was sent. Staff may remove Firebase Authentication separately.',
                'success'
            );
            loadMembership();
        })
        .catch(function(err) {
            console.error(err);
            showAlert($('membershipAlert'), err.message || 'Could not submit request.', 'danger');
            if (sub) sub.disabled = false;
        });
}

function closeAccountDeletionPickModal() {
    var pk = $('accountDeletePickModal');
    if (pk && window.bootstrap && typeof bootstrap.Modal.getInstance === 'function') {
        var i = bootstrap.Modal.getInstance(pk);
        if (i) i.hide();
    }
}

function closeAccountDeletionConfirmModal() {
    var el = $('accountDeleteConfirmModal');
    if (el && window.bootstrap && typeof bootstrap.Modal.getInstance === 'function') {
        var i = bootstrap.Modal.getInstance(el);
        if (i) i.hide();
    }
}

/** Pending payout after user opens confirm modal (cleared on dismiss or submit). */
var refundConfirmPayload = null;
var refundConfirmModalInstance = null;

function getRefundConfirmModal() {
    var el = $('refundConfirmModal');
    if (!el || !window.bootstrap) return null;
    if (typeof bootstrap.Modal.getOrCreateInstance === 'function') {
        refundConfirmModalInstance = bootstrap.Modal.getOrCreateInstance(el);
    } else if (!refundConfirmModalInstance && window.bootstrap && bootstrap.Modal) {
        refundConfirmModalInstance = new bootstrap.Modal(el);
    }
    return refundConfirmModalInstance;
}

function executeRefundRequestSubmit(rounded, origin) {
    if (!currentUid || !currentUser || !memberData) return;

    var btnc = $('btnRequestCreditPayout');
    var btnr = $('btnRequestRefundOwed');
    if (btnc) btnc.disabled = true;
    if (btnr) btnr.disabled = true;

    db.collection('refundRequests')
        .where('memberId', '==', currentUid)
        .where('status', '==', 'pending')
        .get()
        .then(function(snap) {
            var dup = false;
            if (snap && !snap.empty) {
                snap.forEach(function(docSnap) {
                    var rd = docSnap.data();
                    var o = rd.requestOrigin === 'refund' ? 'refund' : 'credit';
                    if (o === origin) dup = true;
                });
            }
            if (dup) {
                var pendFromServer = null;
                snap.forEach(function(docSnap) {
                    var rd = docSnap.data();
                    var o = rd.requestOrigin === 'refund' ? 'refund' : 'credit';
                    if (o === origin) {
                        pendFromServer = {
                            amount:
                                typeof rd.amount === 'number' && !isNaN(rd.amount)
                                    ? rd.amount
                                    : null,
                            currency: rd.currency
                        };
                    }
                });
                var symDup = memberCurrencySym(memberData.planCurrency || 'GBP');
                showAlert(
                    $('refundRequestAlert'),
                    pendingPayoutBlockedMessage(symDup, pendFromServer),
                    'info'
                );
                return Promise.resolve(null);
            }
            return db.collection('refundRequests').add({
                memberId: currentUid,
                memberEmail: currentUser.email || '',
                memberName: memberData.displayName || '',
                amount: rounded,
                currency: memberData.planCurrency || 'GBP',
                notes: '',
                requestOrigin: origin,
                status: 'pending',
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        })
        .then(function(refOrNull) {
            if (!refOrNull) {
                loadMembership();
                return;
            }
            showAlert($('refundRequestAlert'), 'Your request was sent. Staff will review it.', 'success');
            loadMembership();
        })
        .catch(function(err) {
            console.error(err);
            showAlert($('membershipAlert'), err.message || 'Could not submit request.', 'danger');
            loadMembership();
        });
}

/** Confirm only (no notes); styled modal then refundRequests for staff approval. */
function requestRefundPayout(requestOriginKey) {
    if (!memberData || !currentUser || !currentUid) return;

    var originEarly = requestOriginKey === 'refund' ? 'refund' : 'credit';
    var pendEarly =
        originEarly === 'refund' ? memberRefundPendingByOrigin.refund : memberRefundPendingByOrigin.credit;
    if (pendEarly) {
        var symE = memberCurrencySym(memberData.planCurrency || 'GBP');
        showAlert($('refundRequestAlert'), pendingPayoutBlockedMessage(symE, pendEarly), 'info');
        return;
    }

    var rawAmt =
        requestOriginKey === 'refund'
            ? typeof memberData.lastRefundAmount === 'number'
                ? Math.max(0, memberData.lastRefundAmount)
                : 0
            : typeof memberData.planCredit === 'number'
                ? Math.max(0, memberData.planCredit)
                : 0;

    if (rawAmt <= 0) return;

    var rounded = Math.round(rawAmt * 100) / 100;
    var sym = memberCurrencySym(memberData.planCurrency || 'GBP');
    var origin = requestOriginKey === 'refund' ? 'refund' : 'credit';

    refundConfirmPayload = { rounded: rounded, origin: origin, sym: sym };

    var modalEl = $('refundConfirmModal');
    if (modalEl) {
        modalEl.classList.remove('memb-confirm--credit', 'memb-confirm--owing');
        modalEl.classList.add(origin === 'refund' ? 'memb-confirm--owing' : 'memb-confirm--credit');
    }

    var iconWrap = $('refundConfirmTitleIconWrap');
    if (iconWrap) {
        iconWrap.innerHTML =
            origin === 'refund'
                ? '<i class="fas fa-rotate-left"></i>'
                : '<i class="fas fa-coins"></i>';
    }

    if ($('refundConfirmTitleText')) {
        $('refundConfirmTitleText').textContent =
            origin === 'refund' ? 'Confirm refund owing' : 'Confirm credit payout';
    }

    if ($('refundConfirmAmountBadge')) {
        $('refundConfirmAmountBadge').textContent = sym + rounded.toFixed(2);
    }

    if ($('refundConfirmBody')) {
        $('refundConfirmBody').textContent =
            'Request a payout of ' +
            sym +
            rounded.toFixed(2) +
            (origin === 'refund'
                ? ' from your refund owing. This does not use account credit.'
                : ' from your account credit. If approved, that amount is deducted from your balance.');
    }

    var m = getRefundConfirmModal();
    if (m) m.show();
}

function loadMembership() {
    if (!currentUid) return;
    var tbody = $('membershipHistoryBody');
    var sym = memberCurrencySym((memberData && memberData.planCurrency) || 'GBP');

    if (tbody) {
        tbody.innerHTML =
            '<tr><td colspan="11" class="text-center memb-hist-muted py-4">Loading\u2026</td></tr>';
    }

    db.collection('members')
        .doc(currentUid)
        .get()
        .then(function(doc) {
            var d = doc.exists ? doc.data() : {};
            memberData = d;
            sym = memberCurrencySym(d.planCurrency || 'GBP');

            if ($('membPlanName')) {
                var nm = d.plan || '\u2014';
                if (d.planPeriod) {
                    nm += ' (' + (d.planPeriod === 'yearly' ? 'Yearly' : 'Monthly') + ')';
                }
                $('membPlanName').textContent = nm;
            }
            if ($('membPlanStatus')) $('membPlanStatus').innerHTML = formatMembershipStatusHtml(d);

            if ($('membPlanExpiry')) {
                if (d.planExpiresAt && typeof d.planExpiresAt.toDate === 'function') {
                    $('membPlanExpiry').textContent = formatMemberDateOnly(d.planExpiresAt);
                } else {
                    $('membPlanExpiry').textContent = d.planId ? '\u2014' : 'No paid membership on file';
                }
            }

            if ($('membPlanActivated')) {
                if (d.planActivatedAt && typeof d.planActivatedAt.toDate === 'function') {
                    $('membPlanActivated').textContent = formatMemberTs(d.planActivatedAt);
                } else {
                    $('membPlanActivated').textContent = '\u2014';
                }
            }

            if ($('membCredit')) {
                $('membCredit').textContent =
                    typeof d.planCredit === 'number' ? sym + d.planCredit.toFixed(2) : '\u2014';
            }

            if ($('membRefundSummary')) {
                var ra = typeof d.lastRefundAmount === 'number' ? d.lastRefundAmount : 0;
                if (ra > 0) {
                    $('membRefundSummary').textContent =
                        sym + ra.toFixed(2) + (d.lastRefundAt ? ' \u00B7 ' + formatMemberTs(d.lastRefundAt) : '');
                } else {
                    $('membRefundSummary').textContent = '\u2014';
                }
            }

            return Promise.all([
                db.collection('refundRequests')
                    .where('memberId', '==', currentUid)
                    .where('status', '==', 'pending')
                    .get(),
                db.collection('accountDeletionRequests')
                    .where('memberId', '==', currentUid)
                    .where('status', '==', 'pending')
                    .get()
            ]).then(function(results) {
                    applyPendingRefundRequests(results[0]);
                    applyPendingAccountDeletionSnap(results[1]);
                    syncMembershipPayoutButtons(d);
                    syncAccountDeletionBannerAndButton();
                    var active = isMemberPlanActive(d);
                    var note = $('membCancelScheduledNote');
                    if (note) {
                        note.classList.toggle('d-none', !(d.cancelAtPeriodEnd === true && active));
                    }
                    var btnEnd = $('btnCancelAtPeriodEnd');
                    var btnNow = $('btnCancelImmediate');
                    if (btnEnd) {
                        var hideCancel = !active || d.cancelAtPeriodEnd === true;
                        btnEnd.classList.toggle('d-none', hideCancel);
                        btnEnd.disabled = hideCancel;
                    }
                    if (btnNow) {
                        var hideNow = !active || d.cancelAtPeriodEnd === true;
                        btnNow.classList.toggle('d-none', hideNow);
                        btnNow.disabled = hideNow;
                    }
                    return db
                        .collection('members')
                        .doc(currentUid)
                        .collection('membershipPurchases')
                        .orderBy('createdAt', 'desc')
                        .limit(50)
                        .get();
                });
        })
        .then(function(snap) {
            if (!tbody) return;
            tbody.innerHTML = '';
            if (!snap || snap.empty) {
                tbody.innerHTML =
                    '<tr><td colspan="11" class="text-center memb-hist-muted py-4">No history yet. Purchases, plan changes, and cancellations are listed here.</td></tr>';
                return;
            }
            snap.forEach(function(doc) {
                var r = doc.data();
                var tr = document.createElement('tr');
                var symRow = memberCurrencySym(r.currency || 'GBP');
                var typeMap = {
                    purchase: 'Purchase',
                    plan_change: 'Plan change',
                    cancellation_period_end: 'Cancel (access to expiry)',
                    cancellation_immediate: 'Cancel (immediate)',
                    admin_refund_approved: 'Refund (admin approved)'
                };
                var typeLabel = typeMap[r.type] || r.type || '\u2014';
                var charged =
                    typeof r.amountCharged === 'number' ? symRow + r.amountCharged.toFixed(2) : '\u2014';
                var credUsed =
                    typeof r.creditUsed === 'number' && r.creditUsed > 0
                        ? symRow + r.creditUsed.toFixed(2)
                        : '\u2014';
                var refundCell = '\u2014';
                if (typeof r.refundOrCreditAmount === 'number' && r.refundOrCreditAmount > 0) {
                    refundCell =
                        symRow +
                        r.refundOrCreditAmount.toFixed(2) +
                        (r.refundChoice === 'credit' ? ' (credit)' : r.refundChoice === 'refund' ? ' (refund)' : '');
                }
                var balAfter =
                    typeof r.planCreditAfter === 'number' ? symRow + r.planCreditAfter.toFixed(2) : '\u2014';
                var expCell = '\u2014';
                if (r.planExpiresAt && typeof r.planExpiresAt.toDate === 'function') {
                    expCell = formatMemberDateOnly(r.planExpiresAt);
                }
                var ref = (r.txnId && String(r.txnId).trim()) || doc.id.slice(0, 8);
                var when = r.createdAt && typeof r.createdAt.toDate === 'function'
                    ? r.createdAt.toDate().toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
                    : '\u2014';
                var detail = (r.note && String(r.note).trim()) || '';
                if (r.previousPlanId && String(r.previousPlanId).trim()) {
                    detail = (detail ? detail + ' \u00B7 ' : '') + 'Previous plan: ' + r.previousPlanId;
                }
                var adminRefCell = '\u2014';
                if (
                    r.type === 'admin_refund_approved' &&
                    typeof r.adminRefundedAmount === 'number' &&
                    r.adminRefundedAmount > 0
                ) {
                    adminRefCell = symRow + r.adminRefundedAmount.toFixed(2);
                } else if (
                    r.type === 'admin_refund_approved' &&
                    typeof r.refundOrCreditAmount === 'number' &&
                    r.refundOrCreditAmount > 0
                ) {
                    adminRefCell = symRow + r.refundOrCreditAmount.toFixed(2);
                }
                tr.innerHTML =
                    '<td class="text-white">' +
                    escapeHtml(when) +
                    '</td><td class="text-white">' +
                    escapeHtml(typeLabel) +
                    '</td><td class="text-white">' +
                    escapeHtml(r.planName || '\u2014') +
                    '</td><td class="text-white">' +
                    escapeHtml(r.period === 'yearly' ? 'Yearly' : r.period === 'monthly' ? 'Monthly' : '\u2014') +
                    '</td><td class="text-white">' +
                    escapeHtml(expCell) +
                    '</td><td class="text-white">' +
                    escapeHtml(charged) +
                    '</td><td class="text-white">' +
                    escapeHtml(credUsed) +
                    '</td><td class="small text-white">' +
                    escapeHtml(refundCell) +
                    '</td><td class="text-white">' +
                    escapeHtml(balAfter) +
                    '</td><td class="small text-white">' +
                    escapeHtml(adminRefCell) +
                    '</td><td class="small memb-hist-detail">' +
                    escapeHtml(detail || ref) +
                    '</td>';
                tbody.appendChild(tr);
            });
        })
        .catch(function(err) {
            console.error(err);
            if (tbody) {
                tbody.innerHTML =
                    '<tr><td colspan="11" class="text-danger text-center py-3">Could not load membership data. If this persists, try again after deployment of Firestore indexes.</td></tr>';
            }
        });
}

if ($('btnRenewMembership')) {
    $('btnRenewMembership').addEventListener('click', function() {
        var pid = memberData && memberData.planId;
        if (pid && getPlan(pid)) {
            var per = memberData.planPeriod === 'yearly' ? 'yearly' : 'monthly';
            window.location.href =
                'payment.html?plan=' + encodeURIComponent(pid) + '&period=' + encodeURIComponent(per);
        } else {
            window.location.href = 'membership.html';
        }
    });
}

if ($('btnChangeMembershipPlan')) {
    $('btnChangeMembershipPlan').addEventListener('click', function() {
        window.location.href = 'membership.html';
    });
}

if ($('btnCancelAtPeriodEnd')) {
    $('btnCancelAtPeriodEnd').addEventListener('click', function() {
        if (!currentUid || !memberData) return;
        if (
            !confirm(
                'Cancel auto-renewal?\n\nYou keep full access until your current expiry date. You can purchase again anytime.'
            )
        ) {
            return;
        }
        db.collection('members')
            .doc(currentUid)
            .update({
                planStatus: 'cancelled',
                cancelAtPeriodEnd: true,
                membershipCancelledAt: firebase.firestore.FieldValue.serverTimestamp()
            })
            .then(function() {
                return memberAppendLedgerEntry('cancellation_period_end', {
                    note: 'Membership will not renew. Access continues until this expiry date.',
                    planExpiresAt: memberData.planExpiresAt || null
                });
            })
            .then(function() {
                showAlert($('membershipAlert'), 'You will not be charged again. Access continues until expiry.', 'success');
                loadMembership();
                loadProfile();
            })
            .catch(function(e) {
                showAlert($('membershipAlert'), e.message || 'Could not update membership.', 'danger');
            });
    });
}

if ($('btnCancelImmediate')) {
    $('btnCancelImmediate').addEventListener('click', function() {
        if (!currentUid || !memberData) return;
        if (
            !confirm(
                'End membership immediately?\n\nYou will lose paid access right away. This cannot be undone from the app.'
            )
        ) {
            return;
        }
        var nowTs = firebase.firestore.Timestamp.fromMillis(Date.now());
        db.collection('members')
            .doc(currentUid)
            .update({
                planStatus: 'cancelled',
                cancelAtPeriodEnd: false,
                planExpiresAt: nowTs,
                membershipCancelledAt: firebase.firestore.FieldValue.serverTimestamp()
            })
            .then(function() {
                return memberAppendLedgerEntry('cancellation_immediate', {
                    note: 'Access ended immediately.',
                    planExpiresAt: nowTs
                });
            })
            .then(function() {
                showAlert($('membershipAlert'), 'Your membership has been ended.', 'info');
                loadMembership();
                loadProfile();
            })
            .catch(function(e) {
                showAlert($('membershipAlert'), e.message || 'Could not cancel membership.', 'danger');
            });
    });
}

if ($('btnRefreshMembership')) {
    $('btnRefreshMembership').addEventListener('click', loadMembership);
}

if ($('btnRequestCreditPayout')) {
    $('btnRequestCreditPayout').addEventListener('click', function() {
        requestRefundPayout('credit');
    });
}
if ($('btnRequestRefundOwed')) {
    $('btnRequestRefundOwed').addEventListener('click', function() {
        requestRefundPayout('refund');
    });
}

if ($('refundConfirmSubmit')) {
    $('refundConfirmSubmit').addEventListener('click', function() {
        var btn = $('refundConfirmSubmit');
        var p = refundConfirmPayload;
        if (!p || !currentUid || !memberData || !currentUser) return;
        if (btn) btn.disabled = true;
        refundConfirmPayload = null;
        var modal = getRefundConfirmModal();
        if (modal) modal.hide();
        executeRefundRequestSubmit(p.rounded, p.origin);
    });
}

var refundConfirmModalEl = $('refundConfirmModal');
if (refundConfirmModalEl) {
    refundConfirmModalEl.addEventListener('hidden.bs.modal', function() {
        refundConfirmPayload = null;
        var sub = $('refundConfirmSubmit');
        if (sub) sub.disabled = false;
    });
}

if ($('btnDeleteAccount')) {
    $('btnDeleteAccount').addEventListener('click', function() {
        if (!currentUid || !currentUser || !memberData) return;
        if (pendingAccountDeletionDoc && (pendingAccountDeletionDoc.d.status || '') === 'pending') {
            showAlert($('membershipAlert'), 'You already have a pending account request.', 'info');
            return;
        }
        var pk = getAccountDeletionPickModal();
        if (pk) pk.show();
    });
}

if ($('btnAccountDeleteTemporary')) {
    $('btnAccountDeleteTemporary').addEventListener('click', function() {
        openAccountDeletionConfirmForType('temporary');
    });
}
if ($('btnAccountDeletePermanent')) {
    $('btnAccountDeletePermanent').addEventListener('click', function() {
        openAccountDeletionConfirmForType('permanent');
    });
}

if ($('btnAccountDeleteGoBack')) {
    $('btnAccountDeleteGoBack').addEventListener('click', function() {
        closeAccountDeletionConfirmModal();
        var pk = getAccountDeletionPickModal();
        if (pk) pk.show();
    });
}

if ($('accountDeleteAcknowledged')) {
    $('accountDeleteAcknowledged').addEventListener('change', function() {
        var sub = $('accountDeleteSubmitRequest');
        if (!sub) return;
        sub.disabled = !$('accountDeleteAcknowledged').checked;
    });
}

if ($('accountDeleteSubmitRequest')) {
    $('accountDeleteSubmitRequest').addEventListener('click', function() {
        submitMemberAccountDeletionRequest();
    });
}

var accountDeleteConfirmModalEl = $('accountDeleteConfirmModal');
if (accountDeleteConfirmModalEl) {
    accountDeleteConfirmModalEl.addEventListener('hidden.bs.modal', function() {
        accountDeletionChosenType = null;
        var sub = $('accountDeleteSubmitRequest');
        if (sub) sub.disabled = true;
        var ack = $('accountDeleteAcknowledged');
        if (ack) ack.checked = false;
    });
}

if ($('btnWithdrawAccountDeletion')) {
    $('btnWithdrawAccountDeletion').addEventListener('click', function() {
        if (!pendingAccountDeletionDoc || !currentUid) return;
        if (!confirm('Withdraw your account deletion request?')) return;
        var rd = pendingAccountDeletionDoc.d;
        if ((rd.requestType || '') === 'permanent' && !canWithdrawAccountDeletion(rd)) {
            showAlert(
                $('membershipAlert'),
                'The cancellation window has passed for this permanent request. Please contact DaDaGym staff.',
                'warning'
            );
            return;
        }
        var btn = $('btnWithdrawAccountDeletion');
        if (btn) btn.disabled = true;
        db.collection('accountDeletionRequests')
            .doc(pendingAccountDeletionDoc.id)
            .update({
                status: 'cancelled_member',
                cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
                cancelledBy: 'member'
            })
            .then(function() {
                showAlert($('membershipAlert'), 'Your request was withdrawn.', 'success');
                loadMembership();
            })
            .catch(function(err) {
                console.error(err);
                if (btn) btn.disabled = false;
                showAlert($('membershipAlert'), err.message || 'Could not withdraw.', 'danger');
            });
    });
}

/* JS Date#getDay(): 0 Sunday … 6 Saturday */
var JS_WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad2(n) {
    return (n < 10 ? '0' : '') + n;
}

function formatYYYYMMDDLocal(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function parseISODateLocal(iso) {
    var p = String(iso || '').split('-');
    if (p.length !== 3) return null;
    var y = parseInt(p[0], 10);
    var m = parseInt(p[1], 10) - 1;
    var day = parseInt(p[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(day)) return null;
    return new Date(y, m, day);
}

function getJsWeekdayFromISODate(iso) {
    var d = parseISODateLocal(iso);
    return d ? d.getDay() : null;
}

/** Map class schedule.day to JS weekday (0–6). Null if unknown. */
function scheduleDayToJsWeekday(dayStr) {
    if (dayStr == null || dayStr === '') return null;
    var k = String(dayStr).trim().toLowerCase().replace(/\./g, '');
    var map = {
        sun: 0, sunday: 0,
        mon: 1, monday: 1,
        tue: 2, tues: 2, tuesday: 2,
        wed: 3, weds: 3, wednesday: 3,
        thu: 4, thur: 4, thurs: 4, thursday: 4,
        fri: 5, friday: 5,
        sat: 6, saturday: 6
    };
    if (map[k] !== undefined) return map[k];
    var short = k.slice(0, 3);
    if (map[short] !== undefined) return map[short];
    return null;
}

function nextOccurrenceOfWeekday(jsWeekday) {
    var today = new Date();
    var d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var cur = d.getDay();
    var diff = jsWeekday - cur;
    if (diff < 0) diff += 7;
    d.setDate(d.getDate() + diff);
    return d;
}

/** Doc id: `{classId}_{YYYY-MM-DD}` — per-occurrence enrollment (recurring weekly classes). */
function classSessionEnrolledDocId(classId, dateIso) {
    return String(classId || '').trim() + '_' + String(dateIso || '').trim();
}

/** Random 5-digit reference shown to members (10000–99999). */
function generateBookingCode() {
    return Math.floor(10000 + Math.random() * 90000);
}

/** Sort key from Firestore Timestamp or missing. */
function bookingCreatedMs(data) {
    var ts = data && data.createdAt;
    if (!ts) return 0;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
    return 0;
}

function validateBookDateWeekday() {
    var hid = $('bookClassId');
    var fb = $('bookDateFeedback');
    var btn = $('btnConfirmBook');
    var inp = $('bookDate');
    if (!hid || !btn) return false;
    var wd = scheduleDayToJsWeekday(hid.dataset.scheduleDay || '');
    if (wd === null) {
        btn.disabled = true;
        if (fb) { fb.classList.add('d-none'); fb.textContent = ''; }
        return false;
    }
    var val = inp ? inp.value : '';
    if (!val) {
        if (fb) fb.classList.add('d-none');
        btn.disabled = true;
        return false;
    }
    var got = getJsWeekdayFromISODate(val);
    if (got !== wd) {
        if (fb) {
            fb.textContent = 'This class only meets on ' + JS_WEEKDAY_LABELS[wd] + '. Pick that weekday.';
            fb.classList.remove('d-none');
        }
        btn.disabled = true;
        return false;
    }
    if (fb) { fb.classList.add('d-none'); fb.textContent = ''; }
    btn.disabled = false;
    return true;
}

/* ═══════════════════════════════════════
   CLASSES
   ═══════════════════════════════════════ */
function loadClasses() {
    var grid = $('classesGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="col-12 text-center text-muted py-4">Loading classes…</div>';

    Promise.all([
        db.collection('members').doc(currentUid).get(),
        db.collection('classes').get(),
        db.collection('bookings').where('memberId', '==', currentUid).get()
    ])
        .then(function(parts) {
            var mdoc = parts[0];
            var classSnap = parts[1];
            var bookSnap = parts[2];

            if (mdoc && mdoc.exists) memberData = mdoc.data();

            var gate = evaluateClassBookingGate(memberData || {}, bookSnap);

            grid.innerHTML = '';
            var docs = [];
            classSnap.forEach(function(doc) {
                var c = doc.data();
                var st = c.status || 'active';
                if (st !== 'active') return;
                docs.push(doc);
            });
            if (!docs.length) {
                grid.innerHTML = '<div class="col-12 text-center text-muted py-4">No classes available yet</div>';
                return;
            }
            var sessionPromises = docs.map(function(clDoc) {
                var c = clDoc.data();
                var wd = scheduleDayToJsWeekday((c.schedule && c.schedule.day) ? String(c.schedule.day) : '');
                if (wd === null) {
                    return Promise.resolve({ docId: clDoc.id, useSession: false, sessionEnr: 0 });
                }
                var occDate = formatYYYYMMDDLocal(nextOccurrenceOfWeekday(wd));
                var sref = db.collection('classSessionEnrolled').doc(classSessionEnrolledDocId(clDoc.id, occDate));
                return sref.get().then(function(snap) {
                    var se = snap.exists ? (snap.data().enrolled != null ? snap.data().enrolled : 0) : 0;
                    return { docId: clDoc.id, useSession: true, sessionEnr: se };
                });
            });
            return Promise.all(sessionPromises).then(function(sessionRows) {
                var sessionByClass = {};
                sessionRows.forEach(function(row) {
                    sessionByClass[row.docId] = row;
                });
                docs.forEach(function(doc) {
                    var c = doc.data();
                    var cap = c.capacity || 0;
                    var row = sessionByClass[doc.id];
                    var enrolled = (row && row.useSession) ? row.sessionEnr : (c.enrolled || 0);
                    var spots = cap - enrolled;
                    var dayTxt = (c.schedule && c.schedule.day) ? c.schedule.day : '—';
                    var timeTxt = (c.schedule && c.schedule.time) ? c.schedule.time : '—';
                    var durTxt = (c.schedule && c.schedule.duration) ? String(c.schedule.duration) + ' min' : '';
                    var metaSchedule = escapeHtml(dayTxt) + ' · ' + escapeHtml(timeTxt) +
                        (durTxt ? ' · ' + escapeHtml(durTxt) : '');
                    var trainerSpots = escapeHtml(c.trainerName || 'TBA') + ' · ' + spots + '/' + (c.capacity || 0);

                    var bookRow = '';
                    if (spots <= 0) {
                        bookRow = '<button type="button" class="btn btn-secondary btn-sm w-100 mt-2" disabled>Full</button>';
                    } else if (gate.ok) {
                        bookRow =
                            '<button type="button" class="btn btn-primary btn-sm w-100 mt-2" onclick="openBookModal(\'' +
                            escapeJsString(doc.id) + '\',\'' + escapeJsString(c.name || '') + '\',\'' +
                            escapeJsString(c.trainerName || '') + '\',\'' + escapeJsString(c.trainerId || '') + '\',\'' +
                            escapeJsString((c.schedule && c.schedule.time) ? c.schedule.time : '') + '\',\'' +
                            escapeJsString((c.schedule && c.schedule.day) ? String(c.schedule.day) : '') + '\')">Book Now</button>';
                    } else {
                        bookRow =
                            '<button type="button" class="btn btn-secondary btn-sm w-100 mt-2" disabled title="' +
                            escapeHtml(gate.reason).replace(/"/g, '&quot;') + '">Book Now</button>' +
                            '<div class="small text-warning mt-2">' + escapeHtml(gate.reason) + '</div>';
                    }

                    var col = document.createElement('div');
                    col.className = 'col-6 col-sm-4 col-md-3 col-lg-2';
                    col.innerHTML =
                        '<div class="dash-card h-100 class-card-member">' +
                            '<div class="card-body text-center">' +
                            '<div class="class-avatar"><i class="fas fa-dumbbell"></i></div>' +
                            '<h6 class="text-white fw-bold mt-2 mb-1">' + escapeHtml(c.name || 'Untitled') + '</h6>' +
                            '<span class="badge bg-info">' + escapeHtml(c.type || 'General') + '</span>' +
                            '<div class="member-meta small mt-1">' + metaSchedule + '</div>' +
                            '<div class="member-meta small">' + trainerSpots + '</div>' +
                            bookRow +
                            '</div>' +
                        '</div>';
                    grid.appendChild(col);
                });
            });
        })
        .catch(function(err) {
            console.error('classes:', err);
            grid.innerHTML = '<div class="col-12 text-center text-danger py-4">Could not load classes.</div>';
        });
}

if ($('btnRefreshClasses')) {
    $('btnRefreshClasses').addEventListener('click', loadClasses);
}

window.openBookModal = function(classId, className, trainerName, trainerId, time, scheduleDay) {
    var hid = $('bookClassId');
    if (!hid) return;
    hid.value = classId;
    hid.dataset.trainerId = trainerId || '';
    hid.dataset.trainerName = trainerName || '';
    hid.dataset.className = className || '';
    hid.dataset.time = time || '';
    hid.dataset.scheduleDay = scheduleDay || '';

    var titleEl = $('bookClassName');
    if (titleEl) titleEl.textContent = className + (trainerName ? ' with ' + trainerName : '');

    var wd = scheduleDayToJsWeekday(scheduleDay);
    var hint = $('bookScheduleHint');
    if (hint) {
        hint.classList.remove('d-none');
        hint.classList.remove('alert-info', 'alert-warning');
        if (wd !== null) {
            hint.classList.add('alert', 'alert-info');
            hint.textContent = 'This class meets on ' + JS_WEEKDAY_LABELS[wd] + '. You can only book a date that falls on that weekday.';
        } else {
            hint.classList.add('alert', 'alert-warning');
            hint.textContent = 'No weekday is saved for this class. Ask staff to set the schedule before booking.';
        }
    }

    var note = $('bookDateWeekdayNote');
    if (note) {
        note.textContent = wd !== null
            ? ('Choose a date (required). The class meets on ' + JS_WEEKDAY_LABELS[wd] + ' — any future occurrence is allowed.')
            : 'Choose a date (required).';
    }

    var todayLocal = formatYYYYMMDDLocal(new Date());
    var bd = $('bookDate');
    if (bd) {
        bd.min = todayLocal;
        bd.value = '';
    }

    var fb = $('bookDateFeedback');
    if (fb) { fb.classList.add('d-none'); fb.textContent = ''; }

    validateBookDateWeekday();

    var bm = $('bookModal');
    if (bm && window.bootstrap) bootstrap.Modal.getOrCreateInstance(bm).show();
};

if ($('bookDate')) {
    $('bookDate').addEventListener('change', validateBookDateWeekday);
    $('bookDate').addEventListener('input', validateBookDateWeekday);
}

/** Canonical time string for duplicate checks (handles Firestore Timestamp / strings). */
function bookingTimeComparable(t) {
    if (t == null || t === '') return '';
    if (typeof t === 'string' || typeof t === 'number') {
        return String(t).trim().replace(/\s+/g, ' ');
    }
    if (typeof t === 'object') {
        if (typeof t.toDate === 'function') {
            try {
                var d = t.toDate();
                return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
            } catch (e) { /* ignore */ }
        }
        if (typeof t.seconds === 'number') {
            try {
                var d2 = new Date(t.seconds * 1000);
                return String(d2.getHours()).padStart(2, '0') + ':' + String(d2.getMinutes()).padStart(2, '0');
            } catch (e2) { /* ignore */ }
        }
    }
    return String(t).trim().replace(/\s+/g, ' ');
}

/** One Firestore doc per member + class + date + time — prevents double-book races. */
function bookingSlotDocId(memberId, classId, date, timeComparable) {
    var t = (timeComparable || '').replace(/:/g, '-').replace(/\//g, '_');
    if (!t) t = 'na';
    return memberId + '_' + classId + '_' + date + '_' + t;
}

function duplicateBookingErr() {
    var e = new Error('DUPLICATE_BOOKING');
    e.code = 'DUPLICATE_BOOKING';
    return e;
}

function classFullErr() {
    var e = new Error('CLASS_FULL');
    e.code = 'CLASS_FULL';
    return e;
}

function guestBookingGateErr() {
    var e = new Error('BOOKING_GATE');
    e.code = 'BOOKING_GATE';
    return e;
}

$('btnConfirmBook').addEventListener('click', function() {
    var classId = $('bookClassId').value;
    var date = $('bookDate').value;
    if (!date) { alert('Please select a date.'); return; }

    var ds = $('bookClassId').dataset;
    var wd = scheduleDayToJsWeekday(ds.scheduleDay || '');
    if (wd === null) {
        alert('This class does not have a valid weekday in its schedule. Please contact the gym.');
        return;
    }
    if (!validateBookDateWeekday() || getJsWeekdayFromISODate(date) !== wd) {
        alert('Booking date must be a ' + JS_WEEKDAY_LABELS[wd] + ' for this class.');
        return;
    }

    var bookingCode = generateBookingCode();
    var timeRaw = ds.time || '';
    var wantTime = bookingTimeComparable(timeRaw);
    var slotId = bookingSlotDocId(currentUid, classId, date, wantTime);

    var btnBook = $('btnConfirmBook');
    btnBook.disabled = true;

    Promise.all([
        db.collection('members').doc(currentUid).get(),
        db.collection('bookings').where('memberId', '==', currentUid).get()
    ])
        .then(function(parts) {
            var mdoc = parts[0];
            var snap = parts[1];
            memberData = mdoc.exists ? mdoc.data() : {};

            var gate = evaluateClassBookingGate(memberData, snap);
            if (!gate.ok) {
                alert(gate.reason);
                throw guestBookingGateErr();
            }

            var duplicate = false;
            snap.forEach(function(doc) {
                var b = doc.data();
                if ((b.status || '') === 'cancelled') return;
                if (b.classId !== classId || b.date !== date) return;
                if (bookingTimeComparable(b.time) !== wantTime) return;
                duplicate = true;
            });
            if (duplicate) throw duplicateBookingErr();

            var planActive = isMemberPlanActive(memberData);
            var booking = {
                memberId: currentUid,
                memberName: memberData.displayName || currentUser.email,
                memberEmail: currentUser.email,
                trainerId: ds.trainerId || '',
                trainerName: ds.trainerName || '',
                classId: classId,
                className: ds.className || '',
                scheduleDay: ds.scheduleDay || '',
                date: date,
                time: timeRaw,
                slotKey: slotId,
                bookingCode: bookingCode,
                status: 'confirmed',
                guestTrialBooking: !planActive,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            var sessionRef = db.collection('classSessionEnrolled').doc(classSessionEnrolledDocId(classId, date));

            return db.runTransaction(function(transaction) {
                var ref = db.collection('bookings').doc(slotId);
                var classRef = db.collection('classes').doc(classId);
                return transaction.get(ref).then(function(docSnap) {
                    if (docSnap.exists) {
                        var st = docSnap.data().status || '';
                        if (st !== 'cancelled') throw duplicateBookingErr();
                    }
                    return transaction.get(classRef).then(function(classSnap) {
                        if (!classSnap.exists) {
                            throw new Error('This class is no longer available.');
                        }
                        var cd = classSnap.data();
                        var cap = cd.capacity != null ? cd.capacity : 0;
                        return transaction.get(sessionRef).then(function(sessionSnap) {
                            var sessionEnr = sessionSnap.exists
                                ? (sessionSnap.data().enrolled != null ? sessionSnap.data().enrolled : 0)
                                : 0;
                            if (cap > 0 && sessionEnr >= cap) throw classFullErr();

                            transaction.set(ref, booking);
                            if (!sessionSnap.exists) {
                                transaction.set(sessionRef, {
                                    classId: classId,
                                    date: date,
                                    enrolled: 1
                                });
                            } else {
                                transaction.update(sessionRef, {
                                    enrolled: firebase.firestore.FieldValue.increment(1)
                                });
                            }
                            var lookupRef = db.collection('bookingLookups').doc(String(bookingCode));
                            transaction.set(lookupRef, {
                                bookingId: slotId,
                                memberId: currentUid,
                                trainerId: ds.trainerId || '',
                                trainerName: ds.trainerName || '',
                                className: ds.className || '',
                                date: date,
                                time: timeRaw
                            });
                        });
                    });
                });
            });
        })
        .then(function() {
            if ($('bookModal') && bootstrap.Modal.getInstance($('bookModal'))) {
                bootstrap.Modal.getInstance($('bookModal')).hide();
            }
            if (typeof window.showBookingConfirmation === 'function') {
                window.showBookingConfirmation(bookingCode, {
                    className: ds.className || '',
                    date: date,
                    time: timeRaw,
                    memberId: currentUid,
                    bookingId: slotId
                });
            } else {
                alert('Booking confirmed. Your reference number is ' + bookingCode + '.');
            }
            loadClasses();
            loadBookings();
            switchSection('bookings');
        })
        .catch(function(err) {
            if (err && err.code === 'BOOKING_GATE') return;
            if (err && err.code === 'DUPLICATE_BOOKING') {
                alert('You already have an active booking for this class on this date at this time.');
                return;
            }
            if (err && err.code === 'CLASS_FULL') {
                alert('This class is full. Try another date or class.');
                return;
            }
            if (err) alert(err.message || 'Booking failed.');
        })
        .finally(function() {
            btnBook.disabled = false;
        });
});

/* ═══════════════════════════════════════
   TRAINERS
   ═══════════════════════════════════════ */
var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
var currentTrainerDetailId = null;
var currentTrainerDetailName = '';

function timePartDisplay(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (typeof v === 'object') {
        if (typeof v.toDate === 'function') {
            try { return v.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
            catch (e) { /* ignore */ }
        }
        if (typeof v.seconds === 'number') {
            try { return new Date(v.seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
            catch (e2) { /* ignore */ }
        }
    }
    return String(v);
}

function formatSlotLabel(s) {
    if (s == null || s === '') return '';
    if (typeof s === 'string' || typeof s === 'number') return String(s);
    if (typeof s !== 'object') return String(s);
    var a = s.start != null ? s.start : s.from != null ? s.from : s.begin;
    var b = s.end != null ? s.end : s.to != null ? s.to : s.until;
    var at = timePartDisplay(a);
    var bt = timePartDisplay(b);
    if (at && bt) return at + ' – ' + bt;
    if (at) return at;
    if (s.label != null && String(s.label).trim() !== '') return String(s.label);
    if (s.time != null && s.time !== '') {
        var tt = timePartDisplay(s.time);
        return tt || String(s.time);
    }
    return '';
}

function collectSlotLabels(dayData) {
    if (dayData == null) return [];
    if (typeof dayData === 'string' || typeof dayData === 'number') return [String(dayData)];
    if (typeof dayData !== 'object') return [];
    if (dayData.available === false) return [];
    var slots = dayData.slots != null ? dayData.slots : dayData.times != null ? dayData.times : null;
    if (Array.isArray(slots)) {
        return slots.map(formatSlotLabel).filter(function(x) { return x && String(x).trim() !== ''; });
    }
    if (typeof slots === 'string') return slots.trim() ? [slots] : [];
    if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
        var keys = Object.keys(slots);
        var boolMap = keys.length && keys.every(function(k) {
            var v = slots[k];
            return v === true || v === false || v === 1 || v === 0;
        });
        if (boolMap) return keys.filter(function(k) { return !!slots[k]; });
        var indexKeys = keys.length && keys.every(function(k) { return /^\d+$/.test(k); });
        if (indexKeys) {
            return keys.sort(function(a, b) { return Number(a) - Number(b); })
                .map(function(k) { return formatSlotLabel(slots[k]); })
                .filter(function(x) { return x && String(x).trim() !== ''; });
        }
    }
    var one = formatSlotLabel(dayData);
    return one ? [one] : [];
}

function slotSummaryForDay(dayVal) {
    if (dayVal == null || dayVal === '') return '—';
    if (typeof dayVal === 'object' && dayVal.available === false) return 'Off';
    var labels = collectSlotLabels(dayVal);
    if (labels.length) return labels.join(', ');
    return '—';
}

function formatTrainerAvailabilityHtml(avail) {
    if (!avail || typeof avail !== 'object') {
        return '<p class="text-muted small mb-0">No weekly schedule saved yet.</p>';
    }
    var html = '<div class="trainer-avail-list">';
    DAYS.forEach(function(day) {
        var dayVal = avail[day] || avail[day.toLowerCase()];
        html +=
            '<div class="trainer-avail-row">' +
                '<span class="text-muted">' + escapeHtml(day.slice(0, 3)) + '</span>' +
                '<span>' + escapeHtml(slotSummaryForDay(dayVal)) + '</span>' +
            '</div>';
    });
    html += '</div>';
    return html;
}

function trainerDetailAvatarHtml(name, email, photoURL) {
    var initials = getInitials(name, email);
    var ph = photoURL && String(photoURL).trim();
    var hasPhoto = ph && /^https?:\/\//i.test(ph);
    if (hasPhoto) {
        return (
            '<div class="trainer-detail-avatar">' +
                '<img src="' + escapeAttrUrl(ph) + '" alt="" onerror="this.remove();this.parentNode.textContent=\'' +
                escapeJsString(initials) + '\'">' +
            '</div>'
        );
    }
    return '<div class="trainer-detail-avatar">' + escapeHtml(initials) + '</div>';
}

function getTrainerDetailModal() {
    var el = $('trainerDetailModal');
    if (!el || !window.bootstrap) return null;
    return bootstrap.Modal.getOrCreateInstance(el);
}

function openTrainerDetailModal(trainerId) {
    if (!trainerId) return;
    currentTrainerDetailId = trainerId;
    var body = $('trainerDetailBody');
    var mt = $('tdModalTitle');
    body.innerHTML = '<p class="text-muted text-center py-4 mb-0"><i class="fas fa-spinner fa-spin me-2"></i>Loading trainer…</p>';
    if (mt) mt.innerHTML = '<i class="fas fa-user-tie me-2 text-info"></i>Trainer';

    var trainerRef = db.collection('trainers').doc(trainerId);
    var classesQuery = db.collection('classes').where('trainerId', '==', trainerId);

    Promise.all([trainerRef.get(), classesQuery.get()])
        .then(function(results) {
            var tDoc = results[0];
            var classesSnap = results[1];

            if (!tDoc.exists) {
                body.innerHTML = '<p class="text-danger mb-0">Trainer not found.</p>';
                return;
            }
            var t = tDoc.data();
            if ((t.approvalStatus || '') !== 'approved') {
                body.innerHTML = '<p class="text-muted mb-0">This trainer is not available.</p>';
                return;
            }

            var name = (t.displayName || t.email || 'Trainer').trim();
            currentTrainerDetailName = name;
            if (mt) mt.innerHTML = '<i class="fas fa-user-tie me-2 text-info"></i>' + escapeHtml(name);

            var classNames = [];
            classesSnap.forEach(function(doc) {
                var c = doc.data();
                if ((c.status || 'active') !== 'active') return;
                if (c.name) classNames.push(c.name);
            });

            var expNum = t.experience;
            var expLine = expNum != null && expNum !== ''
                ? escapeHtml(String(expNum)) + ' years experience'
                : '<span class="text-muted">—</span>';

            var availHtml = formatTrainerAvailabilityHtml(t.availability || t.weeklyAvailability);

            var classesHtml = '';
            if (!classNames.length) {
                classesHtml = '<p class="text-muted small mb-0">No classes assigned yet.</p>';
            } else {
                classesHtml = classNames.map(function(nm) {
                    return '<span class="trainer-class-pill">' + escapeHtml(nm) + '</span>';
                }).join('');
            }

            body.innerHTML =
                '<div class="trainer-detail-hero">' +
                    trainerDetailAvatarHtml(name, t.email, t.photoURL) +
                    '<div class="trainer-detail-meta">' +
                        '<h6>' + escapeHtml(name) + '</h6>' +
                        '<p class="text-muted mb-1"><i class="fas fa-star me-1 text-warning"></i>' + expLine + '</p>' +
                        (t.specialization ? '<p class="text-muted small mb-0">' + escapeHtml(t.specialization) + '</p>' : '') +
                    '</div>' +
                '</div>' +
                '<div class="trainer-detail-section">' +
                    '<h6>Assigned classes</h6>' +
                    classesHtml +
                '</div>' +
                '<div class="trainer-detail-section">' +
                    '<h6>Weekly availability</h6>' +
                    availHtml +
                '</div>';

            var m = getTrainerDetailModal();
            if (m) m.show();
        })
        .catch(function(err) {
            body.innerHTML = '<p class="text-danger mb-0">Could not load trainer.</p>';
            console.error(err);
        });
}

function loadTrainers() {
    var grid = $('trainersGrid');
    grid.innerHTML = '<div class="col-12 text-center text-muted py-4">Loading trainers…</div>';

    db.collection('trainers').where('approvalStatus', '==', 'approved').get().then(function(snap) {
        grid.innerHTML = '';
        if (snap.empty) {
            grid.innerHTML = '<div class="col-12 text-center text-muted py-4">No trainers available yet</div>';
            return;
        }
        snap.forEach(function(doc) {
            var tid = doc.id;
            var t = doc.data();
            var label = (t.displayName || t.email || 'Trainer').trim();
            var initials = (label || 'T').split(' ').map(function(w) { return w[0]; }).join('').substring(0, 2).toUpperCase();
            var hasPhoto = t.photoURL && /^https?:\/\//i.test(String(t.photoURL).trim());
            var avatar = hasPhoto
                ? '<div class="trainer-avatar"><img src="' + escapeAttrUrl(String(t.photoURL).trim()) + '" alt="' + escapeHtml(label) + '" onerror="this.parentNode.textContent=\'' + escapeJsString(initials) + '\'"></div>'
                : '<div class="trainer-avatar">' + escapeHtml(initials) + '</div>';
            var bio = (t.bio || '').trim();
            if (bio.length > 90) bio = bio.substring(0, 90) + '…';
            var col = document.createElement('div');
            col.className = 'col-6 col-md-4 col-lg-3';
            var card = document.createElement('div');
            card.className = 'dash-card trainer-browse-card trainer-card-clickable h-100';
            card.setAttribute('role', 'button');
            card.tabIndex = 0;
            card.setAttribute('data-trainer-id', tid);
            card.setAttribute('aria-label', 'View details for ' + label);
            var body = document.createElement('div');
            body.className = 'card-body text-center';
            body.innerHTML =
                avatar +
                '<h6 class="text-white fw-bold trainer-browse-title">' + escapeHtml(label) + '</h6>' +
                '<span class="badge bg-info mb-1">' + escapeHtml(t.specialization || 'General') + '</span>' +
                '<p class="trainer-browse-meta mb-1">' + (t.experience || 0) + ' yrs experience</p>' +
                '<p class="trainer-browse-bio text-muted mb-0">' + escapeHtml(bio || '—') + '</p>';
            card.appendChild(body);
            col.appendChild(card);
            grid.appendChild(col);
        });
    });
}

$('btnRefreshTrainers').addEventListener('click', loadTrainers);

var trainersGridEl = $('trainersGrid');
if (trainersGridEl) {
    trainersGridEl.addEventListener('click', function(e) {
        var card = e.target.closest('.trainer-card-clickable');
        if (!card || !card.dataset.trainerId) return;
        openTrainerDetailModal(card.dataset.trainerId);
    });
    trainersGridEl.addEventListener('keydown', function(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var card = e.target.closest('.trainer-card-clickable');
        if (!card || !card.dataset.trainerId) return;
        e.preventDefault();
        openTrainerDetailModal(card.dataset.trainerId);
    });
}

var btnOpenBookSession = $('btnOpenBookSession');
if (btnOpenBookSession) {
    btnOpenBookSession.addEventListener('click', function() {
        if (!currentTrainerDetailId) return;
        var detailEl = $('trainerDetailModal');
        var bookEl = $('trainerBookSessionModal');
        var tbsTrainerId = $('tbsTrainerId');
        var tbsTrainerLabel = $('tbsTrainerLabel');
        var tbsDate = $('tbsDate');
        var tbsTime = $('tbsTime');
        var tbsReason = $('tbsReason');
        var tbsAlert = $('tbsAlert');
        if (!detailEl || !bookEl || !tbsTrainerId || !tbsTrainerLabel) return;

        tbsTrainerId.value = currentTrainerDetailId;
        tbsTrainerLabel.textContent = 'Session with ' + currentTrainerDetailName;
        var today = new Date().toISOString().split('T')[0];
        tbsDate.min = today;
        tbsDate.value = '';
        if (tbsTime) tbsTime.value = '';
        var tbsDur = $('tbsDuration');
        if (tbsDur) tbsDur.value = '60';
        if (tbsReason) tbsReason.value = '';
        if (tbsAlert) {
            tbsAlert.classList.add('d-none');
            tbsAlert.textContent = '';
        }

        function afterHidden() {
            detailEl.removeEventListener('hidden.bs.modal', afterHidden);
            if (window.bootstrap && bookEl) {
                bootstrap.Modal.getOrCreateInstance(bookEl).show();
            }
        }
        detailEl.addEventListener('hidden.bs.modal', afterHidden);
        var dm = bootstrap.Modal.getInstance(detailEl);
        if (dm) dm.hide();
        else afterHidden();
    });
}

var btnSubmitSessionRequest = $('btnSubmitSessionRequest');
if (btnSubmitSessionRequest) {
    btnSubmitSessionRequest.addEventListener('click', function() {
        var tid = $('tbsTrainerId') && $('tbsTrainerId').value;
        var dateEl = $('tbsDate');
        var timeEl = $('tbsTime');
        var reasonEl = $('tbsReason');
        var tbsAlert = $('tbsAlert');
        var date = dateEl ? dateEl.value : '';
        var time = timeEl ? timeEl.value : '';
        var durEl = $('tbsDuration');
        var durationMin = durEl ? parseInt(durEl.value, 10) : NaN;
        var reason = reasonEl ? String(reasonEl.value || '').trim() : '';

        if (!tid || !date || !time || !reason) {
            if (tbsAlert) {
                tbsAlert.className = 'alert alert-danger py-2 small';
                tbsAlert.textContent = 'Please fill in date, time, and why you want this session.';
                tbsAlert.classList.remove('d-none');
            }
            return;
        }
        if (isNaN(durationMin) || durationMin < 15 || durationMin > 300) {
            if (tbsAlert) {
                tbsAlert.className = 'alert alert-danger py-2 small';
                tbsAlert.textContent = 'Please choose a duration between 15 and 300 minutes.';
                tbsAlert.classList.remove('d-none');
            }
            return;
        }

        btnSubmitSessionRequest.disabled = true;
        db.collection('trainerSessionRequests').add({
            memberId: currentUid,
            memberName: memberData && memberData.displayName ? memberData.displayName : (currentUser && currentUser.email),
            memberEmail: currentUser && currentUser.email,
            trainerId: tid,
            trainerName: currentTrainerDetailName,
            preferredDate: date,
            preferredTime: time,
            preferredDurationMinutes: durationMin,
            reason: reason,
            status: 'pending',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }).then(function() {
            var bm = $('trainerBookSessionModal') && bootstrap.Modal.getInstance($('trainerBookSessionModal'));
            if (bm) bm.hide();
            alert('Your session request was submitted. The trainer will get back to you.');
        }).catch(function(err) {
            if (tbsAlert) {
                tbsAlert.className = 'alert alert-danger py-2 small';
                tbsAlert.textContent = err.message || 'Could not submit request.';
                tbsAlert.classList.remove('d-none');
            }
        }).then(function() {
            btnSubmitSessionRequest.disabled = false;
        });
    });
}

/** Booking `date` is YYYY-MM-DD (local calendar day). */
function formatBookingDateWithWeekday(isoDate) {
    var d = parseISODateLocal(isoDate);
    if (!d) return (isoDate && String(isoDate).trim()) ? String(isoDate).trim() : '\u2014';
    return d.toLocaleDateString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

/** Two-line cell: weekday + calendar date, then session time */
function formatBookingWhenCellHtml(isoDate, timeStr) {
    var dateTxt = formatBookingDateWithWeekday(isoDate);
    var t = timeStr && String(timeStr).trim();
    var timeTxt = t || '\u2014';
    return (
        '<span class="booking-when-date d-block">' +
        escapeHtml(dateTxt) +
        '</span><span class="booking-when-time d-block">' +
        escapeHtml(timeTxt) +
        '</span>'
    );
}

/* ═══════════════════════════════════════
   BOOKINGS
   ═══════════════════════════════════════ */
function loadBookings() {
    var tbody = $('bookingsBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Loading…</td></tr>';

    db.collection('bookings').where('memberId', '==', currentUid).get()
        .then(function(snap) {
            var rows = [];
            snap.forEach(function(doc) {
                rows.push({ id: doc.id, data: doc.data() });
            });
            rows.sort(function(a, b) {
                return bookingCreatedMs(b.data) - bookingCreatedMs(a.data);
            });

            tbody.innerHTML = '';
            if (!rows.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No bookings yet. Browse classes to book!</td></tr>';
                return;
            }
            rows.forEach(function(row) {
                var b = row.data;
                var statusColors = { confirmed: 'success', cancelled: 'secondary', completed: 'info' };
                var refDisplay = b.bookingCode != null && b.bookingCode !== ''
                    ? escapeHtml(String(b.bookingCode))
                    : '<span class="text-muted">—</span>';
                var codeRaw = (b.bookingCode != null && b.bookingCode !== '') ? String(b.bookingCode) : '';

                var tr = document.createElement('tr');
                if (codeRaw) {
                    tr.classList.add('bookings-row-clickable');
                    tr.setAttribute('data-booking-code', codeRaw);
                    tr.setAttribute('data-booking-id', row.id);
                    tr.setAttribute('data-member-id', (b.memberId || currentUid || '').trim());
                    tr.setAttribute('data-booking-class', b.className || '');
                    tr.setAttribute('data-booking-date', b.date || '');
                    tr.setAttribute('data-booking-time', b.time || '');
                    tr.tabIndex = 0;
                    tr.setAttribute('role', 'button');
                    tr.setAttribute('aria-label', 'Show QR code for booking reference ' + codeRaw);
                }

                var actionsHtml = '—';
                if (b.status === 'confirmed') {
                    if (b.sessionStarted === true) {
                        actionsHtml =
                            '<span class="small text-success"><i class="fas fa-check-circle me-1"></i>Completed</span>';
                    } else {
                        actionsHtml =
                            '<button type="button" class="btn btn-sm btn-outline-danger btn-cancel-booking" data-booking-id="' +
                            escapeHtml(row.id) + '" data-booking-class="' + escapeHtml(b.className || '') +
                            '"><i class="fas fa-times me-1"></i>Cancel</button>';
                    }
                } else if (b.status === 'cancelled') {
                    actionsHtml =
                        '<button type="button" class="btn btn-sm btn-outline-secondary btn-delete-cancelled-booking" data-booking-id="' +
                        escapeHtml(row.id) + '" data-booking-class="' + escapeHtml(b.className || '') +
                        '" title="Remove from your list"><i class="fas fa-trash-alt me-1"></i>Delete</button>';
                }

                var classCell = escapeHtml(b.className || '—');
                if (b.durationMinutes != null && !isNaN(Number(b.durationMinutes))) {
                    classCell +=
                        ' <span class="text-muted small">(' +
                        escapeHtml(String(b.durationMinutes)) +
                        ' min)</span>';
                }

                tr.innerHTML =
                    '<td class="fw-semibold">' + refDisplay + '</td>' +
                    '<td>' + classCell + '</td>' +
                    '<td>' + escapeHtml(b.trainerName || '—') + '</td>' +
                    '<td class="booking-when">' + formatBookingWhenCellHtml(b.date, b.time) + '</td>' +
                    '<td><span class="badge bg-' + (statusColors[b.status] || 'secondary') + '">' + escapeHtml(b.status || '—') + '</span></td>' +
                    '<td>' + actionsHtml + '</td>';
                tbody.appendChild(tr);
            });
        })
        .catch(function(err) {
            console.error(err);
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Could not load bookings.</td></tr>';
        });
}

window.cancelBooking = function(bookingId, meta) {
    meta = meta || {};
    if (!bookingId) return;
    if (!confirm('Cancel this booking?')) return;

    var bref = db.collection('bookings').doc(bookingId);

    db.runTransaction(function(transaction) {
        return transaction.get(bref).then(function(bsnap) {
            if (!bsnap.exists) throw new Error('Booking not found.');
            var b = bsnap.data();
            if (b.memberId !== currentUid) throw new Error('Permission denied.');
            if ((b.status || '') !== 'confirmed') throw new Error('This booking is already cancelled.');

            var cid = (b.classId || '').trim();
            if (!cid) {
                transaction.update(bref, { status: 'cancelled' });
                return;
            }
            var cref = db.collection('classes').doc(cid);
            var bdate = (b.date || '').trim();
            var sref = db.collection('classSessionEnrolled').doc(classSessionEnrolledDocId(cid, bdate));
            return transaction.get(cref).then(function() {
                return transaction.get(sref).then(function(ssnap) {
                    transaction.update(bref, { status: 'cancelled' });
                    if (ssnap.exists) {
                        var se = ssnap.data().enrolled != null ? ssnap.data().enrolled : 0;
                        if (se > 0) {
                            transaction.update(sref, {
                                enrolled: firebase.firestore.FieldValue.increment(-1)
                            });
                        }
                    }
                });
            });
        });
    })
        .then(function() {
            loadBookings();
            loadClasses();
            if (typeof window.showBookingCancelledConfirmation === 'function') {
                window.showBookingCancelledConfirmation({ className: meta.className || '' });
            }
        })
        .catch(function(err) { alert(err.message || 'Could not cancel booking.'); });
};

window.deleteCancelledBooking = function(bookingId) {
    if (!bookingId) return;
    if (!confirm('Remove this cancelled booking from your list? This cannot be undone.')) return;

    db.collection('bookings').doc(bookingId).get().then(function(doc) {
        if (!doc.exists) throw new Error('Booking not found.');
        var d = doc.data();
        if (d.memberId !== currentUid) throw new Error('Permission denied.');
        if ((d.status || '') !== 'cancelled') throw new Error('Only cancelled bookings can be removed.');
        if (d.sessionStarted === true) throw new Error('This booking cannot be deleted after the session was started.');
        var code = d.bookingCode;
        var ops = [db.collection('bookings').doc(bookingId).delete()];
        if (code != null && code !== '') {
            ops.push(db.collection('bookingLookups').doc(String(code)).delete());
        }
        return Promise.all(ops);
    })
        .then(function() {
            loadBookings();
        })
        .catch(function(err) { alert(err.message || 'Could not delete booking.'); });
};

$('btnRefreshBookings').addEventListener('click', loadBookings);

(function bindBookingsTableInteractions() {
    var tbody = $('bookingsBody');
    if (!tbody) return;

    tbody.addEventListener('click', function(e) {
        var delBtn = e.target.closest('.btn-delete-cancelled-booking');
        if (delBtn) {
            e.stopPropagation();
            var did = delBtn.getAttribute('data-booking-id');
            if (did) window.deleteCancelledBooking(did);
            return;
        }
        var cancelBtn = e.target.closest('.btn-cancel-booking');
        if (cancelBtn) {
            e.stopPropagation();
            var bid = cancelBtn.getAttribute('data-booking-id');
            var bcls = cancelBtn.getAttribute('data-booking-class') || '';
            if (bid) window.cancelBooking(bid, { className: bcls });
            return;
        }
        var tr = e.target.closest('tr.bookings-row-clickable');
        if (!tr || typeof window.showBookingConfirmation !== 'function') return;
        var code = tr.getAttribute('data-booking-code');
        if (!code) return;
        var bid = tr.getAttribute('data-booking-id') || '';
        var mid = tr.getAttribute('data-member-id') || '';
        window.showBookingConfirmation(code, {
            className: tr.getAttribute('data-booking-class') || '',
            date: tr.getAttribute('data-booking-date') || '',
            time: tr.getAttribute('data-booking-time') || '',
            memberId: mid || undefined,
            bookingId: bid || undefined
        });
    });

    tbody.addEventListener('keydown', function(e) {
        var tr = e.target.closest('tr.bookings-row-clickable');
        if (!tr || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        if (typeof window.showBookingConfirmation !== 'function') return;
        var code = tr.getAttribute('data-booking-code');
        if (!code) return;
        var bid = tr.getAttribute('data-booking-id') || '';
        var mid = tr.getAttribute('data-member-id') || '';
        window.showBookingConfirmation(code, {
            className: tr.getAttribute('data-booking-class') || '',
            date: tr.getAttribute('data-booking-date') || '',
            time: tr.getAttribute('data-booking-time') || '',
            memberId: mid || undefined,
            bookingId: bid || undefined
        });
    });
})();
