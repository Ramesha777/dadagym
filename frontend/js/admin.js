/* ═══════════════════════════════════════
   DaDaGym — Admin dashboard (card-grid + modals)
   ═══════════════════════════════════════ */

import { firebaseConfig } from './firebase-config.js';
import { isMemberPlanActive } from './membership-utils.js';
import { ensureGymPublicId, isValidGymPublicId } from './gym-public-id.js';
import { openIDCardModal } from './IDCard.js';
import { parseGymBookingCheckinRaw } from './booking-checkin-parse.js';

firebase.initializeApp(firebaseConfig);

var auth = firebase.auth();
var db   = firebase.firestore();
var rtdb = firebase.database();
var $ = function(id) { return document.getElementById(id); };

var currentUid = null;
var currentUser = null;
var chatMessagesUnsub = null;
var approvedTrainerNames = {};

var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/* ─── Caches for grids (used for search/filter and modal lookup) ─── */
var allMembersCache = [];
var allMembersById = {};
var allTrainersCache = [];
var allTrainersById = {};
var allClassesCache = [];
var allClassesById = {};

var adminClassLogWeekOffset = 0;


var memberDetailModalInstance = null;
var trainerDetailModalInstance = null;
var classDetailModalInstance = null;
var currentMemberDetailId = null;
var currentTrainerDetailId = null;
var currentClassDetailId = null;

var adminHtml5QrCode = null;

/* ─── Helpers ─── */
function escHtml(s) {
    if (s == null || s === '') return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function tsSeconds(ts) {
    if (!ts) return 0;
    if (typeof ts.seconds === 'number') return ts.seconds;
    if (ts.toMillis) return Math.floor(ts.toMillis() / 1000);
    return 0;
}

function tsToDate(ts) {
    if (!ts) return null;
    if (typeof ts.toDate === 'function') {
        try { return ts.toDate(); } catch (e) { /* ignore */ }
    }
    if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000);
    if (typeof ts === 'number') return new Date(ts);
    if (typeof ts === 'string') {
        var d = new Date(ts);
        if (!isNaN(d.getTime())) return d;
    }
    return null;
}

function formatDate(ts) {
    var d = tsToDate(ts);
    if (!d) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(ts) {
    var d = tsToDate(ts);
    if (!d) return '\u2014';
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function adminCurrencySym(code) {
    if (code === 'USD') return '$';
    if (code === 'EUR') return '\u20AC';
    return '\u00A3';
}

function adminFmtMoney(code, n) {
    var sym = adminCurrencySym(code || 'GBP');
    var v = typeof n === 'number' && !isNaN(n) ? n : 0;
    return sym + v.toFixed(2);
}

function getInitials(name, fallback) {
    var src = (name && String(name).trim()) || fallback || '';
    if (!src) return '?';
    return src.split(/\s+/).map(function(w) { return w[0]; }).join('').substring(0, 2).toUpperCase();
}

function avatarHtml(name, email, photoURL, sizeClass) {
    var initials = getInitials(name, email);
    var cls = 'user-avatar' + (sizeClass ? ' ' + sizeClass : '');
    if (photoURL && /^https?:\/\//i.test(photoURL)) {
        return '<div class="' + cls + '">' +
            '<img src="' + escHtml(photoURL) + '" alt="' + escHtml(name || 'avatar') + '" ' +
            'onerror="this.parentNode.textContent=\'' + initials + '\'"></div>';
    }
    return '<div class="' + cls + '">' + initials + '</div>';
}

function bigAvatarInto(boxId, initialsId, name, email, photoURL) {
    var box = $(boxId);
    var ini = $(initialsId);
    if (!box || !ini) return;
    var initials = getInitials(name, email);
    ini.textContent = initials;
    var existing = box.querySelector('img');
    if (existing) existing.remove();
    if (photoURL && /^https?:\/\//i.test(photoURL)) {
        var img = document.createElement('img');
        img.alt = name || 'avatar';
        img.src = photoURL;
        ini.style.display = 'none';
        img.onerror = function() {
            img.remove();
            ini.style.display = '';
        };
        box.appendChild(img);
    } else {
        ini.style.display = '';
    }
}

function refreshAdminGymPublicIdUi(gymPid) {
    var idEl = $('adminGymPublicId');
    if (!idEl) return;
    if (gymPid && isValidGymPublicId(gymPid)) {
        idEl.textContent = 'Admin ID · ' + gymPid;
        idEl.classList.remove('d-none');
    } else {
        idEl.textContent = '';
        idEl.classList.add('d-none');
    }
}

/* ─── Auth + boot ─── */
function syncAdminSidebarFooterName(user) {
    var el = $('adminEmail');
    if (!el || !user) return;

    db.collection('users')
        .doc(user.uid)
        .get()
        .then(function(uDoc) {
            var nm = '';
            var ud = uDoc.exists ? uDoc.data() : {};
            if (uDoc.exists) {
                if (ud.displayName && String(ud.displayName).trim()) {
                    nm = String(ud.displayName).trim();
                }
            }
            if (!nm && user.displayName && String(user.displayName).trim()) {
                nm = String(user.displayName).trim();
            }
            if (!nm && user.email && user.email.indexOf('@') > 0) {
                nm = user.email.split('@')[0];
            }
            if (!nm) nm = 'Admin';
            el.textContent = nm;
            if (user.email) el.title = user.email;
            else el.removeAttribute('title');

            var existingPid = ud.gymPublicId && isValidGymPublicId(ud.gymPublicId) ? ud.gymPublicId : '';
            refreshAdminGymPublicIdUi(existingPid);
            if (!existingPid && user.email) {
                ensureGymPublicId(db, user.uid, user.email, 'admin')
                    .then(function(newPid) {
                        if (newPid) refreshAdminGymPublicIdUi(newPid);
                    })
                    .catch(function(err) {
                        console.warn('Gym public ID:', err && err.message ? err.message : err);
                    });
            }
        })
        .catch(function() {
            var nm =
                user.displayName && String(user.displayName).trim()
                    ? String(user.displayName).trim()
                    : '';
            if (!nm && user.email && user.email.indexOf('@') > 0) nm = user.email.split('@')[0];
            el.textContent = nm || 'Admin';
            if (user.email) el.title = user.email;
            refreshAdminGymPublicIdUi('');
            if (user.email) {
                ensureGymPublicId(db, user.uid, user.email, 'admin')
                    .then(function(newPid) {
                        if (newPid) refreshAdminGymPublicIdUi(newPid);
                    })
                    .catch(function() {});
            }
        });
}

function showDashboard(user) {
    $('loadingGate').style.display = 'none';
    $('mainContent').style.display = 'block';
    syncAdminSidebarFooterName(user);
    loadOverviewStats();
    loadAllMembers();
    loadTrainerApplications();
    loadClassesAdmin();
    populateTrainerSelect();
}

function ensureAdmin(user) {
    var uid = user.uid;
    return db.collection('admins').doc(uid).get().then(function(d) {
        if (d.exists) return true;
        return db.collection('users').doc(uid).get().then(function(u) {
            return u.exists && u.data().role === 'admin';
        });
    });
}

auth.onAuthStateChanged(function(user) {
    if (!user || !user.emailVerified) {
        window.location.href = 'login.html';
        return;
    }
    currentUid = user.uid;
    currentUser = user;
    ensureAdmin(user).then(function(ok) {
        if (!ok) {
            window.location.href = 'login.html';
            return;
        }
        showDashboard(user);
    }).catch(function() {
        window.location.href = 'login.html';
    });
});

function doAdminLogout() {
    auth.signOut().then(function() {
        window.location.href = 'login.html';
    });
}

if ($('btnLogout')) {
    $('btnLogout').addEventListener('click', function() {
        var modalEl = $('logoutConfirmModal');
        if (!modalEl || typeof bootstrap === 'undefined') {
            if (window.confirm('Are you sure you want to log out?')) doAdminLogout();
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
        doAdminLogout();
    });
}

if ($('btnGenerateAdminIdCard')) {
    $('btnGenerateAdminIdCard').addEventListener('click', function() {
        if (!currentUser) return;
        db.collection('users')
            .doc(currentUser.uid)
            .get()
            .then(function(uDoc) {
                var ud = uDoc.exists ? uDoc.data() : {};
                var nm =
                    (ud.displayName && String(ud.displayName).trim()) ||
                    (currentUser.displayName && String(currentUser.displayName).trim()) ||
                    '';
                if (!nm && currentUser.email) nm = currentUser.email.split('@')[0];
                if (!nm) nm = 'Admin';
                var pid =
                    ud.gymPublicId && isValidGymPublicId(ud.gymPublicId) ? ud.gymPublicId : '';
                openIDCardModal({
                    name: nm,
                    role: 'admin',
                    joinDate: ud.createdAt || null,
                    photoURL:
                        (ud.photoURL && String(ud.photoURL).trim()) ||
                        (currentUser.photoURL || '') ||
                        '',
                    firebaseUid: currentUser.uid,
                    gymPublicId: pid,
                    phone: (ud.phone && String(ud.phone).trim()) || '',
                    gymLocation: 'RA1 2SU, 7 Krishal Road',
                    gymWebsiteUrl: 'https://dadagym.netlify.app',
                    gymWebsiteLabel: 'dadagym.netlify.app'
                });
            })
            .catch(function() {
                openIDCardModal({
                    name: currentUser.displayName || (currentUser.email || 'Admin').split('@')[0],
                    role: 'admin',
                    joinDate: null,
                    photoURL: currentUser.photoURL || '',
                    firebaseUid: currentUser.uid,
                    phone: '',
                    gymLocation: 'RA1 2SU, 7 Krishal Road',
                    gymWebsiteUrl: 'https://dadagym.netlify.app',
                    gymWebsiteLabel: 'dadagym.netlify.app'
                });
            });
    });
}

/* ─── Sidebar ─── */
var sidebarLinks = document.querySelectorAll('.sidebar-nav a[data-section]');
var sections = document.querySelectorAll('.admin-section');
var titles = {

    overview: '<i class="fas fa-chart-pie me-2 text-info"></i>Dashboard',

    members: '<i class="fas fa-users me-2"></i>All Members',

    trainers: '<i class="fas fa-chalkboard-teacher me-2"></i>Trainer Applications',

    trainerAvail: '<i class="fas fa-calendar-check me-2"></i>Trainer Schedules',

    classTracking: '<i class="fas fa-clipboard-check me-2"></i>Weekly class log',

    classes: '<i class="fas fa-dumbbell me-2"></i>Classes',

    checkin: '<i class="fas fa-qrcode me-2"></i>Booking check-in',

    chat: '<i class="fas fa-comments me-2"></i>Chat',

    contactMessages: '<i class="fas fa-envelope-open-text me-2"></i>Contact messages',

    punchDetail: '<i class="fas fa-list-alt me-2"></i>Punch log',

    punchHours: '<i class="fas fa-user-clock me-2"></i>Hours tracking'

};

sidebarLinks.forEach(function(link) {
    link.addEventListener('click', function(e) {
        var sec = this.getAttribute('data-section');
        if (!sec) return;
        e.preventDefault();
        switchSection(sec);
        closeSidebar();
    });
});

function switchSection(name) {
    if (name !== 'checkin') stopAdminQrScanner();
    sidebarLinks.forEach(function(a) { a.classList.remove('active'); });
    sections.forEach(function(s) { s.classList.remove('active'); });
    var lnk = document.querySelector('.sidebar-nav a[data-section="' + name + '"]');
    if (lnk) lnk.classList.add('active');
    var sec = $('sec-' + name);
    if (sec) sec.classList.add('active');
    if ($('topbarTitle')) $('topbarTitle').innerHTML = titles[name] || name;

    if (name === 'trainerAvail') loadTrainerAvailability();
    if (name === 'classTracking') {
        populateAdminClassLogTrainerFilter();
        loadAdminTrainerClassTracking();
    }

    if (name === 'classes') loadClassesAdmin();
    if (name === 'chat') loadAdminChatTrainers();
    if (name === 'contactMessages') loadContactMessages();
    if (name === 'punchDetail') loadAdminPunchAttendance(false);
    if (name === 'punchHours') loadAdminPunchHoursView(false);
}

var sidebar = $('sidebar');
var overlay = $('sidebarOverlay');
if ($('menuToggleAdmin')) {
    $('menuToggleAdmin').addEventListener('click', function() {
        sidebar.classList.add('open');
        overlay.classList.add('open');
    });
}
function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
}
if ($('sidebarClose')) $('sidebarClose').addEventListener('click', closeSidebar);
if (overlay) overlay.addEventListener('click', closeSidebar);

/* ─── Firestore: ordered fetch w/ fallback ─── */
function fetchMembersOrdered() {
    return db.collection('members').orderBy('createdAt', 'desc').get()
        .catch(function() { return db.collection('members').get(); })
        .then(function(snap) {
            var rows = [];
            snap.forEach(function(d) { rows.push(d); });
            rows.sort(function(a, b) { return tsSeconds(b.data().createdAt) - tsSeconds(a.data().createdAt); });
            return rows;
        });
}

function fetchTrainersOrdered() {
    return db.collection('trainers').orderBy('createdAt', 'desc').get()
        .catch(function() { return db.collection('trainers').get(); })
        .then(function(snap) {
            var rows = [];
            snap.forEach(function(d) { rows.push(d); });
            rows.sort(function(a, b) { return tsSeconds(b.data().createdAt) - tsSeconds(a.data().createdAt); });
            return rows;
        });
}

/* ─── Overview stats + recent pending trainer apps ─── */
function loadOverviewStats() {
    db.collection('members').get().then(function(snap) {
        if ($('statTotal')) $('statTotal').textContent = snap.size;
        var active = 0;
        snap.forEach(function(doc) {
            if (isMemberPlanActive(doc.data())) active++;
        });
        if ($('statActiveMembers')) $('statActiveMembers').textContent = active;
    });

    db.collection('trainers').get().then(function(snap) {
        var total = 0, approved = 0, pending = 0;
        snap.forEach(function(doc) {
            total++;
            var st = doc.data().approvalStatus || 'pending';
            if (st === 'approved') approved++;
            else if (st === 'pending') pending++;
        });
        if ($('statTrainers')) $('statTrainers').textContent = total;
        if ($('statApprovedTrainers')) $('statApprovedTrainers').textContent = approved;
        if ($('statPendingTrainers')) $('statPendingTrainers').textContent = pending;
    });

    db.collection('classes').get().then(function(snap) {
        if ($('statClasses')) $('statClasses').textContent = snap.size;
    }).catch(function() {
        if ($('statClasses')) $('statClasses').textContent = '0';
    });

    var grid = $('overviewPendingGrid');
    if (grid) {
    grid.innerHTML = '<div class="col-12 text-center text-muted py-4">Loading…</div>';

    db.collection('trainers').where('approvalStatus', '==', 'pending').get()
        .then(function(snap) {
            var rows = [];
            snap.forEach(function(doc) {
                var item = { id: doc.id, data: doc.data() };
                rows.push(item);
                allTrainersById[doc.id] = item;
            });
            rows.sort(function(a, b) { return tsSeconds(b.data.createdAt) - tsSeconds(a.data.createdAt); });
            var top = rows.slice(0, 12);

            if ($('overviewPendingCount')) {
                $('overviewPendingCount').textContent = '(' + rows.length + ')';
            }

            grid.innerHTML = '';
            if (!top.length) {
                grid.innerHTML = '<div class="col-12 text-center text-muted py-4">No pending trainer applications</div>';
                return;
            }

            top.forEach(function(item) {
                var d = item.data;
                var name = d.displayName || '—';
                var initials = getInitials(name, d.email);
                var hasPhoto = d.photoURL && /^https?:\/\//i.test(d.photoURL);
                var avatar = hasPhoto
                    ? '<div class="trainer-avatar"><img src="' + escHtml(d.photoURL) + '" alt="' + escHtml(name) + '" onerror="this.parentNode.textContent=\'' + initials + '\'"></div>'
                    : '<div class="trainer-avatar">' + initials + '</div>';

                var col = document.createElement('div');
                col.className = 'col-6 col-sm-4 col-md-3 col-lg-2';
                col.innerHTML =
                    '<div class="dash-card h-100 member-card" tabindex="0" data-id="' + item.id + '">' +
                        '<div class="card-body text-center">' +
                            avatar +
                            '<h6 class="text-white fw-bold mt-2 mb-1">' + escHtml(name) + '</h6>' +
                            '<span class="badge bg-info">' + escHtml(d.specialization || '—') + '</span>' +
                            '<div class="mt-1"><span class="badge bg-warning">Pending</span></div>' +
                        '</div>' +
                    '</div>';
                var card = col.querySelector('.member-card');
                card.addEventListener('click', function() { openTrainerDetailModal(item.id); });
                card.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openTrainerDetailModal(item.id);
                    }
                });
                grid.appendChild(col);
            });
        })
        .catch(function() {
            grid.innerHTML = '<div class="col-12 text-center text-danger py-4">Could not load pending trainers.</div>';
        });
    }

    loadOverviewClassTrainerRequests();
    loadOverviewMembershipRevenue();
    loadOverviewRefundRequests();
    loadOverviewAccountDeletionRequests();
}

/** Sum membership ledger entries: gross counts plan face value (card + applied credit); refunds subtract cash-outs. */
function aggregateMembershipLedgerSnaps(snapsArray) {
    var gross = 0;
    var refunds = 0;
    var cur = 'GBP';
    snapsArray.forEach(function(snap) {
        if (!snap || !snap.forEach) return;
        snap.forEach(function(doc) {
            var r = doc.data();
            var t = r.type || '';
            if (t === 'purchase' || t === 'plan_change') {
                var charged =
                    typeof r.amountCharged === 'number' && !isNaN(r.amountCharged) ? r.amountCharged : 0;
                var cred =
                    typeof r.creditUsed === 'number' && !isNaN(r.creditUsed)
                        ? Math.max(0, r.creditUsed)
                        : 0;
                var line = +(charged + cred).toFixed(2);
                gross += line;
                if (r.refundChoice === 'refund' && typeof r.refundOrCreditAmount === 'number') {
                    refunds += r.refundOrCreditAmount;
                }
                if (r.currency && typeof r.currency === 'string' && line > 0) {
                    cur = r.currency.trim() || cur;
                }
            }
            if (t === 'admin_refund_approved' && typeof r.refundOrCreditAmount === 'number') {
                refunds += r.refundOrCreditAmount;
                if (r.currency && typeof r.currency === 'string') cur = r.currency.trim() || cur;
            }
        });
    });
    return {
        gross: +gross.toFixed(2),
        refunds: +refunds.toFixed(2),
        currency: cur
    };
}

function applyMembershipRevenueTotals(totals) {
    var netEl = $('statNetRevenue');
    var grossEl = $('statGrossRevenue');
    var refEl = $('statRefundsTotal');
    if (!netEl && !grossEl && !refEl) return;
    var net = Math.max(0, +(totals.gross - totals.refunds).toFixed(2));
    var cur = totals.currency || 'GBP';
    if (grossEl) grossEl.textContent = adminFmtMoney(cur, totals.gross);
    if (refEl) refEl.textContent = adminFmtMoney(cur, totals.refunds);
    if (netEl) netEl.textContent = adminFmtMoney(cur, net);
}

/** When collection-group queries fail (indexes / hosting), aggregate each member\u2019s subcollection — admin rule allows reads. */
function fetchMembershipPurchasesViaMembers() {
    return db
        .collection('members')
        .get()
        .then(function(membersSnap) {
            var tasks = [];
            membersSnap.forEach(function(m) {
                tasks.push(db.collection('members').doc(m.id).collection('membershipPurchases').get());
            });
            return Promise.all(tasks);
        });
}

function loadOverviewMembershipRevenue() {
    var netEl = $('statNetRevenue');
    if (!netEl && !$('statGrossRevenue') && !$('statRefundsTotal')) return;

    db.collectionGroup('membershipPurchases')
        .get()
        .then(function(snap) {
            applyMembershipRevenueTotals(aggregateMembershipLedgerSnaps([snap]));
        })
        .catch(function(err) {
            console.warn('membershipPurchases collectionGroup failed; retrying via members/*/membershipPurchases.', err);
            return fetchMembershipPurchasesViaMembers().then(function(snapsList) {
                applyMembershipRevenueTotals(aggregateMembershipLedgerSnaps(snapsList));
            });
        })
        .catch(function(err2) {
            console.error(err2);
            var dash = '\u2014';
            if ($('statGrossRevenue')) $('statGrossRevenue').textContent = dash;
            if ($('statRefundsTotal')) $('statRefundsTotal').textContent = dash;
            if ($('statNetRevenue')) $('statNetRevenue').textContent = dash;
        });
}

function loadOverviewRefundRequests() {
    var tbody = $('overviewRefundsBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">Loading\u2026</td></tr>';

    db.collection('refundRequests').get()
        .then(function(snap) {
            var rows = [];
            snap.forEach(function(doc) {
                rows.push({ id: doc.id, d: doc.data() });
            });
            rows.sort(function(a, b) {
                return tsSeconds(b.d.createdAt) - tsSeconds(a.d.createdAt);
            });

            if ($('overviewRefundsCount')) {
                var pend = rows.filter(function(x) { return (x.d.status || '') === 'pending'; }).length;
                $('overviewRefundsCount').textContent = '(' + pend + ' pending)';
            }

            tbody.innerHTML = '';
            if (!rows.length) {
                tbody.innerHTML =
                    '<tr><td colspan="9" class="text-center text-muted">No refund requests yet.</td></tr>';
                return;
            }

            rows.forEach(function(row) {
                var d = row.d;
                var tr = document.createElement('tr');
                var sym = adminCurrencySym(d.currency || 'GBP');
                var when = formatDate(d.createdAt);
                var st = (d.status || 'pending').toLowerCase();
                var statusBadge =
                    st === 'approved'
                        ? '<span class="badge bg-success">Approved</span>'
                        : st === 'rejected'
                            ? '<span class="badge bg-secondary">Rejected</span>'
                            : '<span class="badge bg-warning text-dark">Pending</span>';
                var amt =
                    typeof d.amount === 'number' && !isNaN(d.amount)
                        ? sym + d.amount.toFixed(2)
                        : '\u2014';

                var src = (d.requestOrigin || '') === 'refund' ? 'Refund owing' : 'Account credit';
                var srcBadge =
                    (d.requestOrigin || '') === 'refund'
                        ? '<span class="badge bg-warning text-dark">' + escHtml(src) + '</span>'
                        : '<span class="badge bg-info">' + escHtml(src) + '</span>';
                var notesShort = (d.notes && String(d.notes).trim()) || '\u2014';
                var adminNote = (d.adminNote && String(d.adminNote).trim()) || '';
                var detail =
                    escHtml(notesShort.length > 120 ? notesShort.slice(0, 117) + '\u2026' : notesShort);
                if (adminNote) {
                    detail +=
                        '<div class="small text-muted mt-1"><strong>Admin:</strong> ' +
                        escHtml(adminNote.length > 160 ? adminNote.slice(0, 157) + '\u2026' : adminNote) +
                        '</div>';
                }

                var tdAct = document.createElement('td');
                tdAct.className = 'd-flex flex-wrap gap-1 align-items-center';
                if (st === 'pending') {
                    var ok = document.createElement('button');
                    ok.type = 'button';
                    ok.className = 'btn btn-sm btn-success';
                    ok.title =
                        (d.requestOrigin || '') === 'refund'
                            ? 'Approve payout (reduces refund owing)'
                            : 'Approve payout (reduces account credit)';
                    ok.innerHTML = '<i class="fas fa-check"></i>';
                    ok.addEventListener('click', function() {
                        approveRefundRequest(row.id, d);
                    });
                    var no = document.createElement('button');
                    no.type = 'button';
                    no.className = 'btn btn-sm btn-outline-danger';
                    no.title = 'Reject';
                    no.innerHTML = '<i class="fas fa-times"></i>';
                    no.addEventListener('click', function() {
                        rejectRefundRequest(row.id);
                    });
                    tdAct.appendChild(ok);
                    tdAct.appendChild(no);
                }
                var delRf = document.createElement('button');
                delRf.type = 'button';
                delRf.className = 'btn btn-sm btn-outline-secondary';
                delRf.title = 'Delete this request record';
                delRf.innerHTML = '<i class="fas fa-trash-alt"></i>';
                delRf.addEventListener('click', function() {
                    deleteRefundRequestAdmin(row.id);
                });
                tdAct.appendChild(delRf);

                tr.innerHTML =
                    '<td class="small">' + escHtml(when) + '</td>' +
                    '<td class="small font-monospace">' + escHtml(d.memberId || '\u2014') + '</td>' +
                    '<td>' + escHtml(d.memberName || '\u2014') + '</td>' +
                    '<td class="small">' + escHtml(d.memberEmail || '\u2014') + '</td>' +
                    '<td class="fw-semibold">' + escHtml(amt) + '</td>' +
                    '<td>' + srcBadge + '</td>' +
                    '<td class="small">' + detail + '</td>' +
                    '<td>' + statusBadge + '</td>';
                tr.appendChild(tdAct);
                tbody.appendChild(tr);
            });
        })
        .catch(function(err) {
            console.error(err);
            tbody.innerHTML =
                '<tr><td colspan="9" class="text-center text-danger">Could not load refund requests.</td></tr>';
        });
}

function approveRefundRequest(requestId, reqData) {
    if (!requestId || !reqData || !reqData.memberId) return;
    var amt = typeof reqData.amount === 'number' ? reqData.amount : 0;
    if (amt <= 0) return;
    var origin = reqData.requestOrigin === 'refund' ? 'refund' : 'credit';

    var confirmMsg =
        'Approve this payout for ' +
        adminFmtMoney(reqData.currency, amt) +
        '?\n\n' +
        (origin === 'refund'
            ? 'SOURCE: refund owing (plan change).\nMembership credit will stay the same unless you change it elsewhere;\nthe REFUND owing amount decreases by this payout.'
            : 'SOURCE: account credit.\nAccount credit decreases by up to this amount.');

    if (!confirm(confirmMsg)) return;

    var adminNotePrompt = window.prompt('Optional admin note (stored on the request):', '');
    if (adminNotePrompt === null) return;

    var reqRef = db.collection('refundRequests').doc(requestId);

    db.runTransaction(function(tx) {
        return tx.get(reqRef).then(function(rs) {
            if (!rs.exists) throw new Error('Request not found');
            var rd = rs.data();
            if ((rd.status || 'pending') !== 'pending') throw new Error('This request was already handled');
            var memberIdLedger = rd.memberId;
            if (!memberIdLedger || memberIdLedger !== reqData.memberId) {
                throw new Error('Member mismatch');
            }
            var amtReq =
                typeof rd.amount === 'number'
                    ? rd.amount
                    : typeof reqData.amount === 'number'
                        ? reqData.amount
                        : amt;
            if (amtReq <= 0) throw new Error('Invalid amount on request');

            var originTx = rd.requestOrigin === 'refund' ? 'refund' : 'credit';

            var memRef = db.collection('members').doc(memberIdLedger);
            var ledgerRef = memRef.collection('membershipPurchases').doc();
            return tx.get(memRef).then(function(ms) {
                var md = ms.exists ? ms.data() : {};
                var credit = typeof md.planCredit === 'number' ? md.planCredit : 0;
                var lrOutstanding =
                    typeof md.lastRefundAmount === 'number' ? md.lastRefundAmount : 0;
                var cur = rd.currency || reqData.currency || md.planCurrency || 'GBP';

                var deduct = 0;
                var newCredit = credit;
                var newLastRefundAmt = lrOutstanding;
                var memUpdate = {};

                if (originTx === 'credit') {
                    if (amtReq > credit + 0.000001) {
                        throw new Error('Amount is higher than the member\'s credit. Reject this request.');
                    }
                    deduct = amtReq;
                    newCredit = Math.max(0, +(credit - deduct).toFixed(2));
                    memUpdate.planCredit = newCredit;
                } else {
                    if (amtReq > lrOutstanding + 0.000001) {
                        throw new Error('Amount exceeds refund owing. Reject this request.');
                    }
                    deduct = 0;
                    newLastRefundAmt = Math.max(0, +(lrOutstanding - amtReq).toFixed(2));
                    memUpdate.lastRefundAmount = newLastRefundAmt;
                    memUpdate.lastRefundAt = firebase.firestore.FieldValue.serverTimestamp();
                }

                var noteParts = [
                    originTx === 'credit'
                        ? 'Admin-approved payout from account credit.'
                        : 'Admin-approved payout from refund owing.',
                    'Member note: ' + (rd.notes || '')
                ];
                if (adminNotePrompt && String(adminNotePrompt).trim()) {
                    noteParts.push('Admin: ' + String(adminNotePrompt).trim());
                }
                if (originTx === 'credit' && deduct < amtReq) {
                    noteParts.push(
                        'Credit deducted ' +
                            adminFmtMoney(cur, deduct) +
                            ' of ' +
                            adminFmtMoney(cur, amtReq)
                    );
                }

                tx.update(memRef, memUpdate);

                tx.set(ledgerRef, {
                    memberId: memberIdLedger,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    type: 'admin_refund_approved',
                    planId: md.planId || '',
                    planName: md.plan || '',
                    period: md.planPeriod || '',
                    currency: cur,
                    amountCharged: 0,
                    refundOrCreditAmount: amtReq,
                    adminRefundedAmount: amtReq,
                    refundChoice: 'refund',
                    requestOriginSnapshot: originTx,
                    planCreditAfter: newCredit,
                    creditDeducted: originTx === 'credit' ? deduct : 0,
                    refundRequestId: requestId,
                    note: noteParts.join(' ')
                });

                tx.update(reqRef, {
                    status: 'approved',
                    reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    reviewedByUid: currentUid,
                    adminNote:
                        adminNotePrompt && String(adminNotePrompt).trim()
                            ? String(adminNotePrompt).trim()
                            : '',
                    creditDeducted: originTx === 'credit' ? deduct : 0,
                    resolvedAmount: amtReq
                });
            });
        });
    }).then(function() {
        loadOverviewStats();
    }).catch(function(err) {
        alert(err.message || 'Could not approve refund.');
    });
}

function rejectRefundRequest(requestId) {
    if (!requestId) return;
    if (!confirm('Reject this refund request?')) return;
    var adminNote = window.prompt('Optional reason (shown to staff on this row):', '');
    if (adminNote === null) return;

    db.collection('refundRequests').doc(requestId).update({
        status: 'rejected',
        reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
        reviewedByUid: currentUid,
        adminNote: adminNote && String(adminNote).trim() ? String(adminNote).trim() : ''
    }).then(function() {
        loadOverviewStats();
    }).catch(function(err) {
        alert(err.message || 'Could not reject request.');
    });
}

function deleteRefundRequestAdmin(requestId) {
    if (!requestId) return;
    if (
        !confirm(
            'Permanently delete this refund request?\nThis only removes the record in Firestore; it does not automatically reverse payouts already processed.'
        )
    )
        return;
    db.collection('refundRequests')
        .doc(requestId)
        .delete()
        .then(function() {
            loadOverviewStats();
        })
        .catch(function(err) {
            alert(err.message || 'Could not delete request.');
        });
}

function adminMarkAuthAccountRemoved(requestId) {
    if (!requestId || !confirm('Confirm you removed this user from Firebase Authentication in the Firebase Console?')) return;
    db.collection('accountDeletionRequests')
        .doc(requestId)
        .update({
            status: 'completed_admin',
            authRemovedAt: firebase.firestore.FieldValue.serverTimestamp(),
            resolvedByUid: currentUid || ''
        })
        .then(function() {
            loadOverviewStats();
        })
        .catch(function(err) {
            alert(err.message || 'Could not update deletion request.');
        });
}

function deleteAccountDeletionRequestAdmin(requestId) {
    if (!requestId) return;
    if (
        !confirm(
            'Permanently delete this account deletion request?\nThis only removes the Firestore record; it does not change Firebase Authentication by itself.'
        )
    )
        return;
    db.collection('accountDeletionRequests')
        .doc(requestId)
        .delete()
        .then(function() {
            loadOverviewStats();
        })
        .catch(function(err) {
            alert(err.message || 'Could not delete deletion request.');
        });
}

function loadOverviewAccountDeletionRequests() {
    var tbody = $('overviewAcctDelBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">Loading\u2026</td></tr>';

    db.collection('accountDeletionRequests')
        .get()
        .then(function(snap) {
            var rows = [];
            snap.forEach(function(doc) {
                rows.push({ id: doc.id, d: doc.data() });
            });
            rows.sort(function(a, b) {
                return tsSeconds(b.d.createdAt) - tsSeconds(a.d.createdAt);
            });

            if ($('overviewAcctDelCount')) {
                var pend = rows.filter(function(x) { return (x.d.status || '') === 'pending'; }).length;
                $('overviewAcctDelCount').textContent = '(' + pend + ' pending)';
            }

            tbody.innerHTML = '';
            if (!rows.length) {
                tbody.innerHTML =
                    '<tr><td colspan="8" class="text-center text-muted">No account deletion requests.</td></tr>';
                return;
            }

            rows.forEach(function(row) {
                var d = row.d;
                var tr = document.createElement('tr');
                var when = formatDateTime(d.createdAt);
                var kind = (d.requestType || '') === 'temporary' ? 'Temporary' : 'Permanent';
                var kindBadge =
                    kind === 'Temporary'
                        ? '<span class="badge bg-secondary">' + escHtml(kind) + '</span>'
                        : '<span class="badge bg-danger">' + escHtml(kind) + '</span>';
                var cancelCell =
                    kind === 'Permanent'
                        ? formatDateTime(d.cancelDeadlineAt)
                        : '\u2014';
                var mileCell =
                    kind === 'Permanent' ? formatDateTime(d.deletionEligibleAfterAt) : '\u2014';
                var st = (d.status || 'pending').toLowerCase();
                var statusBadge =
                    st === 'pending'
                        ? '<span class="badge bg-warning text-dark">Pending</span>'
                        : st === 'cancelled_member'
                            ? '<span class="badge bg-secondary">Withdrawn</span>'
                            : st === 'completed_admin'
                                ? '<span class="badge bg-success">Auth removed</span>'
                                : '<span class="badge bg-light text-dark">' + escHtml(st) + '</span>';

                var tdAct = document.createElement('td');
                tdAct.className = 'd-flex flex-wrap gap-1 align-items-start';
                if (st === 'pending') {
                    var done = document.createElement('button');
                    done.type = 'button';
                    done.className = 'btn btn-sm btn-outline-danger';
                    done.title =
                        'After deleting the user from Firebase Authentication, click to mark done';
                    done.innerHTML = '<i class="fas fa-user-slash"></i> Mark Auth removed';
                    done.addEventListener('click', function() {
                        adminMarkAuthAccountRemoved(row.id);
                    });
                    tdAct.appendChild(done);
                }
                var delAcct = document.createElement('button');
                delAcct.type = 'button';
                delAcct.className = 'btn btn-sm btn-outline-secondary';
                delAcct.title = 'Delete request record';
                delAcct.innerHTML = '<i class="fas fa-trash-alt"></i>';
                delAcct.addEventListener('click', function() {
                    deleteAccountDeletionRequestAdmin(row.id);
                });
                tdAct.appendChild(delAcct);

                tr.innerHTML =
                    '<td class="small text-white">' + escHtml(when) + '</td>' +
                    '<td>' + kindBadge + '</td>' +
                    '<td class="small">' + escHtml(d.memberName || '\u2014') + '</td>' +
                    '<td class="small">' + escHtml(d.memberEmail || '\u2014') + '</td>' +
                    '<td class="small text-white">' + escHtml(cancelCell) + '</td>' +
                    '<td class="small text-white">' + escHtml(mileCell) + '</td>' +
                    '<td>' + statusBadge + '</td>';

                tr.appendChild(tdAct);
                tbody.appendChild(tr);
            });
        })
        .catch(function(err) {
            console.error(err);
            tbody.innerHTML =
                '<tr><td colspan="8" class="text-center text-danger">Could not load account deletion requests.</td></tr>';
        });
}

function loadOverviewClassTrainerRequests() {
    var tbody = $('overviewClassRequestsBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">Loading…</td></tr>';

    db.collection('trainerClassRequests').where('status', '==', 'pending').get()
        .then(function(snap) {
            var rows = [];
            snap.forEach(function(doc) {
                rows.push({ id: doc.id, d: doc.data() });
            });
            rows.sort(function(a, b) {
                return tsSeconds(b.d.createdAt || b.d.updatedAt) - tsSeconds(a.d.createdAt || a.d.updatedAt);
            });

            if ($('overviewClassReqCount')) {
                $('overviewClassReqCount').textContent = '(' + rows.length + ')';
            }

            tbody.innerHTML = '';
            if (!rows.length) {
                tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No pending trainer class requests</td></tr>';
                return;
            }

            rows.forEach(function(row) {
                var d = row.d;
                var tr = document.createElement('tr');
                var dateStr = formatDate(d.createdAt);

                var approveBtn = document.createElement('button');
                approveBtn.type = 'button';
                approveBtn.className = 'btn btn-sm btn-success me-1';
                approveBtn.title = 'Assign trainer to this class';
                approveBtn.innerHTML = '<i class="fas fa-check"></i>';
                approveBtn.addEventListener('click', function() {
                    approveTrainerClassRequest(row.id, d.classId, d.trainerId);
                });

                var rejectBtn = document.createElement('button');
                rejectBtn.type = 'button';
                rejectBtn.className = 'btn btn-sm btn-outline-danger';
                rejectBtn.title = 'Reject';
                rejectBtn.innerHTML = '<i class="fas fa-times"></i>';
                rejectBtn.addEventListener('click', function() {
                    rejectTrainerClassRequest(row.id);
                });

                var tdAct = document.createElement('td');
                tdAct.appendChild(approveBtn);
                tdAct.appendChild(rejectBtn);

                var tdClass = document.createElement('td');
                tdClass.textContent = d.className || d.classId || '—';
                var tdType = document.createElement('td');
                tdType.className = 'small';
                tdType.textContent = d.classType || '—';
                var tdTn = document.createElement('td');
                tdTn.textContent = d.trainerName || '—';
                var tdEm = document.createElement('td');
                tdEm.className = 'small';
                tdEm.textContent = d.trainerEmail || '—';
                var tdDt = document.createElement('td');
                tdDt.className = 'small';
                tdDt.textContent = dateStr;

                var tdTime = document.createElement('td');
                tdTime.className = 'small';
                tdTime.textContent = d.proposedTime != null && String(d.proposedTime).trim()
                    ? String(d.proposedTime).trim()
                    : '—';
                var tdDur = document.createElement('td');
                tdDur.className = 'small';
                tdDur.textContent =
                    d.proposedDurationMinutes != null && !isNaN(Number(d.proposedDurationMinutes))
                        ? String(d.proposedDurationMinutes) + ' min'
                        : '—';

                tr.appendChild(tdClass);
                tr.appendChild(tdType);
                tr.appendChild(tdTime);
                tr.appendChild(tdDur);
                tr.appendChild(tdTn);
                tr.appendChild(tdEm);
                tr.appendChild(tdDt);
                tr.appendChild(tdAct);

                tbody.appendChild(tr);
            });
        })
        .catch(function() {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-danger">Could not load class requests.</td></tr>';
        });
}

function approveTrainerClassRequest(reqDocId, classId, trainerUid) {
    if (!classId || !trainerUid) return;
    if (!confirm('Assign this trainer to this class? Their availability should align with the class schedule.')) return;

    db.collection('trainerClassRequests').doc(reqDocId).get().then(function(reqSnap) {
        if (!reqSnap.exists) throw new Error('Request no longer exists.');
        var d = reqSnap.data();
        var tName = d.trainerName || '';

        var batch = db.batch();
        batch.update(db.collection('classes').doc(classId), {
            trainerId: trainerUid,
            trainerName: tName,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        batch.update(db.collection('trainerClassRequests').doc(reqDocId), {
            status: 'approved',
            resolvedAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        return batch.commit();
    }).then(function() {
        loadOverviewStats();
        loadClassesAdmin();
        populateTrainerSelect();
        loadTrainerAvailability();
    }).catch(function(err) {
        alert(err.message || 'Could not approve request.');
    });
}

function rejectTrainerClassRequest(reqDocId) {
    if (!confirm('Reject this class assignment request?')) return;
    db.collection('trainerClassRequests').doc(reqDocId).update({
        status: 'rejected',
        resolvedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function() {
        loadOverviewStats();
    }).catch(function(err) {
        alert(err.message || 'Could not reject request.');
    });
}

if ($('btnRefreshOverview')) {
    $('btnRefreshOverview').addEventListener('click', loadOverviewStats);
}
if ($('btnRefreshRefunds')) {
    $('btnRefreshRefunds').addEventListener('click', function() {
        loadOverviewMembershipRevenue();
        loadOverviewRefundRequests();
    });
}
if ($('btnRefreshAcctDelRequests')) {
    $('btnRefreshAcctDelRequests').addEventListener('click', loadOverviewAccountDeletionRequests);
}
if ($('btnRefreshClassRequests')) {
    $('btnRefreshClassRequests').addEventListener('click', loadOverviewClassTrainerRequests);
}

/* ─── All members (card grid + search + detail modal) ─── */
function loadAllMembers() {
    var grid = $('allMembersGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="col-12 text-center text-muted py-4">Loading members…</div>';

    fetchMembersOrdered().then(function(rows) {
        allMembersCache = [];
        allMembersById = {};
        rows.forEach(function(doc) {
            var item = { id: doc.id, data: doc.data() };
            allMembersCache.push(item);
            allMembersById[doc.id] = item;
        });
        renderMembersGrid();
    }).catch(function() {
        grid.innerHTML = '<div class="col-12 text-center text-danger py-4">Could not load members.</div>';
    });
}

function renderMembersGrid() {
    var grid = $('allMembersGrid');
    if (!grid) return;
    var q = ($('memberSearch') && $('memberSearch').value || '').trim().toLowerCase();

    var filtered = allMembersCache.filter(function(item) {
        if (!q) return true;
        var name = (item.data.displayName || '').toLowerCase();
        return name.indexOf(q) !== -1;
    });

    if ($('memberCount')) $('memberCount').textContent = '(' + filtered.length + ')';

    grid.innerHTML = '';
    if (!filtered.length) {
        grid.innerHTML = '<div class="col-12 text-center text-muted py-4">' +
            (q ? 'No members match "' + escHtml(q) + '".' : 'No members yet.') + '</div>';
        return;
    }

    filtered.forEach(function(item) {
        var d = item.data;
        var name = d.displayName || '—';
        var initials = getInitials(name, d.email);
        var hasPhoto = d.photoURL && /^https?:\/\//i.test(d.photoURL);
        var avatar = hasPhoto
            ? '<div class="trainer-avatar"><img src="' + escHtml(d.photoURL) + '" alt="' + escHtml(name) + '" onerror="this.parentNode.textContent=\'' + initials + '\'"></div>'
            : '<div class="trainer-avatar">' + initials + '</div>';

        var col = document.createElement('div');
        col.className = 'col-6 col-sm-4 col-md-3 col-lg-2';
        var planLabel = escHtml(d.plan || '—');
        var currSym = adminCurrencySym(d.planCurrency || 'GBP');
        var cBal = typeof d.planCredit === 'number' ? d.planCredit : 0;
        var rOwes = typeof d.lastRefundAmount === 'number' ? d.lastRefundAmount : 0;
        var pubLine =
            d.gymPublicId && isValidGymPublicId(d.gymPublicId)
                ? '<div class="small text-white-50 font-monospace mb-1">' + escHtml(d.gymPublicId) + '</div>'
                : '';
        col.innerHTML =
            '<div class="dash-card h-100 member-card" tabindex="0" data-id="' + item.id + '">' +
                '<div class="card-body text-center">' +
                    avatar +
                    '<h6 class="text-white fw-bold mt-2 mb-1">' + escHtml(name) + '</h6>' +
                    pubLine +
                    '<span class="badge bg-info">' + planLabel + '</span>' +
                    '<div class="member-card-money small mt-2 text-muted">' +
                    escHtml('Credit ' + currSym + Math.max(0, cBal).toFixed(2)) +
                    '<br>' +
                    escHtml('Refund owing ' + currSym + Math.max(0, rOwes).toFixed(2)) +
                    '</div>' +
                '</div>' +
            '</div>';
        var card = col.querySelector('.member-card');
        card.addEventListener('click', function() { openMemberDetailModal(item.id); });
        card.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openMemberDetailModal(item.id);
            }
        });
        grid.appendChild(col);
    });
}

if ($('memberSearch')) {
    $('memberSearch').addEventListener('input', renderMembersGrid);
}
if ($('btnRefreshAll')) {
    $('btnRefreshAll').addEventListener('click', loadAllMembers);
}

function getMemberDetailModal() {
    var el = $('memberDetailModal');
    if (!el || !window.bootstrap) return null;
    if (typeof bootstrap.Modal.getOrCreateInstance === 'function') {
        memberDetailModalInstance = bootstrap.Modal.getOrCreateInstance(el);
    } else if (!memberDetailModalInstance) {
        memberDetailModalInstance = new bootstrap.Modal(el);
    }
    return memberDetailModalInstance;
}

function openMemberDetailModal(memberId) {
    var item = allMembersById[memberId];
    if (!item) return;
    currentMemberDetailId = memberId;
    var d = item.data;
    var name = d.displayName || '—';
    var email = d.email || '—';

    bigAvatarInto('mdAvatar', 'mdInitials', name, email, d.photoURL);
    if ($('mdName')) $('mdName').textContent = name;
    if ($('mdSubtitle')) {
        $('mdSubtitle').textContent =
            (d.plan ? d.plan : 'No plan') +
            (d.planPeriod ? ' · ' + (d.planPeriod === 'yearly' ? 'Yearly' : 'Monthly') : '');
    }
    if ($('mdEmail')) $('mdEmail').textContent = email;
    if ($('mdGymPublicId')) {
        $('mdGymPublicId').textContent =
            d.gymPublicId && isValidGymPublicId(d.gymPublicId) ? d.gymPublicId : '\u2014';
    }
    if ($('mdPhone')) $('mdPhone').textContent = d.phone || '—';
    if ($('mdJoin')) $('mdJoin').textContent = formatDate(d.createdAt);

    if ($('mdClassesAttended')) {
        $('mdClassesAttended').textContent = '…';
        (function(mid) {
            db.collection('bookings')
                .where('memberId', '==', mid)
                .get()
                .then(function(bsnap) {
                    if (currentMemberDetailId !== mid) return;
                    var attended = 0;
                    bsnap.forEach(function(bdoc) {
                        var b = bdoc.data();
                        if (b.sessionStarted === true && (b.status || 'confirmed').toLowerCase() !== 'cancelled') {
                            attended++;
                        }
                    });
                    if ($('mdClassesAttended')) $('mdClassesAttended').textContent = String(attended);
                })
                .catch(function(err) {
                    console.warn('member bookings count:', err);
                    if (currentMemberDetailId !== mid) return;
                    if ($('mdClassesAttended')) $('mdClassesAttended').textContent = '\u2014';
                });
        })(memberId);
    }

    if ($('mdPlanType')) {
        $('mdPlanType').innerHTML =
            (d.plan ? '<span class="badge bg-info">' + escHtml(d.plan) + '</span>' : '—') +
            (d.planPeriod ? ' <span class="badge bg-secondary ms-1">' + (d.planPeriod === 'yearly' ? 'Yearly' : 'Monthly') + '</span>' : '');
    }
    if ($('mdPlanStart')) $('mdPlanStart').textContent = formatDate(d.planActivatedAt);
    if ($('mdPlanEnd')) $('mdPlanEnd').textContent = formatDate(d.planExpiresAt);

    var bar = $('mdProgressBar');
    var rem = $('mdRemaining');
    if ($('mdMemberCredit')) {
        var symMd = adminCurrencySym(d.planCurrency || 'GBP');
        $('mdMemberCredit').textContent =
            typeof d.planCredit === 'number'
                ? symMd + Math.max(0, d.planCredit).toFixed(2)
                : symMd + '0.00';
    }
    if ($('mdMemberRefundOwes')) {
        var symR = adminCurrencySym(d.planCurrency || 'GBP');
        var owes = typeof d.lastRefundAmount === 'number' ? Math.max(0, d.lastRefundAmount) : 0;
        $('mdMemberRefundOwes').textContent =
            owes > 0 ? symR + owes.toFixed(2) + ' (plan-change refund owing)' : '—';
    }
    if (bar && rem) {
        bar.classList.remove('warn', 'expired');
        bar.style.width = '0%';
        var start = tsToDate(d.planActivatedAt);
        var end = tsToDate(d.planExpiresAt);
        if (!end) {
            rem.textContent = d.planStatus === 'active' ? 'Active' : 'No active membership';
        } else {
            var now = new Date();
            var totalMs = (start && end) ? (end.getTime() - start.getTime()) : 0;
            var remainingMs = end.getTime() - now.getTime();
            if (remainingMs <= 0) {
                bar.classList.add('expired');
                bar.style.width = '100%';
                rem.textContent = 'Expired ' + Math.ceil(-remainingMs / (1000 * 60 * 60 * 24)) + ' day(s) ago';
            } else {
                var daysLeft = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
                var pct = totalMs > 0 ? Math.min(100, Math.max(0, ((totalMs - remainingMs) / totalMs) * 100)) : 0;
                if (daysLeft <= 7) bar.classList.add('warn');
                bar.style.width = pct.toFixed(1) + '%';
                rem.textContent = daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' remaining';
            }
        }
    }

    var m = getMemberDetailModal();
    if (m) m.show();
}

if ($('btnDeleteMemberFromModal')) {
    $('btnDeleteMemberFromModal').addEventListener('click', function() {
        if (!currentMemberDetailId) return;
        if (!confirm('Delete this member permanently?')) return;
        db.collection('members').doc(currentMemberDetailId).delete()
            .then(function() {
                var m = getMemberDetailModal();
                if (m) m.hide();
                currentMemberDetailId = null;
                loadAllMembers();
                loadOverviewStats();
            })
            .catch(function(err) { alert(err.message); });
    });
}

/* ─── Trainer applications (card grid + search + filter + modal) ─── */
function loadTrainerApplications() {
    var grid = $('trainerAppsGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="col-12 text-center text-muted py-4">Loading trainers…</div>';

    fetchTrainersOrdered().then(function(rows) {
        allTrainersCache = [];
        allTrainersById = {};
        rows.forEach(function(doc) {
            var item = { id: doc.id, data: doc.data() };
            allTrainersCache.push(item);
            allTrainersById[doc.id] = item;
        });
        renderTrainersGrid();
    }).catch(function() {
        grid.innerHTML = '<div class="col-12 text-center text-danger py-4">Could not load trainers.</div>';
    });
}

function renderTrainersGrid() {
    var grid = $('trainerAppsGrid');
    if (!grid) return;
    var q = ($('trainerSearch') && $('trainerSearch').value || '').trim().toLowerCase();
    var statusFilter = ($('trainerStatusFilter') && $('trainerStatusFilter').value) || '';

    var filtered = allTrainersCache.filter(function(item) {
        var d = item.data;
        var st = d.approvalStatus || 'pending';
        if (statusFilter && st !== statusFilter) return false;
        if (q) {
            var name = (d.displayName || '').toLowerCase();
            if (name.indexOf(q) === -1) return false;
        }
        return true;
    });

    if ($('trainerCount')) $('trainerCount').textContent = '(' + filtered.length + ')';

    grid.innerHTML = '';
    if (!filtered.length) {
        grid.innerHTML = '<div class="col-12 text-center text-muted py-4">' +
            (q || statusFilter ? 'No trainers match the filter.' : 'No trainer applications yet.') + '</div>';
        return;
    }

    var statusColors = { approved: 'success', pending: 'warning', rejected: 'danger' };

    filtered.forEach(function(item) {
        var d = item.data;
        var name = d.displayName || '—';
        var initials = getInitials(name, d.email);
        var st = d.approvalStatus || 'pending';
        var hasPhoto = d.photoURL && /^https?:\/\//i.test(d.photoURL);
        var avatar = hasPhoto
            ? '<div class="trainer-avatar"><img src="' + escHtml(d.photoURL) + '" alt="' + escHtml(name) + '" onerror="this.parentNode.textContent=\'' + initials + '\'"></div>'
            : '<div class="trainer-avatar">' + initials + '</div>';

        var col = document.createElement('div');
        col.className = 'col-6 col-sm-4 col-md-3 col-lg-2';
        col.innerHTML =
            '<div class="dash-card h-100 member-card" tabindex="0" data-id="' + item.id + '">' +
                '<div class="card-body text-center">' +
                    avatar +
                    '<h6 class="text-white fw-bold mt-2 mb-1">' + escHtml(name) + '</h6>' +
                    '<span class="badge bg-info">' + escHtml(d.specialization || '—') + '</span>' +
                    '<div class="mt-1"><span class="badge bg-' + (statusColors[st] || 'secondary') + '">' +
                        st.charAt(0).toUpperCase() + st.slice(1) + '</span></div>' +
                '</div>' +
            '</div>';
        var card = col.querySelector('.member-card');
        card.addEventListener('click', function() { openTrainerDetailModal(item.id); });
        card.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openTrainerDetailModal(item.id);
            }
        });
        grid.appendChild(col);
    });
}

if ($('trainerSearch')) {
    $('trainerSearch').addEventListener('input', renderTrainersGrid);
}
if ($('trainerStatusFilter')) {
    $('trainerStatusFilter').addEventListener('change', renderTrainersGrid);
}
if ($('btnRefreshTrainers')) {
    $('btnRefreshTrainers').addEventListener('click', loadTrainerApplications);
}

function getTrainerDetailModal() {
    var el = $('trainerDetailModal');
    if (!el || !window.bootstrap) return null;
    if (typeof bootstrap.Modal.getOrCreateInstance === 'function') {
        trainerDetailModalInstance = bootstrap.Modal.getOrCreateInstance(el);
    } else if (!trainerDetailModalInstance) {
        trainerDetailModalInstance = new bootstrap.Modal(el);
    }
    return trainerDetailModalInstance;
}

function openTrainerDetailModal(trainerId) {
    var item = allTrainersById[trainerId];
    if (!item) return;
    currentTrainerDetailId = trainerId;
    var d = item.data;
    var name = d.displayName || '—';
    var email = d.email || '—';
    var st = d.approvalStatus || 'pending';
    var statusColors = { approved: 'success', pending: 'warning', rejected: 'danger' };

    bigAvatarInto('tdAvatar', 'tdInitials', name, email, d.photoURL);
    if ($('tdName')) $('tdName').textContent = name;
    if ($('tdSubtitle')) {
        $('tdSubtitle').textContent = (d.specialization || 'Trainer') +
            (d.experience != null ? ' · ' + d.experience + ' yrs experience' : '');
    }
    if ($('tdEmail')) $('tdEmail').textContent = email;
    if ($('tdGymPublicId')) {
        $('tdGymPublicId').textContent =
            d.gymPublicId && isValidGymPublicId(d.gymPublicId) ? d.gymPublicId : '\u2014';
    }
    if ($('tdPhone')) $('tdPhone').textContent = d.phone || '—';
    if ($('tdSpec')) $('tdSpec').textContent = d.specialization || '—';
    if ($('tdExp')) $('tdExp').textContent = d.experience != null ? d.experience + ' year(s)' : '—';
    if ($('tdApplied')) $('tdApplied').textContent = formatDate(d.createdAt);
    if ($('tdStatus')) {
        $('tdStatus').innerHTML = '<span class="badge bg-' + (statusColors[st] || 'secondary') + '">' +
            st.charAt(0).toUpperCase() + st.slice(1) + '</span>';
    }
    if ($('tdQual')) $('tdQual').textContent = d.qualifications || '—';
    if ($('tdBio')) $('tdBio').textContent = d.bio || '—';

    var btnApprove = $('btnApproveTrainerFromModal');
    var btnReject = $('btnRejectTrainerFromModal');
    if (btnApprove) btnApprove.classList.toggle('d-none', st === 'approved');
    if (btnReject) btnReject.classList.toggle('d-none', st === 'rejected' || st === 'approved');

    var m = getTrainerDetailModal();
    if (m) m.show();
}

function setTrainerStatus(uid, status) {
    return db.collection('trainers').doc(uid).update({ approvalStatus: status })
        .then(function() {
            loadTrainerApplications();
            loadOverviewStats();
            populateTrainerSelect();
            loadTrainerAvailability();
        });
}

window.approveTrainer = function(uid) { setTrainerStatus(uid, 'approved'); };
window.rejectTrainer = function(uid) { setTrainerStatus(uid, 'rejected'); };
window.deleteTrainer = function(uid) {
    if (!confirm('Delete this trainer permanently?')) return;
    db.collection('trainers').doc(uid).delete()
        .then(function() {
            loadTrainerApplications();
            loadOverviewStats();
            populateTrainerSelect();
            loadTrainerAvailability();
        });
};

if ($('btnApproveTrainerFromModal')) {
    $('btnApproveTrainerFromModal').addEventListener('click', function() {
        if (!currentTrainerDetailId) return;
        setTrainerStatus(currentTrainerDetailId, 'approved').then(function() {
            var m = getTrainerDetailModal();
            if (m) m.hide();
        });
    });
}
if ($('btnRejectTrainerFromModal')) {
    $('btnRejectTrainerFromModal').addEventListener('click', function() {
        if (!currentTrainerDetailId) return;
        setTrainerStatus(currentTrainerDetailId, 'rejected').then(function() {
            var m = getTrainerDetailModal();
            if (m) m.hide();
        });
    });
}
if ($('btnDeleteTrainerFromModal')) {
    $('btnDeleteTrainerFromModal').addEventListener('click', function() {
        if (!currentTrainerDetailId) return;
        if (!confirm('Delete this trainer permanently?')) return;
        db.collection('trainers').doc(currentTrainerDetailId).delete()
            .then(function() {
                var m = getTrainerDetailModal();
                if (m) m.hide();
                currentTrainerDetailId = null;
                loadTrainerApplications();
                loadOverviewStats();
                populateTrainerSelect();
                loadTrainerAvailability();
            })
            .catch(function(err) { alert(err.message); });
    });
}

/* ─── Trainer availability cards (kept original list view) ─── */
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

function formatDaySlots(dayData) {
    if (dayData == null) return '<span class="time-chip off">—</span>';
    if (typeof dayData === 'string') return '<span class="time-chip">' + escHtml(dayData) + '</span>';
    if (typeof dayData === 'object' && dayData.available === false) return '<span class="time-chip off">Off</span>';
    var labels = collectSlotLabels(dayData);
    if (!labels.length) return '<span class="time-chip off">Not set</span>';
    return labels.map(function(l) {
        return '<span class="time-chip">' + escHtml(l) + '</span>';
    }).join(' ');
}

function loadTrainerAvailability() {
    var grid = $('trainerAvailGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="text-center text-muted py-4">Loading…</div>';

    db.collection('trainers').where('approvalStatus', '==', 'approved').get()
        .then(function(snap) {
            grid.innerHTML = '';
            if (snap.empty) {
                grid.innerHTML = '<div class="text-center text-muted py-4">No approved trainers yet.</div>';
                return;
            }
            snap.forEach(function(doc) {
                var d = doc.data();
                var avail = d.availability || d.weeklyAvailability || null;
                var card = document.createElement('div');
                card.className = 'trainer-avail-card';
                var header = document.createElement('div');
                header.className = 'trainer-avail-card-header';
                header.innerHTML =
                    '<span class="trainer-avail-name">' + escHtml(d.displayName || 'Trainer') + '</span>' +
                    '<span class="badge bg-secondary">' + escHtml(d.specialization || '—') + '</span>';
                var body = document.createElement('div');
                body.className = 'trainer-avail-card-body';
                var week = document.createElement('div');
                week.className = 'trainer-avail-week';

                if (!avail || typeof avail !== 'object') {
                    var row = document.createElement('div');
                    row.className = 'trainer-avail-day unavailable';
                    row.innerHTML = '<span class="day-label">·</span><span class="text-muted small">No weekly schedule saved yet.</span>';
                    week.appendChild(row);
                } else {
                    DAYS.forEach(function(day) {
                        var rowEl = document.createElement('div');
                        var dayVal = avail[day] || avail[day.toLowerCase()];
                        var has = dayVal != null && dayVal !== '' && dayVal !== false;
                        if (has && typeof dayVal === 'object' && dayVal.available === false) has = false;
                        rowEl.className = 'trainer-avail-day' + (has ? ' available' : ' unavailable');
                        rowEl.innerHTML =
                            '<span class="day-label">' + day.slice(0, 3) + '</span>' +
                            '<div class="d-flex flex-wrap gap-1">' + formatDaySlots(dayVal) + '</div>';
                        week.appendChild(rowEl);
                    });
                }
                body.appendChild(week);
                card.appendChild(header);
                card.appendChild(body);
                grid.appendChild(card);
            });
        })
        .catch(function() {
            grid.innerHTML = '<div class="text-center text-danger py-4">Could not load availability.</div>';
        });
}

if ($('btnRefreshTrainerAvail')) {
    $('btnRefreshTrainerAvail').addEventListener('click', loadTrainerAvailability);
}

/* ─── Classes (card grid + search + filter + modal) ─── */
var classModalInstance = null;

function getClassModal() {
    var el = $('classModal');
    if (!el || !window.bootstrap) return null;
    if (typeof bootstrap.Modal.getOrCreateInstance === 'function') {
        classModalInstance = bootstrap.Modal.getOrCreateInstance(el);
    } else if (!classModalInstance) {
        classModalInstance = new bootstrap.Modal(el);
    }
    return classModalInstance;
}

function getClassDetailModal() {
    var el = $('classDetailModal');
    if (!el || !window.bootstrap) return null;
    if (typeof bootstrap.Modal.getOrCreateInstance === 'function') {
        classDetailModalInstance = bootstrap.Modal.getOrCreateInstance(el);
    } else if (!classDetailModalInstance) {
        classDetailModalInstance = new bootstrap.Modal(el);
    }
    return classDetailModalInstance;
}

function populateTrainerSelect() {
    var sel = $('classTrainer');
    if (!sel) return Promise.resolve();
    var v = sel.value;
    sel.innerHTML = '<option value="">— None —</option>';
    approvedTrainerNames = {};
    return db.collection('trainers').where('approvalStatus', '==', 'approved').get().then(function(snap) {
        snap.forEach(function(doc) {
            var d = doc.data();
            var name = d.displayName || d.email || doc.id;
            approvedTrainerNames[doc.id] = name;
            var opt = document.createElement('option');
            opt.value = doc.id;
            opt.textContent = name + (d.specialization ? ' (' + d.specialization + ')' : '');
            sel.appendChild(opt);
        });
        if (v) sel.value = v;
    });
}

function loadClassesAdmin() {
    var grid = $('classesGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="col-12 text-center text-muted py-4">Loading classes…</div>';

    db.collection('classes').get()
        .then(function(snap) {
            allClassesCache = [];
            allClassesById = {};
            snap.forEach(function(doc) {
                var item = { id: doc.id, data: doc.data() };
                allClassesCache.push(item);
                allClassesById[doc.id] = item;
            });
            allClassesCache.sort(function(a, b) {
                return tsSeconds(b.data.createdAt) - tsSeconds(a.data.createdAt);
            });
            renderClassesGrid();
        })
        .catch(function() {
            grid.innerHTML = '<div class="col-12 text-center text-danger py-4">Could not load classes.</div>';
        });
}

function renderClassesGrid() {
    var grid = $('classesGrid');
    if (!grid) return;
    var q = ($('classSearch') && $('classSearch').value || '').trim().toLowerCase();
    var statusFilter = ($('classStatusFilter') && $('classStatusFilter').value) || '';

    var filtered = allClassesCache.filter(function(item) {
        var c = item.data;
        var st = c.status || 'active';
        if (statusFilter && st !== statusFilter) return false;
        if (q) {
            var hay = ((c.name || '') + ' ' + (c.type || '')).toLowerCase();
            if (hay.indexOf(q) === -1) return false;
        }
        return true;
    });

    if ($('classCount')) $('classCount').textContent = '(' + filtered.length + ')';

    grid.innerHTML = '';
    if (!filtered.length) {
        grid.innerHTML = '<div class="col-12 text-center text-muted py-4">' +
            (q || statusFilter ? 'No classes match the filter.' : 'No classes yet. Add one to get started.') + '</div>';
        return;
    }

    var statusColors = { active: 'success', cancelled: 'secondary', draft: 'warning' };

    filtered.forEach(function(item) {
        var c = item.data;
        var st = c.status || 'active';
        var dayTxt = c.schedule && c.schedule.day ? c.schedule.day : '—';
        var timeTxt = c.schedule && c.schedule.time ? c.schedule.time : '—';

        var col = document.createElement('div');
        col.className = 'col-6 col-sm-4 col-md-3 col-lg-2';
        col.innerHTML =
            '<div class="dash-card h-100 member-card" tabindex="0" data-id="' + item.id + '">' +
                '<div class="card-body text-center">' +
                    '<div class="class-avatar"><i class="fas fa-dumbbell"></i></div>' +
                    '<h6 class="text-white fw-bold mt-2 mb-1">' + escHtml(c.name || 'Untitled') + '</h6>' +
                    '<span class="badge bg-info">' + escHtml(c.type || '—') + '</span>' +
                    '<div class="member-meta small mt-1">' + escHtml(dayTxt) + ' · ' + escHtml(timeTxt) + '</div>' +
                    '<div class="mt-1"><span class="badge bg-' + (statusColors[st] || 'secondary') + '">' + escHtml(st) + '</span></div>' +
                '</div>' +
            '</div>';
        var card = col.querySelector('.member-card');
        card.addEventListener('click', function() { openClassDetailModal(item.id); });
        card.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openClassDetailModal(item.id);
            }
        });
        grid.appendChild(col);
    });
}

if ($('classSearch')) {
    $('classSearch').addEventListener('input', renderClassesGrid);
}
if ($('classStatusFilter')) {
    $('classStatusFilter').addEventListener('change', renderClassesGrid);
}

function openClassDetailModal(classId) {
    var item = allClassesById[classId];
    if (!item) return;
    currentClassDetailId = classId;
    var c = item.data;
    var st = c.status || 'active';
    var statusColors = { active: 'success', cancelled: 'secondary', draft: 'warning' };

    if ($('cdName')) $('cdName').textContent = c.name || 'Untitled';
    if ($('cdSubtitle')) $('cdSubtitle').textContent = (c.type || '—');
    if ($('cdType')) $('cdType').innerHTML = '<span class="badge bg-info">' + escHtml(c.type || '—') + '</span>';
    if ($('cdStatus')) $('cdStatus').innerHTML = '<span class="badge bg-' + (statusColors[st] || 'secondary') + '">' + escHtml(st) + '</span>';
    if ($('cdDay')) $('cdDay').textContent = (c.schedule && c.schedule.day) || '—';
    if ($('cdTime')) $('cdTime').textContent = (c.schedule && c.schedule.time) || '—';
    if ($('cdDuration')) $('cdDuration').textContent = (c.schedule && c.schedule.duration) ? c.schedule.duration + ' min' : '—';
    if ($('cdTrainer')) $('cdTrainer').textContent = c.trainerName || '—';

    var cap = c.capacity || 0;
    var enr = c.enrolled || 0;
    if ($('cdCapacity')) $('cdCapacity').textContent = enr + ' / ' + cap;
    var bar = $('cdProgressBar');
    if (bar) {
        bar.classList.remove('warn', 'expired');
        var pct = cap > 0 ? Math.min(100, (enr / cap) * 100) : 0;
        bar.style.width = pct.toFixed(1) + '%';
        if (pct >= 100) bar.classList.add('expired');
        else if (pct >= 80) bar.classList.add('warn');
    }
    if ($('cdDesc')) $('cdDesc').textContent = c.description || '—';

    var m = getClassDetailModal();
    if (m) m.show();
}

if ($('btnDeleteClassFromModal')) {
    $('btnDeleteClassFromModal').addEventListener('click', function() {
        if (!currentClassDetailId) return;
        if (!confirm('Delete this class?')) return;
        db.collection('classes').doc(currentClassDetailId).delete()
            .then(function() {
                var m = getClassDetailModal();
                if (m) m.hide();
                currentClassDetailId = null;
                loadClassesAdmin();
                loadOverviewStats();
            });
    });
}
if ($('btnEditClassFromModal')) {
    $('btnEditClassFromModal').addEventListener('click', function() {
        if (!currentClassDetailId) return;
        var m = getClassDetailModal();
        if (m) m.hide();
        window.editClass(currentClassDetailId);
    });
}

window.editClass = function(id) {
    populateTrainerSelect().then(function() {
        return db.collection('classes').doc(id).get();
    }).then(function(doc) {
        if (!doc || !doc.exists) return;
        var c = doc.data();
        $('classEditId').value = id;
        if ($('classModalTitle')) $('classModalTitle').textContent = 'Edit Class';
        $('className').value = c.name || '';
        $('classType').value = c.type || 'Strength';
        $('classDesc').value = c.description || '';
        var s = c.schedule || {};
        $('classDay').value = s.day || 'Monday';
        $('classTime').value = s.time || '';
        $('classDuration').value = s.duration || 60;
        $('classTrainer').value = c.trainerId || '';
        $('classCapacity').value = c.capacity != null ? c.capacity : 20;
        updateTrainerAvailPreview();
        var m = getClassModal();
        if (m) m.show();
    });
};

function openAddClassModal() {
    $('classEditId').value = '';
    if ($('classModalTitle')) $('classModalTitle').textContent = 'Add Class';
    $('className').value = '';
    $('classType').value = 'Strength';
    $('classDesc').value = '';
    $('classDay').value = 'Monday';
    $('classTime').value = '';
    $('classDuration').value = 60;
    $('classTrainer').value = '';
    $('classCapacity').value = 20;
    if ($('trainerAvailPreview')) {
        $('trainerAvailPreview').classList.add('d-none');
        $('trainerAvailPreview').innerHTML = '';
    }
    populateTrainerSelect().then(function() {
        var m = getClassModal();
        if (m) m.show();
    });
}

function updateTrainerAvailPreview() {
    var prev = $('trainerAvailPreview');
    if (!prev) return;
    var tid = $('classTrainer').value;
    if (!tid) {
        prev.classList.add('d-none');
        prev.innerHTML = '';
        return;
    }
    db.collection('trainers').doc(tid).get().then(function(doc) {
        if (!doc.exists) {
            prev.classList.add('d-none');
            return;
        }
        var d = doc.data();
        var avail = d.availability || d.weeklyAvailability;
        prev.classList.remove('d-none');
        if (!avail || typeof avail !== 'object') {
            prev.innerHTML = '<div class="avail-preview-title">Trainer schedule</div><p class="text-muted small mb-0">No saved availability for this trainer.</p>';
            return;
        }
        var html = '<div class="avail-preview-title">Trainer schedule (summary)</div><div class="avail-preview-days">';
        DAYS.forEach(function(day) {
            var dv = avail[day] || avail[day.toLowerCase()];
            html += '<div class="avail-preview-day"><strong>' + day.slice(0, 3) + '</strong> <span class="avail-preview-slotwrap">' +
                (dv != null && dv !== '' && dv !== false ? formatDaySlots(dv) : '—') + '</span></div>';
        });
        html += '</div>';
        prev.innerHTML = html;
    });
}

if ($('btnAddClass')) {
    $('btnAddClass').addEventListener('click', function() { openAddClassModal(); });
}
if ($('btnRefreshClasses')) {
    $('btnRefreshClasses').addEventListener('click', loadClassesAdmin);
}
if ($('classTrainer')) {
    $('classTrainer').addEventListener('change', updateTrainerAvailPreview);
}
if ($('btnSaveClass')) {
    $('btnSaveClass').addEventListener('click', function() {
        var name = $('className').value.trim();
        if (!name) { alert('Please enter a class name.'); return; }
        var tid = $('classTrainer').value;
        var tname = tid ? (approvedTrainerNames[tid] || '') : '';
        if (tid && !tname) {
            tname = $('classTrainer').selectedOptions[0]
                ? $('classTrainer').selectedOptions[0].textContent.split('(')[0].trim()
                : '';
        }
        var payload = {
            name: name,
            type: $('classType').value,
            description: ($('classDesc').value || '').trim(),
            schedule: {
                day: $('classDay').value,
                time: $('classTime').value || '',
                duration: parseInt($('classDuration').value, 10) || 60
            },
            trainerId: tid || '',
            trainerName: tname || '',
            capacity: parseInt($('classCapacity').value, 10) || 20,
            enrolled: 0,
            status: 'active',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        var editId = $('classEditId').value;
        var p = editId
            ? db.collection('classes').doc(editId).set(payload, { merge: true })
            : db.collection('classes').add(
                Object.assign({}, payload, { createdAt: firebase.firestore.FieldValue.serverTimestamp() })
            );

        p.then(function() {
            var m = getClassModal();
            if (m) m.hide();
            loadClassesAdmin();
            loadOverviewStats();
        }).catch(function(err) { alert(err.message); });
    });
}

/* ─── Admin chat ─── */
var activeChatTrainerId = null;
var activeChatTrainerName = '';

function detachAdminChatListeners() {
    if (chatMessagesUnsub) {
        chatMessagesUnsub();
        chatMessagesUnsub = null;
    }
}

function loadAdminChatTrainers() {
    detachAdminChatListeners();
    var list = $('chatRoomsList');
    if (!list) return;
    list.innerHTML = '<div class="text-center text-muted small p-3">Loading trainers…</div>';

    db.collection('trainers').where('approvalStatus', '==', 'approved').get()
        .then(function(snap) {
            list.innerHTML = '';
            if (snap.empty) {
                list.innerHTML = '<div class="text-center text-muted small p-3">No approved trainers yet.</div>';
                return;
            }
            var rows = [];
            snap.forEach(function(doc) {
                var d = doc.data();
                rows.push({
                    id: doc.id,
                    name: (d.displayName || d.email || 'Trainer').trim(),
                    spec: d.specialization || '',
                    photoURL: d.photoURL || ''
                });
            });
            rows.sort(function(a, b) { return a.name.localeCompare(b.name); });
            rows.forEach(function(t) {
                var initials = (t.name || 'T').split(' ').map(function(w) { return w[0]; }).join('').substring(0, 2).toUpperCase();
                var hasPhoto = t.photoURL && /^https?:\/\//i.test(t.photoURL);
                var avatar = hasPhoto
                    ? '<div class="chat-room-avatar"><img src="' + escHtml(t.photoURL) + '" alt="' + escHtml(t.name) + '" onerror="this.parentNode.textContent=\'' + initials + '\'"></div>'
                    : '<div class="chat-room-avatar">' + escHtml(initials) + '</div>';
                var div = document.createElement('div');
                div.className = 'chat-room-item' + (activeChatTrainerId === t.id ? ' active' : '');
                div.dataset.trainerId = t.id;
                div.innerHTML =
                    avatar +
                    '<div class="chat-room-info">' +
                        '<div class="chat-room-name">' + escHtml(t.name) +
                            (t.spec ? ' <span class="chat-spec-badge">' + escHtml(t.spec) + '</span>' : '') +
                        '</div>' +
                        '<div class="chat-room-last">Tap to open conversation</div>' +
                    '</div>';
                div.addEventListener('click', function() {
                    openAdminTrainerChat(t.id, t.name);
                });
                list.appendChild(div);
            });
        })
        .catch(function(err) {
            console.error('Load trainers error:', err);
            list.innerHTML = '<div class="text-danger small p-3">Could not load trainers.</div>';
        });
}

function openAdminTrainerChat(trainerUid, trainerName) {
    detachAdminChatListeners();
    activeChatTrainerId = trainerUid;
    activeChatTrainerName = trainerName || 'Trainer';

    if ($('chatHeaderBar')) {
        $('chatHeaderBar').innerHTML = '<span><i class="fas fa-user-tie me-2"></i>' + escHtml(activeChatTrainerName) + '</span>';
    }
    if ($('chatInputArea')) $('chatInputArea').classList.remove('d-none');

    document.querySelectorAll('#chatRoomsList .chat-room-item').forEach(function(el) {
        el.classList.toggle('active', el.dataset.trainerId === trainerUid);
    });

    var msgs = $('chatMessages');
    if (!msgs) return;
    msgs.innerHTML = '<div class="text-muted small p-3">Loading messages…</div>';

    var ref = rtdb.ref('adminChats/' + trainerUid).orderByChild('timestamp');
    var render = function(snapshot) {
        msgs.innerHTML = '';
        if (!snapshot.exists()) {
            msgs.innerHTML = '<div class="chat-empty">No messages yet. Say hi!</div>';
            return;
        }
        var arr = [];
        snapshot.forEach(function(c) { arr.push(c.val()); });
        arr.sort(function(a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
        arr.forEach(function(m) {
            var div = document.createElement('div');
            var isSent = m.senderId === currentUid;
            div.className = 'chat-msg ' + (isSent ? 'sent' : 'received');
            var time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            var who = !isSent && m.senderName ? '<div class="msg-sender small text-white-50 mb-1">' + escHtml(m.senderName) + '</div>' : '';
            div.innerHTML = who + escHtml(m.text || '') + '<div class="msg-time">' + time + '</div>';
            msgs.appendChild(div);
        });
        msgs.scrollTop = msgs.scrollHeight;
    };
    ref.on('value', render, function(err) {
        console.error('Chat read error:', err);
        msgs.innerHTML = '<div class="text-danger small p-3">Could not load messages.</div>';
    });
    chatMessagesUnsub = function() { ref.off('value', render); };
}

function sendAdminChatMessage() {
    var input = $('chatInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text || !activeChatTrainerId) return;

    var msg = {
        senderId: currentUid,
        senderName: (currentUser && currentUser.email) || 'Admin',
        senderRole: 'admin',
        text: text,
        timestamp: firebase.database.ServerValue.TIMESTAMP
    };

    input.disabled = true;
    rtdb.ref('adminChats/' + activeChatTrainerId).push(msg)
        .then(function() {
            input.value = '';
            input.disabled = false;
            input.focus();
        })
        .catch(function(err) {
            console.error('Send error:', err);
            alert(err.message || 'Failed to send message.');
            input.disabled = false;
            input.focus();
        });
}

if ($('btnSendChat')) {
    $('btnSendChat').addEventListener('click', sendAdminChatMessage);
}
if ($('chatInput')) {
    $('chatInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') sendAdminChatMessage();
    });
}

/* ═══ Admin booking check-in (QR / reference — same payload as trainer) ═══ */

function stopAdminQrScanner() {
    if (!adminHtml5QrCode) return;
    var inst = adminHtml5QrCode;
    adminHtml5QrCode = null;
    inst.stop().then(function() {
        inst.clear();
    }).catch(function() {
        try { inst.clear(); } catch (e) { /* ignore */ }
    });
}

function adminCheckinSetResult(html) {
    var el = $('adminCheckinResult');
    if (el) el.innerHTML = html;
}

function adminStartQrScanner() {
    if (typeof Html5Qrcode === 'undefined') {
        alert('QR scanner library did not load. Enter the reference number manually.');
        return;
    }
    var hostId = 'adminQrReader';
    if (!$(hostId)) return;

    stopAdminQrScanner();
    adminHtml5QrCode = new Html5Qrcode(hostId);
    adminHtml5QrCode.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        function(decodedText) {
            stopAdminQrScanner();
            adminResolveBooking(decodedText);
        },
        function() { /* frame discard */ }
    ).catch(function(err) {
        adminHtml5QrCode = null;
        alert(err.message || 'Could not start camera. Check permissions.');
    });
}

function adminRenderBookingDetail(bookingId, b) {
    var st = (b.status || '').trim();
    var sessionOn = b.sessionStarted === true;
    var refNum = b.bookingCode != null ? String(b.bookingCode) : '—';

    var summary =
        '<div class="admin-checkin-highlight border border-secondary rounded p-3 mb-3 bg-dark bg-opacity-25">' +
            '<div class="row g-2">' +
                '<div class="col-sm-6">' +
                    '<span class="text-muted small text-uppercase d-block">Class</span>' +
                    '<div class="fw-bold">' + escHtml(b.className || '—') + '</div>' +
                '</div>' +
                '<div class="col-sm-6">' +
                    '<span class="text-muted small text-uppercase d-block">Trainer</span>' +
                    '<div class="fw-bold">' + escHtml(b.trainerName || '—') + '</div>' +
                '</div>' +
                '<div class="col-sm-6">' +
                    '<span class="text-muted small text-uppercase d-block">Date</span>' +
                    '<div class="fw-semibold">' + escHtml(b.date || '—') + '</div>' +
                '</div>' +
                '<div class="col-sm-6">' +
                    '<span class="text-muted small text-uppercase d-block">Class time</span>' +
                    '<div class="fw-semibold">' + escHtml(b.time || '—') + '</div>' +
                '</div>' +
            '</div>' +
        '</div>';

    var lines = [
        '<div class="mb-2"><span class="text-muted small text-uppercase">Reference</span><div class="fw-bold fs-5">' + escHtml(refNum) + '</div></div>',
        '<div class="mb-2"><span class="text-muted small text-uppercase">Member</span><div class="fw-semibold">' + escHtml(b.memberName || '—') + '</div>' +
            '<div class="small text-muted">' + escHtml(b.memberEmail || '') + '</div></div>',
        '<div class="mb-3"><span class="text-muted small text-uppercase">Status</span><div>' + escHtml(st || '—') +
            (sessionOn ? ' <span class="badge bg-success ms-1">Session started</span>' : '') + '</div></div>'
    ];

    adminCheckinSetResult(
        '<div class="admin-checkin-detail">' + summary + lines.join('') + '</div>'
    );
}

function adminResolveBooking(refRaw) {
    if (!currentUid) return;
    var parsed = parseGymBookingCheckinRaw(refRaw);

    if (parsed.kind === 'v2') {
        adminCheckinSetResult('<p class="text-muted small mb-0"><i class="fas fa-spinner fa-spin me-2"></i>Looking up…</p>');
        db.collection('bookings').doc(parsed.bookingId).get()
            .then(function(bsnap) {
                if (!bsnap.exists) {
                    adminCheckinSetResult('<p class="text-danger small mb-0">Booking record missing.</p>');
                    return;
                }
                var b = bsnap.data();
                if ((b.memberId || '') !== parsed.memberId) {
                    adminCheckinSetResult(
                        '<p class="text-warning small mb-0">QR data does not match this booking (member ID mismatch).</p>'
                    );
                    return;
                }
                adminRenderBookingDetail(bsnap.id, b);
            })
            .catch(function(err) {
                console.error(err);
                var msg = err.message || 'Lookup failed.';
                if (
                    err.code === 'permission-denied' ||
                    String(err.code || '').indexOf('permission-denied') !== -1 ||
                    /insufficient permissions/i.test(msg)
                ) {
                    msg =
                        'Firestore blocked this lookup. In Firestore security rules, allow admins to read `bookingLookups` ' +
                        'and `bookings` (same `isAdmin()` check as your other admin reads).';
                }
                adminCheckinSetResult('<p class="text-danger small mb-0">' + escHtml(msg) + '</p>');
            });
        return;
    }

    var codeKey = parsed.codeKey;
    if (!codeKey) {
        adminCheckinSetResult('<p class="text-warning small mb-0">Enter or scan a valid reference.</p>');
        return;
    }

    adminCheckinSetResult('<p class="text-muted small mb-0"><i class="fas fa-spinner fa-spin me-2"></i>Looking up…</p>');

    db.collection('bookingLookups').doc(codeKey).get()
        .then(function(lsnap) {
            if (lsnap.exists) {
                var L = lsnap.data();
                return db.collection('bookings').doc(L.bookingId).get().then(function(bsnap) {
                    if (!bsnap.exists) {
                        adminCheckinSetResult('<p class="text-danger small mb-0">Booking record missing.</p>');
                        return;
                    }
                    adminRenderBookingDetail(bsnap.id, bsnap.data());
                });
            }
            var num = parseInt(codeKey, 10);
            if (isNaN(num)) {
                return db.collection('bookings').doc(codeKey).get().then(function(bsnap) {
                    if (bsnap.exists) {
                        adminRenderBookingDetail(bsnap.id, bsnap.data());
                        return;
                    }
                    adminCheckinSetResult('<p class="text-warning small mb-0">No booking found for this reference.</p>');
                });
            }
            return db.collection('bookings').where('bookingCode', '==', num).limit(1).get()
                .then(function(q) {
                    if (q.empty) {
                        adminCheckinSetResult('<p class="text-warning small mb-0">No booking found for this reference.</p>');
                        return;
                    }
                    var doc = q.docs[0];
                    adminRenderBookingDetail(doc.id, doc.data());
                });
        })
        .catch(function(err) {
            console.error(err);
            var msg = err.message || 'Lookup failed.';
            if (
                err.code === 'permission-denied' ||
                String(err.code || '').indexOf('permission-denied') !== -1 ||
                /insufficient permissions/i.test(msg)
            ) {
                msg =
                    'Firestore blocked this lookup. In Firestore security rules, allow admins to read `bookingLookups` ' +
                    'and `bookings` (same `isAdmin()` check as your other admin reads). Trainers use an extra ' +
                    '`trainerId` filter so their queries satisfy stricter rules; admins need an explicit admin bypass.';
            }
            adminCheckinSetResult('<p class="text-danger small mb-0">' + escHtml(msg) + '</p>');
        });
}

if ($('btnAdminLookupRef')) {
    $('btnAdminLookupRef').addEventListener('click', function() {
        var inp = $('adminBookingRefInput');
        adminResolveBooking(inp ? inp.value : '');
    });
}
if ($('adminBookingRefInput')) {
    $('adminBookingRefInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            adminResolveBooking(this.value);
        }
    });
}
if ($('btnAdminScanStart')) {
    $('btnAdminScanStart').addEventListener('click', function() { adminStartQrScanner(); });
}
if ($('btnAdminScanStop')) {
    $('btnAdminScanStop').addEventListener('click', function() { stopAdminQrScanner(); });
}

/* ═══ Weekly trainer class log (Firestore: trainerClassCompletions) ═══ */
function adminPad2(n) {
    return (n < 10 ? '0' : '') + n;
}

function adminFormatYMD(d) {
    return d.getFullYear() + '-' + adminPad2(d.getMonth() + 1) + '-' + adminPad2(d.getDate());
}

function adminParseISODateLocal(iso) {
    var p = String(iso || '').split('-');
    if (p.length !== 3) return null;
    var y = parseInt(p[0], 10);
    var m = parseInt(p[1], 10) - 1;
    var day = parseInt(p[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(day)) return null;
    return new Date(y, m, day);
}

function adminStartOfWeekMonday(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var day = x.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    x.setDate(x.getDate() + diff);
    return x;
}

function adminEndOfWeekSunday(monday) {
    var d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
    d.setDate(d.getDate() + 6);
    return d;
}

function adminScheduleDayToJsWeekday(dayStr) {
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

function adminSessionDateForClassInWeek(weekMonday, scheduleDayRaw) {
    var wd = adminScheduleDayToJsWeekday(scheduleDayRaw);
    if (wd === null) return null;
    var i;
    for (i = 0; i < 7; i++) {
        var d = new Date(weekMonday.getFullYear(), weekMonday.getMonth(), weekMonday.getDate());
        d.setDate(d.getDate() + i);
        if (d.getDay() === wd) return adminFormatYMD(d);
    }
    return null;
}

function adminClassCompletionDocId(classId, sessionDate) {
    return classId + '_' + sessionDate;
}

function adminPrettySessionDate(sessionDateIso) {
    var d = adminParseISODateLocal(sessionDateIso);
    return d ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : sessionDateIso;
}

function populateAdminClassLogTrainerFilter() {
    var sel = $('adminClassLogTrainerFilter');
    if (!sel) return;
    var keep = sel.value || '';
    fetchTrainersOrdered().then(function(rows) {
        sel.innerHTML = '<option value="">All trainers</option>';
        rows.forEach(function(doc) {
            var d = doc.data();
            if ((d.approvalStatus || '') !== 'approved') return;
            var opt = document.createElement('option');
            opt.value = doc.id;
            opt.textContent = (d.displayName || d.email || doc.id).trim();
            sel.appendChild(opt);
        });
        sel.value = keep;
        if (sel.value !== keep) sel.value = '';
    });
}

function adminEffectiveSessionStatus(d) {
    if (!d || typeof d !== 'object') return 'pending';
    var st = String(d.sessionStatus || '').trim().toLowerCase();
    if (st === 'completed' || st === 'cancelled' || st === 'delayed' || st === 'missed') return st;
    if (d.completedAt) return 'completed';
    return 'pending';
}

function adminSessionStatusBadgeHtml(st) {
    switch (st) {
        case 'completed':
            return '<span class="badge bg-success">Completed</span>';
        case 'missed':
            return '<span class="badge bg-danger">Missed</span>';
        case 'cancelled':
            return '<span class="badge bg-secondary">Cancel</span>';
        case 'delayed':
            return '<span class="badge bg-warning text-dark">Delay</span>';
        default:
            return '<span class="badge bg-secondary text-dark">Pending</span>';
    }
}

function adminTimestampSeconds(ts) {
    if (!ts) return 0;
    if (typeof ts.seconds === 'number') return ts.seconds;
    if (typeof ts.toMillis === 'function') return Math.floor(ts.toMillis() / 1000);
    return 0;
}

function adminFormatCompletedTime(ts) {
    var sec = adminTimestampSeconds(ts);
    if (!sec) return '—';
    var d = new Date(sec * 1000);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function appendAdminClassLogRow(tbody, trainerName, specialisation, className, sessionDateIso, scheduleTimeStr, comp, orphanTip) {
    var st = adminEffectiveSessionStatus(comp);
    var noteRaw = comp && comp.notes ? String(comp.notes).trim() : '';
    var noteDisplay = orphanTip
        ? (noteRaw ? escHtml(noteRaw) + ' ' : '') + '<small class="text-muted">' + escHtml(orphanTip) + '</small>'
        : noteRaw
          ? escHtml(noteRaw.length > 120 ? noteRaw.slice(0, 117) + '…' : noteRaw)
          : '—';

    var completedCell = '—';
    if (st === 'completed' && comp && comp.completedAt) {
        completedCell = escHtml(adminFormatCompletedTime(comp.completedAt));
    }

    var dayCell = escHtml(adminPrettySessionDate(sessionDateIso));
    if (scheduleTimeStr && String(scheduleTimeStr).trim()) {
        dayCell += '<br><small class="text-muted">' + escHtml(String(scheduleTimeStr).trim()) + '</small>';
    }

    var classCell = escHtml(className || '—');
    var specTrim = specialisation && String(specialisation).trim();
    var specCell = specTrim
        ? '<span class="badge bg-info text-dark">' + escHtml(specTrim) + '</span>'
        : '<span class="text-muted">—</span>';

    var tr = document.createElement('tr');
    tr.innerHTML =
        '<td>' + escHtml(trainerName) + '</td>' +
        '<td class="small">' + specCell + '</td>' +
        '<td>' + classCell + '</td>' +
        '<td>' + dayCell + '</td>' +
        '<td>' + adminSessionStatusBadgeHtml(st) + '</td>' +
        '<td class="small text-muted font-monospace">' + completedCell + '</td>' +
        '<td class="small">' + noteDisplay + '</td>';
    tbody.appendChild(tr);
}

function loadAdminTrainerClassTracking() {
    var tbody = $('adminClassTrackingBody');
    var lbl = $('adminClassLogWeekLabel');
    var selFilter = $('adminClassLogTrainerFilter');
    var filterTid = selFilter ? (selFilter.value || '').trim() : '';
    if (!tbody) return;

    var base = new Date();
    var mon = adminStartOfWeekMonday(base);
    mon.setDate(mon.getDate() + adminClassLogWeekOffset * 7);
    var sun = adminEndOfWeekSunday(mon);
    var w0 = adminFormatYMD(mon);
    var w1 = adminFormatYMD(sun);

    if (lbl) {
        lbl.textContent =
            mon.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
            ' – ' +
            sun.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    tbody.innerHTML =
        '<tr><td colspan="7" class="text-center text-muted py-4">Loading weekly log…</td></tr>';

    Promise.all([
        db.collection('classes').get(),
        db
            .collection('trainerClassCompletions')
            .where('sessionDate', '>=', w0)
            .where('sessionDate', '<=', w1)
            .get(),
        db.collection('trainers').get()
    ])
        .then(function(parts) {
            var snapClasses = parts[0];
            var snapComp = parts[1];
            var snapTrainers = parts[2];
            var trainerSpecById = {};
            snapTrainers.forEach(function(tdoc) {
                var td = tdoc.data();
                trainerSpecById[tdoc.id] = (td.specialization && String(td.specialization).trim()) || '';
            });
            var compById = {};
            snapComp.forEach(function(doc) {
                compById[doc.id] = doc.data();
            });
            var usedComp = {};

            tbody.innerHTML = '';

            snapClasses.forEach(function(doc) {
                var c = doc.data();
                if ((c.status || 'active') !== 'active') return;
                var tid = (c.trainerId || '').trim();
                if (!tid) return;
                if (filterTid && tid !== filterTid) return;
                var sessionDate = adminSessionDateForClassInWeek(mon, (c.schedule || {}).day);
                if (!sessionDate) return;
                var did = adminClassCompletionDocId(doc.id, sessionDate);
                usedComp[did] = true;
                var comp = compById[did];
                var tnm = ((c.trainerName || '').trim() || '(set trainer name on class)');
                var spec = trainerSpecById[tid] || '';
                appendAdminClassLogRow(
                    tbody,
                    tnm,
                    spec,
                    (c.name || '').trim(),
                    sessionDate,
                    (c.schedule || {}).time || '',
                    comp || null,
                    ''
                );
            });

            snapComp.forEach(function(doc) {
                if (usedComp[doc.id]) return;
                var d = doc.data();
                var tid = (d.trainerId || '').trim();
                if (filterTid && tid !== filterTid) return;
                var spec = tid ? trainerSpecById[tid] || '' : '';
                appendAdminClassLogRow(
                    tbody,
                    (d.trainerName || '').trim() || '(trainer)',
                    spec,
                    d.className || d.classId || '—',
                    d.sessionDate,
                    d.time || '—',
                    d,
                    'outside current class template'
                );
            });

            if (!tbody.querySelector('tr')) {
                tbody.innerHTML =
                    '<tr><td colspan="7" class="text-muted text-center py-4">No sessions this week.</td></tr>';
            }
        })
        .catch(function(err) {
            console.error(err);
            tbody.innerHTML =
                '<tr><td colspan="7" class="text-danger text-center py-4">Could not load class log.</td></tr>';
        });
}

function bindAdminClassLogControls() {
    if ($('btnAdminClassLogPrev')) {
        $('btnAdminClassLogPrev').addEventListener('click', function() {
            adminClassLogWeekOffset--;
            loadAdminTrainerClassTracking();
        });
    }
    if ($('btnAdminClassLogNext')) {
        $('btnAdminClassLogNext').addEventListener('click', function() {
            adminClassLogWeekOffset++;
            loadAdminTrainerClassTracking();
        });
    }
    if ($('btnAdminClassLogToday')) {
        $('btnAdminClassLogToday').addEventListener('click', function() {
            adminClassLogWeekOffset = 0;
            loadAdminTrainerClassTracking();
        });
    }
    if ($('btnRefreshClassTracking')) {
        $('btnRefreshClassTracking').addEventListener('click', loadAdminTrainerClassTracking);
    }
    if ($('adminClassLogTrainerFilter')) {
        $('adminClassLogTrainerFilter').addEventListener('change', loadAdminTrainerClassTracking);
    }
}

bindAdminClassLogControls();

/* ─── Website contact form messages ─── */
function loadContactMessages() {
    var tbody = $('contactMessagesBody');
    var cnt = $('contactMsgCount');
    if (!tbody) return;
    tbody.innerHTML =
        '<tr><td colspan="6" class="text-muted text-center py-4">Loading…</td></tr>';

    function renderRows(rows) {
        rows.sort(function(a, b) {
            return tsSeconds(b.data.createdAt) - tsSeconds(a.data.createdAt);
        });
        if (cnt) cnt.textContent = '(' + rows.length + ')';
        if (!rows.length) {
            tbody.innerHTML =
                '<tr><td colspan="6" class="text-muted text-center py-4">No messages yet.</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        rows.forEach(function(entry) {
            var d = entry.data;
            var tr = document.createElement('tr');
            tr.innerHTML =
                '<td class="small text-nowrap">' +
                escHtml(formatDateTime(d.createdAt)) +
                '</td>' +
                '<td>' +
                escHtml(d.name || '—') +
                '</td>' +
                '<td class="small"><a class="link-light text-decoration-underline" href="mailto:' +
                escHtml(d.email || '') +
                '">' +
                escHtml(d.email || '—') +
                '</a></td>' +
                '<td class="small">' +
                escHtml(d.phone ? d.phone : '—') +
                '</td>' +
                '<td class="small" style="white-space:pre-wrap;max-width:300px">' +
                escHtml(d.message || '') +
                '</td>' +
                '<td>' +
                '<button type="button" class="btn btn-sm btn-outline-danger btn-del-contact-msg" data-id="' +
                escHtml(entry.id) +
                '" title="Delete"><i class="fas fa-trash"></i></button>' +
                '</td>';
            tbody.appendChild(tr);
        });
    }

    db.collection('contactMessages')
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get()
        .catch(function() {
            return db.collection('contactMessages').limit(200).get();
        })
        .then(function(snap) {
            var rows = [];
            snap.forEach(function(doc) {
                rows.push({ id: doc.id, data: doc.data() });
            });
            renderRows(rows);
        })
        .catch(function(err) {
            console.error(err);
            if (cnt) cnt.textContent = '(—)';
            tbody.innerHTML =
                '<tr><td colspan="6" class="text-danger text-center py-4">Could not load messages.</td></tr>';
        });
}

if ($('contactMessagesBody')) {
    $('contactMessagesBody').addEventListener('click', function(ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('.btn-del-contact-msg') : null;
        if (!t) return;
        var id = t.getAttribute('data-id');
        if (!id) return;
        if (!confirm('Delete this contact message permanently?')) return;
        db.collection('contactMessages')
            .doc(id)
            .delete()
            .then(function() {
                loadContactMessages();
            })
            .catch(function(err) {
                alert(err && err.message ? err.message : 'Could not delete.');
            });
    });
}

if ($('btnRefreshContactMessages')) {
    $('btnRefreshContactMessages').addEventListener('click', loadContactMessages);
}

/** Punch kiosk sessions — gymPunchSessions (admin-only list in Firestore). */
function adminFormatPunchDur(totalMins) {
    if (totalMins == null || isNaN(totalMins)) return '\u2014';
    var h = Math.floor(totalMins / 60);
    var m = totalMins % 60;
    return h + 'h ' + String(m).padStart(2, '0') + 'm';
}

/** Decimal hours (two places) for hourly wage math — kiosk duration only. */
function punchHoursMinsToDecimalHoursForWage(mins) {
    if (mins == null || isNaN(mins) || mins < 1) return null;
    return Math.round((mins / 60) * 100) / 100;
}

/** dateKey YYYY-MM-DD → Monday YYYY-MM-DD of that week (local calendar). */
function punchHoursDateKeyToMondayKey(dateKey) {
    var p = String(dateKey || '').split('-');
    if (p.length !== 3) return dateKey || '';
    var y = parseInt(p[0], 10);
    var m = parseInt(p[1], 10) - 1;
    var day = parseInt(p[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(day)) return dateKey || '';
    var d = new Date(y, m, day);
    var dow = d.getDay();
    var diff = dow === 0 ? -6 : 1 - dow;
    d.setDate(d.getDate() + diff);
    return d.getFullYear() + '-' + adminPad2(d.getMonth() + 1) + '-' + adminPad2(d.getDate());
}

function punchHoursWeekRangeLabel(mondayKey) {
    var p = String(mondayKey || '').split('-');
    if (p.length !== 3) return mondayKey || '';
    var y = parseInt(p[0], 10);
    var mo = parseInt(p[1], 10) - 1;
    var da = parseInt(p[2], 10);
    if (isNaN(y) || isNaN(mo) || isNaN(da)) return mondayKey || '';
    var d0 = new Date(y, mo, da);
    var d1 = new Date(y, mo, da);
    d1.setDate(d1.getDate() + 6);
    var o = { month: 'short', day: 'numeric' };
    return (
        'Mon ' +
        d0.toLocaleDateString(undefined, o) +
        ' \u2013 Sun ' +
        d1.toLocaleDateString(undefined, Object.assign({ year: 'numeric' }, o))
    );
}

function punchTotalCompletedMinutesFromDoc(d) {
    if (Array.isArray(d.completedVisits)) {
        var s = 0;
        d.completedVisits.forEach(function(v) {
            if (v && typeof v.minutesOnSite === 'number' && v.minutesOnSite >= 1) s += v.minutesOnSite;
        });
        return s;
    }
    if ((d.status || '') === 'completed' && typeof d.minutesOnSite === 'number' && d.minutesOnSite >= 1) {
        return d.minutesOnSite;
    }
    return 0;
}

function adminMondayOfWeekLocalFromDate(dt) {
    var d = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    var day = d.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d;
}

function punchHoursBuildDailyTableRows(filteredParentRows) {
    var list = [];
    filteredParentRows.forEach(function(row) {
        var d = row.d;
        var mins = punchTotalCompletedMinutesFromDoc(d);
        if (mins < 1) return;
        var dk = (d.dateKey || '').trim();
        var nm = (d.displayName && String(d.displayName).trim()) || (d.subjectUid || row.id);
        list.push({
            sortKey: dk + '\0' + nm,
            periodLabel: dk,
            displayName: nm,
            role: (d.role || '').trim(),
            minutes: mins
        });
    });
    list.sort(function(a, b) {
        return a.sortKey.localeCompare(b.sortKey);
    });
    return list;
}

function punchHoursBuildWeeklyTableRows(filteredParentRows) {
    var map = {};
    filteredParentRows.forEach(function(row) {
        var d = row.d;
        var mins = punchTotalCompletedMinutesFromDoc(d);
        if (mins < 1) return;
        var dk = (d.dateKey || '').trim();
        if (!dk) return;
        var wk = punchHoursDateKeyToMondayKey(dk);
        var uid = (d.subjectUid || '').trim() || row.id;
        var key = uid + '|' + wk;
        if (!map[key]) {
            var nm = (d.displayName && String(d.displayName).trim()) || uid;
            map[key] = {
                weekKey: wk,
                sortKey: wk + '\0' + nm,
                periodLabel: punchHoursWeekRangeLabel(wk),
                displayName: nm,
                role: (d.role || '').trim(),
                minutes: 0
            };
        }
        map[key].minutes += mins;
    });
    var list = Object.keys(map).map(function(k) {
        return map[k];
    });
    list.sort(function(a, b) {
        return a.sortKey.localeCompare(b.sortKey);
    });
    return list;
}

function punchHoursSetTotalSummary(totalMins) {
    var el = $('punchHoursTotalSummary');
    if (!el) return;
    if (totalMins == null || totalMins < 1) {
        el.innerHTML = '';
        el.classList.add('d-none');
        return;
    }
    var dec = punchHoursMinsToDecimalHoursForWage(totalMins);
    el.classList.remove('d-none');
    el.innerHTML =
        'Total for selected range (filters applied): <span class="hours-decimal">' +
        (dec != null ? dec.toFixed(2) : '\u2014') +
        '</span> decimal hrs · ' +
        escHtml(adminFormatPunchDur(totalMins));
}

function punchHoursSingleTableRender(filteredRows, granularity) {
    var tbody = $('punchHoursTableBody');
    if (!tbody) return;
    var rows =
        granularity === 'week' ? punchHoursBuildWeeklyTableRows(filteredRows) : punchHoursBuildDailyTableRows(filteredRows);
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="5" class="text-center text-muted py-3">No completed visit time in this range. Adjust dates, view, or filters.</td></tr>';
        punchHoursSetTotalSummary(null);
        return;
    }
    var totalMins = rows.reduce(function(sum, r) {
        var m = r.minutes;
        return sum + (typeof m === 'number' && !isNaN(m) ? m : 0);
    }, 0);
    punchHoursSetTotalSummary(totalMins);
    tbody.innerHTML = '';
    rows.forEach(function(r) {
        var dec = punchHoursMinsToDecimalHoursForWage(r.minutes);
        var tr = document.createElement('tr');
        tr.innerHTML =
            '<td class="text-nowrap">' +
            escHtml(r.periodLabel) +
            '</td><td>' +
            escHtml(r.displayName) +
            '</td><td>' +
            escHtml(r.role || '\u2014') +
            '</td><td class="text-nowrap"><span class="hours-decimal">' +
            (dec != null ? dec.toFixed(2) : '\u2014') +
            '</span></td><td class="text-muted">' +
            escHtml(adminFormatPunchDur(r.minutes)) +
            '</td>';
        tbody.appendChild(tr);
    });
}

function fetchPunchAttendanceCache(forceReload) {
    if (!forceReload && punchAttendanceCachedRows != null) {
        return Promise.resolve(punchAttendanceCachedRows);
    }
    return db
        .collection('gymPunchSessions')
        /** New kiosk writes omit top-level checkInAt; all rows have dateKey. */
        .orderBy('dateKey', 'desc')
        .limit(1200)
        .get()
        .then(function(snap) {
            var rows = [];
            snap.forEach(function(doc) {
                rows.push({ id: doc.id, d: doc.data() });
            });
            punchAttendanceCachedRows = rows;
            return rows;
        });
}

function punchAdminFmtTs(ts) {
    if (!ts || typeof ts.toDate !== 'function') return '\u2014';
    try {
        return ts.toDate().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
        return '\u2014';
    }
}

function punchAdminFmtTimeOnly(ts) {
    if (!ts || typeof ts.toDate !== 'function') return '\u2014';
    try {
        return ts.toDate().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
        return '\u2014';
    }
}

var punchAttendanceCachedRows = null;
var punchSearchDebounceTimer = null;
var punchHoursSearchDebounceTimer = null;

function punchAttendanceMatchesSearch(d, rowId, qLower) {
    if (!qLower) return true;
    var blob = (
        [
            (d.displayName || ''),
            (d.email || ''),
            (d.gymPublicId || ''),
            (d.subjectUid || ''),
            rowId || '',
            d.role || ''
        ].join('\n')
    ).toLowerCase();
    return blob.indexOf(qLower) >= 0;
}

function punchAttendanceFilterRows(rows, roleF, fromK, toK, qLower) {
    return rows.filter(function(row) {
        var dRow = row.d;
        if (roleF && dRow.role !== roleF) return false;
        var dk = dRow.dateKey || '';
        if (fromK && dk < fromK) return false;
        if (toK && dk > toK) return false;
        if (!punchAttendanceMatchesSearch(dRow, row.id, qLower)) return false;
        return true;
    });
}

function punchDocToExpandedAttendanceRows(parentRow) {
    var d = parentRow.d;
    var out = [];
    if (Array.isArray(d.completedVisits) && d.completedVisits.length) {
        d.completedVisits.forEach(function(v, i) {
            out.push({ parent: parentRow, visit: v, visitNum: i + 1, open: false });
        });
    } else if ((d.status || '') === 'completed' && typeof d.minutesOnSite === 'number') {
        out.push({
            parent: parentRow,
            visit: { checkInAt: d.checkInAt, checkOutAt: d.checkOutAt, minutesOnSite: d.minutesOnSite },
            visitNum: 1,
            open: false
        });
    }
    if (d.currentCheckIn != null) {
        out.push({
            parent: parentRow,
            visit: { checkInAt: d.currentCheckIn, checkOutAt: null, minutesOnSite: null },
            visitNum: (Array.isArray(d.completedVisits) ? d.completedVisits.length : 0) + 1,
            open: true
        });
    } else if ((d.status || '') === 'open' && d.checkInAt && !Array.isArray(d.completedVisits)) {
        out.push({
            parent: parentRow,
            visit: { checkInAt: d.checkInAt, checkOutAt: null, minutesOnSite: null },
            visitNum: 1,
            open: true
        });
    }
    if (!out.length) {
        out.push({ parent: parentRow, visit: null, visitNum: '\u2014', open: false, empty: true });
    }
    return out;
}

function punchAttendanceRenderFilteredRows(rows) {
    var tbody = $('punchAttendanceBody');
    if (!tbody) return;
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="5" class="text-center text-muted py-2">No sessions for this filter.</td></tr>';
        return;
    }
    var flat = [];
    rows.forEach(function(pr) {
        punchDocToExpandedAttendanceRows(pr).forEach(function(r) {
            flat.push(r);
        });
    });
    tbody.innerHTML = '';
    flat.forEach(function(er) {
        var d = er.parent.d;
        var tr = document.createElement('tr');
        if (er.empty) {
            tr.innerHTML =
                '<td>' +
                escHtml(d.dateKey || '') +
                '</td><td colspan="4" class="text-muted py-2">No visit data on this row</td>';
            tbody.appendChild(tr);
            return;
        }
        var v = er.visit;
        var outCell = '\u2014';
        if (v && v.checkOutAt) {
            outCell = punchAdminFmtTimeOnly(v.checkOutAt);
        }
        tr.innerHTML =
            '<td>' +
            escHtml(d.dateKey || '') +
            '</td><td>' +
            escHtml(d.displayName || '') +
            '</td><td>' +
            escHtml(d.gymPublicId || '') +
            '</td><td>' +
            escHtml(v ? punchAdminFmtTimeOnly(v.checkInAt) : '\u2014') +
            '</td><td>' +
            escHtml(outCell) +
            '</td>';
        tbody.appendChild(tr);
    });
}

function loadAdminPunchAttendance(forceReload) {
    forceReload = !!forceReload;
    var tbody = $('punchAttendanceBody');
    var fromEl = $('punchAdminFilterFrom');
    var toEl = $('punchAdminFilterTo');
    if (fromEl && toEl && !fromEl.value && !toEl.value) {
        var now = new Date();
        var y = now.getFullYear();
        var m = String(now.getMonth() + 1).padStart(2, '0');
        var day = String(now.getDate()).padStart(2, '0');
        toEl.value = y + '-' + m + '-' + day;
        var f = new Date(now);
        f.setDate(f.getDate() - 14);
        var fy = f.getFullYear();
        var fm = String(f.getMonth() + 1).padStart(2, '0');
        var fd = String(f.getDate()).padStart(2, '0');
        fromEl.value = fy + '-' + fm + '-' + fd;
    }

    var roleF = ($('punchAdminFilterRole') && $('punchAdminFilterRole').value) || '';
    var fromK = ($('punchAdminFilterFrom') && $('punchAdminFilterFrom').value) || '';
    var toK = ($('punchAdminFilterTo') && $('punchAdminFilterTo').value) || '';
    var qLower = (($('punchAdminSearch') && $('punchAdminSearch').value) || '').trim().toLowerCase();

    if (!tbody) return;

    var applyDetail = function() {
        var filtered = punchAttendanceFilterRows(punchAttendanceCachedRows, roleF, fromK, toK, qLower);
        punchAttendanceRenderFilteredRows(filtered);
    };

    if (!forceReload && punchAttendanceCachedRows != null) {
        applyDetail();
        return;
    }

    tbody.innerHTML =
        '<tr><td colspan="5" class="text-center text-muted py-2">Loading\u2026</td></tr>';

    fetchPunchAttendanceCache(true)
        .then(function() {
            applyDetail();
        })
        .catch(function(err) {
            console.error(err);
            punchAttendanceCachedRows = null;
            tbody.innerHTML =
                '<tr><td colspan="5" class="text-center text-danger py-2">Could not load punch data.</td></tr>';
        });
}

function loadAdminPunchHoursView(forceReload) {
    forceReload = !!forceReload;
    var tbody = $('punchHoursTableBody');
    var fromEl = $('punchHoursFilterFrom');
    var toEl = $('punchHoursFilterTo');
    if (fromEl && toEl && !fromEl.value && !toEl.value) {
        var now = new Date();
        var y = now.getFullYear();
        var m = String(now.getMonth() + 1).padStart(2, '0');
        var day = String(now.getDate()).padStart(2, '0');
        toEl.value = y + '-' + m + '-' + day;
        var f = new Date(now);
        f.setDate(f.getDate() - 14);
        var fy = f.getFullYear();
        var fm = String(f.getMonth() + 1).padStart(2, '0');
        var fd = String(f.getDate()).padStart(2, '0');
        fromEl.value = fy + '-' + fm + '-' + fd;
    }

    var roleF = ($('punchHoursFilterRole') && $('punchHoursFilterRole').value) || '';
    var fromK = (fromEl && fromEl.value) || '';
    var toK = (toEl && toEl.value) || '';
    var qLower = (($('punchHoursSearch') && $('punchHoursSearch').value) || '').trim().toLowerCase();
    var gran = ($('punchHoursGranularity') && $('punchHoursGranularity').value) || 'day';

    if (!tbody) return;

    var applyHours = function() {
        var filtered = punchAttendanceFilterRows(punchAttendanceCachedRows, roleF, fromK, toK, qLower);
        punchHoursSingleTableRender(filtered, gran);
    };

    if (!forceReload && punchAttendanceCachedRows != null) {
        applyHours();
        return;
    }

    punchHoursSetTotalSummary(null);
    tbody.innerHTML =
        '<tr><td colspan="5" class="text-center text-muted py-3">Loading\u2026</td></tr>';

    fetchPunchAttendanceCache(true)
        .then(function() {
            applyHours();
        })
        .catch(function(err) {
            console.error(err);
            punchAttendanceCachedRows = null;
            punchHoursSetTotalSummary(null);
            tbody.innerHTML =
                '<tr><td colspan="5" class="text-center text-danger py-3">Could not load punch data.</td></tr>';
        });
}

function loadAdminPunchHoursDebounced() {
    clearTimeout(punchHoursSearchDebounceTimer);
    punchHoursSearchDebounceTimer = setTimeout(function() {
        loadAdminPunchHoursView(false);
    }, 280);
}

function punchHoursSetThisWeekFilters() {
    var mon = adminMondayOfWeekLocalFromDate(new Date());
    var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    var f = $('punchHoursFilterFrom');
    var t = $('punchHoursFilterTo');
    if (f) f.value = adminFormatYMD(mon);
    if (t) t.value = adminFormatYMD(sun);
    loadAdminPunchHoursView(false);
}

function loadAdminPunchAttendanceDebounced() {
    clearTimeout(punchSearchDebounceTimer);
    punchSearchDebounceTimer = setTimeout(function() {
        loadAdminPunchAttendance(false);
    }, 280);
}

if ($('btnRefreshPunchAttendance')) {
    $('btnRefreshPunchAttendance').addEventListener('click', function() {
        loadAdminPunchAttendance(true);
    });
}
if ($('punchAdminFilterRole')) $('punchAdminFilterRole').addEventListener('change', function() {
    loadAdminPunchAttendance(false);
});
if ($('punchAdminFilterFrom'))
    $('punchAdminFilterFrom').addEventListener('change', function() {
        loadAdminPunchAttendance(false);
    });
if ($('punchAdminFilterTo'))
    $('punchAdminFilterTo').addEventListener('change', function() {
        loadAdminPunchAttendance(false);
    });
if ($('punchAdminSearch')) $('punchAdminSearch').addEventListener('input', loadAdminPunchAttendanceDebounced);

if ($('btnRefreshPunchHours')) {
    $('btnRefreshPunchHours').addEventListener('click', function() {
        loadAdminPunchHoursView(true);
    });
}
if ($('btnPunchHoursThisWeek')) {
    $('btnPunchHoursThisWeek').addEventListener('click', punchHoursSetThisWeekFilters);
}
if ($('punchHoursFilterRole')) {
    $('punchHoursFilterRole').addEventListener('change', function() {
        loadAdminPunchHoursView(false);
    });
}
if ($('punchHoursFilterFrom')) {
    $('punchHoursFilterFrom').addEventListener('change', function() {
        loadAdminPunchHoursView(false);
    });
}
if ($('punchHoursFilterTo')) {
    $('punchHoursFilterTo').addEventListener('change', function() {
        loadAdminPunchHoursView(false);
    });
}
if ($('punchHoursGranularity')) {
    $('punchHoursGranularity').addEventListener('change', function() {
        loadAdminPunchHoursView(false);
    });
}
if ($('punchHoursSearch')) {
    $('punchHoursSearch').addEventListener('input', loadAdminPunchHoursDebounced);
}
