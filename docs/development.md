# Development notes

Project housekeeping for Dwindle: deploying, what to do before publishing, the
manual test checklist and what was left out of v1. For what the app is and how
the link format works, see the [README](../README.md).

## Deploy to GitHub Pages

1. Push to the `main` branch of the `dwindle` repository. `main` is the deploy
   branch: whatever is on it is what is live.
2. One-time setup: in the repository, open **Settings → Pages**. Under **Build
   and deployment**, set **Source** to **Deploy from a branch**, choose
   **`main`** and **`/ (root)`**, and save.
3. After a minute the app is live at `https://<user>.github.io/dwindle/`.

All asset paths are relative, so the app works from that sub-path without
changes.

### What gets published

GitHub Pages publishes the whole branch, so repository-only files have to be
kept out explicitly. `_config.yml` lists them under `exclude`: currently
`README.md`, `LICENSE.txt` and the `docs/` folder. Files that start with a dot
(`.gitignore`) and `_config.yml` itself are never published.

When you add a file to the repository root that is not part of the app, add it
to that list as well.

## Before you publish

- The ad container (`<div id="ad">`) is empty and hidden. If you ever fill it,
  the ad must sit in a sandboxed `<iframe>`. A third-party script running in
  the page itself can read `location.hash` and would leak the user's goals.
- There is deliberately no web app manifest: its `start_url` could replace the
  current URL and drop the state.

## Offline copy (service worker)

`sw.js` keeps a copy of the app's files in the browser, so Dwindle opens from
the home screen without waiting for the network and works offline. Every file
is answered from the copy at once and fetched again in the background, so a
deploy reaches a device on its **second** launch after the deploy, not the first.

- There is no version number to bump. But when you add, rename or remove an
  app file, update the `FILES` list in `sw.js`: a file missing there still
  works, it is just not available offline until it has been loaded once; a
  listed file that no longer exists makes the copy fail to install.
- The countdown never passes through the service worker: it lives after the
  `#`, which is not part of any request.
- Service workers need `https` or `localhost`. Opening `index.html` as a file
  works as before, just without the offline copy.

## Manual test checklist

- [ ] Create a countdown, reload the page, and the hash and view persist.
- [ ] Open the bare URL in the same browser, and it restores the last countdown from localStorage.
- [ ] Paste a link into a private window, and it renders from the hash alone.
- [ ] Corrupt the hash by hand, and a friendly message appears with no crash.
- [ ] Emoji and umlauts in name and goals round-trip.
- [ ] Set the target to tomorrow, today and yesterday: the passed state and zero state behave.
- [ ] Check across a DST change date: the target is still local midnight.
- [ ] iPad/iPhone: add to the home screen with a hash in place, open it from the icon, and confirm the countdown loads. If standalone mode drops the hash, flip `STATE_MODE` to `'query'` and retest.
- [ ] iPad/iPhone: edit the countdown inside the home screen app, close the app completely, and open it from the icon again. The edit is still there.
- [ ] Edit, then check the title updates and the URL updates. Press Done: the editor closes and the "re-bookmark" hint appears.
- [ ] Getting close: in the last quarter of its span (at most the last 30 days) a countdown shows a yellow "Getting close" tag.
- [ ] Final stretch: in the last tenth of its span (at most the last 7 days, at least the last day) the tag turns red, reads "Time is almost up", and the day number turns red. One day earlier it does not.
- [ ] "% gone" starts at 0% for a new countdown, rises during the day, and reads 100% only once the target is reached.
- [ ] From a countdown, press "New countdown" and create another one. The browser's Back button returns to the first countdown, and Forward to the new one. Editing does not add Back steps.
- [ ] Open the app once, go offline (flight mode), and open it again from the home screen: it loads, with the font.
- [ ] Deploy a visible change: the first launch afterwards still shows the old version, the second the new one.
- [ ] The "until" date ends in the time zone offset (for example `GMT+2`) and stays on one line on a phone.
- [ ] Press Edit on a phone: the page scrolls down to the form.
- [ ] While editing, drag a goal to a new place by its grip (mouse and finger), and move one with the arrow keys while its grip is focused. The new order survives a reload.

## Domain

Dwindle runs at the address GitHub Pages gives it,
`https://<user>.github.io/dwindle/`, and that is enough for now. A custom
domain is neither needed nor planned.

If that changes: the obvious domains for "dwindle" are taken. Two ways out,
neither checked for availability yet:

- **Be creative with the domain.** A domain hack or a less common ending, for
  example `dwindl.ing`, `dwindle.day`, `dwindle.date`, `dwindle.to`, or a
  prefix such as `getdwindle` or `dwindleapp`.
- **Rename the project.** Names in the same spirit: Wane, Ebb, Dayfall,
  Sandglass, Runway, T-minus, Untilthen, Daysleft, Sandfall.

Things to know before moving to another address:

- Every existing link contains the address. GitHub Pages redirects the
  `github.io` address to a custom domain once one is set, and browsers keep
  the `#...` part across that redirect, so old links should keep working.
  Test this before relying on it.
- Browser storage belongs to the address. After a move, the "last countdown"
  and edits remembered for home screen icons do not come along; people open
  their link once on the new address and carry on from there.
- A rename also means new icons, the page title, the `dwindle:` storage keys
  and the repository name.

## Out of scope for v1

Done/not-done goals, several countdowns per page, a live countdown in the tab
title, a web app manifest, accounts or sync, notifications,
ads or analytics scripts, and the Temporal API.

The "Buy me a coffee" link also waits for a later iteration. It is already in
`<aside id="corner">` in `index.html`, commented out: give it its address in
place of `#TODO` and uncomment it. (`app.js` swallows clicks on any `#TODO`
link, because following one would overwrite the hash that holds the
countdown.)

## Ideas for later

Not planned in detail and not started. Written down so they are not lost.

- **A list of countdowns.** Today the browser remembers only the last
  countdown (`dwindle:last`), so opening the bare address brings back just
  that one. The idea is to remember several and let you switch between them.
  Things to settle first: where the list shows without crowding the page;
  whether a countdown joins the list when it is created, edited or merely
  opened; how one is removed; and how it fits with home screen icons, which
  already remember their own latest version. The list would stay in this
  browser only, and every countdown would still be a link of its own. This is
  different from showing several countdowns on one page, which stays out of
  scope.
