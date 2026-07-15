// Shared "is this session actually signed in?" probe for Workday, used by both login.js
// (to know when to save) and verify.js (to report). They must never disagree, so the
// check lives in one place.
//
// POSITIVE EVIDENCE ONLY. Two traps make the obvious checks wrong:
//  - Workday keeps a PLAY_SESSION / CALYPSO_SESSION cookie for ANONYMOUS visitors, so the
//    presence of a session cookie proves nothing.
//  - /candidate_home serves a page to anonymous visitors too (it renders the sign-in form
//    under the same URL), and during load no sign-in button exists yet — so "URL is
//    candidate_home and I see no Sign In button" is true of a logged-out browser mid-render.
// The candidate account UI either exists or it does not; that is what we look for.

const ACCOUNT_ID = /account|signOut|candidateHome|myApplications|jobAlerts/i;
const SIGN_IN_ID = /signIn/i;
const ACCOUNT_TEXT = /my applications|mis solicitudes|my account|mi cuenta|candidate home|sign out|cerrar sesi/i;
const SIGN_IN_TEXT = /sign in|conectar|iniciar sesi/i;

async function probeSession(page) {
  return page.evaluate(({ accountId, signInId, accountText, signInText }) => {
    const reAccountId = new RegExp(accountId, 'i');
    const reSignInId = new RegExp(signInId, 'i');
    const reAccountText = new RegExp(accountText, 'i');
    const reSignInText = new RegExp(signInText, 'i');
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const ids = [...document.querySelectorAll('[data-automation-id]')]
      .map(e => e.getAttribute('data-automation-id') || '');
    const body = norm(document.body ? document.body.innerText : '');
    const head = body.slice(0, 400);
    const account = ids.some(i => reAccountId.test(i)) || reAccountText.test(head);
    const signIn = ids.some(i => reSignInId.test(i)) || reSignInText.test(head);
    return {
      url: location.href,
      title: document.title,
      accountEvidence: account,
      signInEvidence: signIn,
      signedIn: account && !signIn,
      bodyStart: body.slice(0, 220),
    };
  }, {
    accountId: ACCOUNT_ID.source,
    signInId: SIGN_IN_ID.source,
    accountText: ACCOUNT_TEXT.source,
    signInText: SIGN_IN_TEXT.source,
  });
}

module.exports = { probeSession };
