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
`README.md` and the `docs/` folder. Files that start with a dot (`.gitignore`)
and `_config.yml` itself are never published.

When you add a file to the repository root that is not part of the app, add it
to that list as well.

## Before you publish

- The "Buy me a coffee" link in `<aside id="corner">` in `index.html` is
  commented out until there is an address for it. Replace its `#TODO` and
  uncomment it. (`app.js` swallows clicks on any `#TODO` link, because
  following one would overwrite the hash that holds the countdown.)
- The "Source" link points at the GitHub repository, so it only works for
  visitors once the repository is public.
- The ad container (`<div id="ad">`) is empty and hidden. If you ever fill it,
  the ad must sit in a sandboxed `<iframe>`. A third-party script running in
  the page itself can read `location.hash` and would leak the user's goals.
- There is deliberately no web app manifest: its `start_url` could replace the
  current URL and drop the state.

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
- [ ] Edit, then check the title updates, the URL updates, and the "re-bookmark" hint appears.

## Out of scope for v1

Done/not-done goals, several countdowns per page, a live countdown in the tab
title, a web app manifest or service worker, accounts or sync, notifications,
ads or analytics scripts, and the Temporal API.
