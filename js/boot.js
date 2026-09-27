// ---------------------------------------------------------------------------
// Browser start-up. Split out of js/game.js (review #6 step 8) so the rules load in a
// bare VM without a boundary to cut at: this file is the only one that reads the
// location, builds the page's game and decides what a visitor is shown. Loaded right
// after js/game.js, so its load handler still runs before showcase.js's.
// ---------------------------------------------------------------------------

// A copy served from somewhere else is a SHOWCASE, not an installation.
//
// The analyzer needs no API key and no endpoint -- it reads a file -- which makes it the
// one part of this project that is safe to hand a stranger. The arena and the campaign
// are not: they ask for keys, and a key pasted into a page someone else controls is a
// different proposition from one pasted into a page you are serving yourself, even
// though both only ever keep it in your own browser. So a hosted copy opens straight
// into the analyzer with the bundled match and offers no route to the rest.
//
// The rule is where the page came FROM, not who is looking: served off your own network
// you get everything, served from the public internet you get the showcase. ?full=1 opts
// back in.
//
// It used to be loopback only, which made the tablet in the same room a stranger: serving
// on 192.168.x and opening it from the sofa dropped you into the analyzer with no way to
// start a match. That is a configuration people actually run, and the address it comes
// from is one they own.
//
// What this can and cannot check. The honest test would be "same subnet as the device I
// am holding", but a page only ever sees the address it was SERVED from, never the
// client's own -- WebRTC candidate discovery, the old way of learning it, returns mDNS
// .local placeholders in every current browser. So the test is whether the host is
// private at all: RFC1918, loopback, link-local, IPv6 ULA, an mDNS name, or a
// single-label hostname. None of those are routable from outside.
//
// Parsed as an address rather than matched as a prefix, which matters more than it looks.
// /^192\.168\./ against a hostname also accepts 192.168.1.1.evil.com -- a legal, public,
// resolvable domain -- and would have handed the full app to anyone who registered one.
// An IPv4 literal is therefore matched whole and then judged by its octets, and anything
// that is not a literal has to earn "private" some other way.
//
// Wider than one subnet by exactly the amount that matters: a hostile LAN you did not set
// up -- cafe wifi, a hotel -- could serve a page from a private address and would now
// open the key fields. It still cannot read a key back out; the risk is a page you were
// persuaded to visit AND paste into. Judged worth it against a real configuration being
// locked out, and the case this was built for is unchanged -- github.io is a public name
// with no private form, so it stays a showcase.
const WAR_PRIVATE_HOST = (() => {
    const h = (location.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!h) return false;
    const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const o = v4.slice(1).map(Number);
        if (o.some(n => n > 255)) return false;          // not an address at all
        if (o[0] === 127) return true;                   // loopback
        if (o[0] === 10) return true;                    // 10/8
        if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;   // 172.16/12
        if (o[0] === 192 && o[1] === 168) return true;   // 192.168/16
        if (o[0] === 169 && o[1] === 254) return true;   // link-local
        return false;                                    // every other literal is public
    }
    if (h.indexOf(':') >= 0) {                           // IPv6 literal (DNS names have no colon)
        if (h === '::1') return true;                    // loopback
        if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;  // unique local, fc00::/7
        if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;   // link-local, fe80::/10
        return false;
    }
    if (h === 'localhost' || /\.localhost$/.test(h)) return true;
    if (/\.local$/.test(h)) return true;                  // mDNS / Bonjour
    if (/^[a-z0-9-]+$/.test(h)) return true;             // single-label name: cannot be public
    return false;
})();
const WAR_LOCAL = location.protocol === 'file:' || WAR_PRIVATE_HOST;
const WAR_DEMO_ONLY = !WAR_LOCAL && !/[?&]full=1(&|$)/.test(location.search);

// A renderer that cannot be built used to throw out of here and stop, leaving a page
// that LOOKED fine: the menus are DOM and kept working, so the app invited a match it
// could never draw. Pressing Start then walked into null.clearScene, which is what the
// report "the normal player UI appears and then nothing happens" actually was.
//
// The engine asks for plain WebGL 1, so a machine without it usually has hardware
// acceleration switched off, a blocklisted driver, or no GPU at all (a remote desktop
// session is the classic). None of that is something the page can fix -- but it can say
// so, instead of pretending and failing later.
function warNoWebGL(e) {
    console.error('[boot] renderer unavailable', e);
    const box = document.createElement('div');
    box.className = 'boot-error';
    const p1 = document.createElement('p');
    p1.textContent = t('boot.noWebGL');
    const p2 = document.createElement('p');
    p2.className = 'boot-why';
    p2.textContent = t('boot.noWebGLWhy');
    box.appendChild(p1); box.appendChild(p2);
    document.body.appendChild(box);
    document.body.classList.add('boot-failed');
}

window.addEventListener('load', () => {
    game = new Game();
    try {
        game.init();
    } catch (e) {
        // Only the machine's fault is handled here. Anything else is a bug in the game
        // and must keep its stack rather than be dressed up as a hardware notice.
        if (e && e.noWebGL) { warNoWebGL(e); return; }
        throw e;
    }
    if (WAR_DEMO_ONLY) {
        document.body.classList.add('demo-only');
    }
    const viewerParams = new URLSearchParams(location.search);
    if (viewerParams.has('match') || WAR_DEMO_ONLY) {
        game.ui.anOpen();
        if (viewerParams.has('match')) {
            // A moment in it, if the link names one (review #11).
            const moment = ['t', 'seat', 'turn'].some(k => viewerParams.has(k))
                ? { t: viewerParams.get('t'), seat: viewerParams.get('seat'), turn: viewerParams.get('turn') } : null;
            game.ui.anLoadLinkedMatch(viewerParams.get('match'), moment);
        } else {
            game.ui.anLoadSample();
        }
    }
});
