/* ═══════════════════════════════════════
   DaDaGym — Login / register → dashboard redirect
   ═══════════════════════════════════════ */

import { firebaseConfig } from './firebase-config.js';

firebase.initializeApp(firebaseConfig);

var auth = firebase.auth();
var db   = firebase.firestore();

var $ = function(id) { return document.getElementById(id); };

var authGate   = $('authGate');
var postAuth   = $('postAuth');
var redirectPanel = $('redirectPanel');
var verifyPanel   = $('verifyPanel');
var trainerPendingPanel = $('trainerPendingPanel');
var userEmail  = $('userEmail');
var btnLogout  = $('btnLogout');

var loginForm      = $('loginForm');
var registerForm   = $('registerForm');
var trainerRegForm = $('trainerRegForm');
var authAlert      = $('authAlert');

var loginPhase           = $('loginPhase');
var registerChoicePhase   = $('registerChoicePhase');
var registerCtaWrap       = $('registerCtaWrap');
var authTitle             = $('authTitle');
var authSubtitle          = $('authSubtitle');
var btnOpenRegisterChoices = $('btnOpenRegisterChoices');
var btnRegChoiceMember    = $('btnRegChoiceMember');
var btnRegChoiceTrainer   = $('btnRegChoiceTrainer');
var btnBackToSignInFromChoice = $('btnBackToSignInFromChoice');
var btnBackFromMemberReg  = $('btnBackFromMemberReg');
var btnBackFromTrainerReg = $('btnBackFromTrainerReg');

var BOOK_LOGIN_HINT =
    'To book a lesson or class session, sign in to your member account (or register as a member). You can book from your dashboard after logging in.';

var TITLE_LOGIN         = 'User login';
var TITLE_REGISTER_MENU = 'Create an account';
var TITLE_MEMBER_REG    = 'Register as Member';
var TITLE_TRAINER_REG   = 'Register as Trainer';

var SUB_LOGIN          = 'Sign in to access your dashboard';
var SUB_REGISTER_MENU  = 'Choose how you\'d like to register';
var SUB_MEMBER_REG     = 'Enter your details to get started';
var SUB_TRAINER_REG    = 'Submit your profile for admin approval';

function setPostAuthPanels(showRedirect, showVerify, showTrainerPending) {
    if (redirectPanel) redirectPanel.classList.toggle('d-none', !showRedirect);
    if (verifyPanel) verifyPanel.classList.toggle('d-none', !showVerify);
    if (trainerPendingPanel) trainerPendingPanel.classList.toggle('d-none', !showTrainerPending);
}

function setAuthHeader(title, subtitle) {
    if (authTitle && title) authTitle.textContent = title;
    if (authSubtitle) authSubtitle.textContent = subtitle || '';
}

function hideForgotRestoreLogin() {
    var forgotPassBox = $('forgotPassBox');
    if (forgotPassBox) forgotPassBox.classList.add('d-none');
    if (loginForm) loginForm.classList.remove('d-none');
}

function showLoginPhaseOnly() {
    hideForgotRestoreLogin();
    if (loginPhase) loginPhase.classList.remove('d-none');
    if (registerChoicePhase) registerChoicePhase.classList.add('d-none');
    if (registerForm) registerForm.classList.add('d-none');
    if (trainerRegForm) trainerRegForm.classList.add('d-none');
    if (registerCtaWrap) registerCtaWrap.classList.remove('d-none');
    if (authAlert) authAlert.classList.add('d-none');
    setAuthHeader(TITLE_LOGIN, SUB_LOGIN);
}

function showRegisterChoicePhase() {
    hideForgotRestoreLogin();
    if (loginPhase) loginPhase.classList.add('d-none');
    if (registerChoicePhase) registerChoicePhase.classList.remove('d-none');
    if (registerForm) registerForm.classList.add('d-none');
    if (trainerRegForm) trainerRegForm.classList.add('d-none');
    if (authAlert) authAlert.classList.add('d-none');
    setAuthHeader(TITLE_REGISTER_MENU, SUB_REGISTER_MENU);
}

function showMemberRegisterForm() {
    if (loginPhase) loginPhase.classList.add('d-none');
    if (registerChoicePhase) registerChoicePhase.classList.add('d-none');
    if (registerForm) registerForm.classList.remove('d-none');
    if (trainerRegForm) trainerRegForm.classList.add('d-none');
    if (authAlert) authAlert.classList.add('d-none');
    setAuthHeader(TITLE_MEMBER_REG, SUB_MEMBER_REG);
}

function showTrainerRegisterForm() {
    if (loginPhase) loginPhase.classList.add('d-none');
    if (registerChoicePhase) registerChoicePhase.classList.add('d-none');
    if (registerForm) registerForm.classList.add('d-none');
    if (trainerRegForm) trainerRegForm.classList.remove('d-none');
    if (authAlert) authAlert.classList.add('d-none');
    setAuthHeader(TITLE_TRAINER_REG, SUB_TRAINER_REG);
}

if (btnOpenRegisterChoices) {
    btnOpenRegisterChoices.addEventListener('click', function() { showRegisterChoicePhase(); });
}
if (btnRegChoiceMember) {
    btnRegChoiceMember.addEventListener('click', function() { showMemberRegisterForm(); });
}
if (btnRegChoiceTrainer) {
    btnRegChoiceTrainer.addEventListener('click', function() { showTrainerRegisterForm(); });
}
if (btnBackToSignInFromChoice) {
    btnBackToSignInFromChoice.addEventListener('click', function() { showLoginPhaseOnly(); });
}
if (btnBackFromMemberReg) {
    btnBackFromMemberReg.addEventListener('click', function() { showRegisterChoicePhase(); });
}
if (btnBackFromTrainerReg) {
    btnBackFromTrainerReg.addEventListener('click', function() { showRegisterChoicePhase(); });
}

if (window.location.hash === '#register') {
    showRegisterChoicePhase();
} else if (window.location.hash === '#trainer') {
    showTrainerRegisterForm();
}

function showAlert(el, msg, type) {
    if (!el) return;
    el.className = 'alert alert-' + type;
    el.textContent = msg;
    el.classList.remove('d-none');
}

(function showLoginGateHintFromQuery() {
    var box = $('loginGateHint');
    var txt = $('loginGateHintText');
    if (!box || !txt) return;
    try {
        var p = new URLSearchParams(window.location.search || '');
        if ((p.get('from') || '').toLowerCase() !== 'book') return;
        txt.textContent = BOOK_LOGIN_HINT;
        box.classList.remove('d-none');
        if (window.history && typeof window.history.replaceState === 'function') {
            var path = window.location.pathname || 'login.html';
            var hash = window.location.hash || '';
            window.history.replaceState(null, '', path + hash);
        }
    } catch (e) {
        /* ignore */
    }
})();

/* ─── Auth: Login ─── */
if (loginForm) {
    loginForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var email = $('loginEmail').value.trim();
        var pass  = $('loginPass').value;
        auth.signInWithEmailAndPassword(email, pass)
            .catch(function(err) { showAlert(authAlert, err.message, 'danger'); });
    });
}

/* ─── Auth: Member Register ─── */
if (registerForm) {
    registerForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var name  = $('regName').value.trim();
        var email = $('regEmail').value.trim();
        var phone = $('regPhone').value.trim();
        var pass  = $('regPass').value;

        if (pass.length < 6) {
            showAlert(authAlert, 'Password must be at least 6 characters.', 'warning');
            return;
        }

        auth.createUserWithEmailAndPassword(email, pass)
            .then(function(cred) {
                return db.collection('members').doc(cred.user.uid).set({
                    displayName: name,
                    email: email,
                    phone: phone,
                    plan: 'Basic',
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                }).then(function() { return cred.user.sendEmailVerification(); }).then(function() {
                    if (authAlert) authAlert.classList.add('d-none');
                });
            })
            .catch(function(err) { showAlert(authAlert, err.message, 'danger'); });
    });
}

/* ─── Auth: Trainer Register ─── */
if (trainerRegForm) {
    trainerRegForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var name   = $('tRegName').value.trim();
        var email  = $('tRegEmail').value.trim();
        var phone  = $('tRegPhone').value.trim();
        var spec   = $('tRegSpecialization').value;
        var exp    = parseInt($('tRegExperience').value, 10) || 0;
        var qual   = $('tRegQualifications').value.trim();
        var bio    = $('tRegBio').value.trim();
        var pass   = $('tRegPass').value;
        var pass2  = $('tRegPassConfirm') ? $('tRegPassConfirm').value : '';

        if (pass.length < 6) {
            showAlert(authAlert, 'Password must be at least 6 characters.', 'warning');
            return;
        }
        if (pass !== pass2) {
            showAlert(authAlert, 'Passwords do not match.', 'warning');
            return;
        }

        auth.createUserWithEmailAndPassword(email, pass)
            .then(function(cred) {
                return db.collection('trainers').doc(cred.user.uid).set({
                    displayName: name,
                    email: email,
                    phone: phone,
                    specialization: spec,
                    experience: exp,
                    qualifications: qual,
                    bio: bio,
                    approvalStatus: 'pending',
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                }).then(function() { return cred.user.sendEmailVerification(); }).then(function() {
                    if (authAlert) authAlert.classList.add('d-none');
                });
            })
            .catch(function(err) { showAlert(authAlert, err.message, 'danger'); });
    });
}

/* ─── Forgot password ─── */
var forgotPassLink = $('forgotPassLink');
var forgotPassBox  = $('forgotPassBox');
var backToLogin    = $('backToLogin');
var btnSendReset   = $('btnSendReset');
var resetAlert     = $('resetAlert');

if (forgotPassLink && loginForm && forgotPassBox) {
    forgotPassLink.addEventListener('click', function(e) {
        e.preventDefault();
        loginForm.classList.add('d-none');
        forgotPassBox.classList.remove('d-none');
        if (registerCtaWrap) registerCtaWrap.classList.add('d-none');
        if (resetAlert) resetAlert.classList.add('d-none');
    });
}
if (backToLogin && loginForm && forgotPassBox) {
    backToLogin.addEventListener('click', function(e) {
        e.preventDefault();
        forgotPassBox.classList.add('d-none');
        loginForm.classList.remove('d-none');
        if (registerCtaWrap) registerCtaWrap.classList.remove('d-none');
    });
}
if (btnSendReset) {
    btnSendReset.addEventListener('click', function() {
        var email = $('resetEmail') ? $('resetEmail').value.trim() : '';
        if (!email) {
            showAlert(resetAlert, 'Enter your email.', 'warning');
            return;
        }
        auth.sendPasswordResetEmail(email)
            .then(function() {
                showAlert(resetAlert, 'Check your inbox for the reset link.', 'success');
            })
            .catch(function(err) {
                showAlert(resetAlert, err.message, 'danger');
            });
    });
}

/* ─── Email verification ─── */
var btnResendVerify = $('btnResendVerify');
var btnCheckVerify  = $('btnCheckVerify');
var verifyAlert     = $('verifyAlert');

if (btnResendVerify) {
    btnResendVerify.addEventListener('click', function() {
        var u = auth.currentUser;
        if (!u) return;
        u.reload()
            .then(function() {
                var cur = auth.currentUser;
                if (!cur) throw new Error('Session expired — sign in again.');
                if (cur.emailVerified) {
                    if (verifyAlert) showAlert(verifyAlert, 'Email already verified. Continuing…', 'success');
                    routeAfterLogin(cur);
                    return null;
                }
                return cur.sendEmailVerification();
            })
            .then(function(v) {
                if (v === null) return;
                if (verifyAlert) showAlert(verifyAlert, 'Verification email sent.', 'success');
            })
            .catch(function(err) {
                var code = err && err.code;
                if (verifyAlert && code === 'auth/too-many-requests') {
                    showAlert(
                        verifyAlert,
                        'Firebase rate-limited the send request, but your mail may already be on its way — check inbox and spam, then tap "I\'ve Verified".',
                        'warning'
                    );
                    return;
                }
                if (verifyAlert) showAlert(verifyAlert, err && err.message ? err.message : 'Could not send email.', 'danger');
            });
    });
}
if (btnCheckVerify) {
    btnCheckVerify.addEventListener('click', function() {
        var u = auth.currentUser;
        if (!u) return;
        u.reload()
            .then(function() {
                if (auth.currentUser.emailVerified) {
                    routeAfterLogin(auth.currentUser);
                } else if (verifyAlert) {
                    showAlert(verifyAlert, 'Email not verified yet.', 'warning');
                }
            })
            .catch(function(err) {
                if (verifyAlert) showAlert(verifyAlert, err.message, 'danger');
            });
    });
}

function routeAfterLogin(user) {
    var uid = user.uid;
    if (postAuth) postAuth.classList.remove('d-none');

    if (!user.emailVerified) {
        setPostAuthPanels(false, true, false);
        var ve = $('verifyEmailAddr');
        if (ve) ve.textContent = user.email || '';
        return;
    }

    setPostAuthPanels(true, false, false);

    db.collection('admins').doc(uid).get()
        .then(function(adminDoc) {
            if (adminDoc.exists) {
                window.location.href = 'admin.html';
                return null;
            }
            return db.collection('users').doc(uid).get();
        })
        .then(function(uDoc) {
            if (!uDoc) return null;
            if (uDoc.exists) {
                var role = uDoc.data().role;
                if (role === 'admin') {
                    window.location.href = 'admin.html';
                    return null;
                }
                if (role === 'trainer') {
                    window.location.href = 'trainer.html';
                    return null;
                }
            }
            return db.collection('trainers').doc(uid).get();
        })
        .then(function(tDoc) {
            if (!tDoc) return;
            if (tDoc.exists) {
                var status = tDoc.data().approvalStatus;
                if (status === 'approved') {
                    window.location.href = 'trainer.html';
                    return;
                }
                setPostAuthPanels(false, false, true);
                var colors = { pending: 'warning', rejected: 'danger' };
                var label  = (status || 'pending').charAt(0).toUpperCase() + (status || 'pending').slice(1);
                var el = $('trainerPendingStatus');
                if (el) {
                    el.innerHTML =
                        '<span class="badge bg-' + (colors[status] || 'secondary') + ' fs-6">' + label + '</span>';
                }
                return;
            }
            window.location.href = 'member.html';
        })
        .catch(function(err) {
            console.error(err);
            if (authAlert) {
                authGate.classList.remove('d-none');
                if (postAuth) postAuth.classList.add('d-none');
                showAlert(authAlert, err.message || 'Could not finish sign-in. Try again.', 'danger');
            }
        });
}

/* ─── Auth state listener ─── */
auth.onAuthStateChanged(function(user) {
    if (!user) {
        if (authGate) authGate.classList.remove('d-none');
        if (postAuth) postAuth.classList.add('d-none');
        if (userEmail) userEmail.classList.add('d-none');
        if (btnLogout) btnLogout.classList.add('d-none');
        return;
    }
    if (authGate) authGate.classList.add('d-none');
    if (userEmail) {
        userEmail.textContent = user.email || '';
        userEmail.classList.remove('d-none');
    }
    if (btnLogout) btnLogout.classList.remove('d-none');
    routeAfterLogin(user);
});

if (btnLogout) {
    btnLogout.addEventListener('click', function() {
        var modalEl = $('logoutConfirmModal');
        if (!modalEl || typeof bootstrap === 'undefined') {
            if (window.confirm('Are you sure you want to log out?')) auth.signOut();
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
        auth.signOut();
    });
}
