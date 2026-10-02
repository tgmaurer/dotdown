# Dwindle

A tiny countdown to one date. Give it a name and a target date and it shows the
days, hours, minutes and seconds that are left, plus one small square for every
day of the span, so you can watch the deadline shrink. You can attach a short list of
goals. It is not a task tracker.

There is no backend, no account, no build step and no dependency. It is three
plain files (`index.html`, `style.css`, `app.js`), two icons and one font file
(Commit Mono, served from `fonts/`), and it makes no third-party requests.

## How it works

**The link is the countdown.** The whole state is encoded in the URL hash.
Bookmark or share the link and you have saved or shared the countdown. Someone
who opens your link gets their own copy: their edits change only their URL and
their browser storage.

`localStorage` (`dwindle:last`) remembers the last countdown you created or
edited, so opening the bare URL brings it back. It is a convenience only. The
app works without storage (private mode).

Browsers cannot update an existing bookmark, so after every edit the app shows
a small hint with a "Copy link" button. Re-bookmark to keep the new version.

## State format

JSON, encoded as UTF-8, then base64url without padding, placed after the `#`:

```json
{
  "v": 1,
  "t": "Trip to Japan",
  "d": "2027-03-14",
  "c": "2026-10-02",
  "g": [{ "t": "Book flights" }, { "t": "Learn 50 phrases" }]
}
```

| Key | Meaning |
| --- | --- |
| `v` | Format version. Currently `1`. |
| `t` | Name, up to 60 characters. |
| `d` | Target date, plain `YYYY-MM-DD`. The countdown ends at local midnight at the start of this day. |
| `c` | Creation date, plain `YYYY-MM-DD`. Set to the local date when the countdown is created and never changed by edits. The day grid starts here. |
| `g` | Goals, up to 20, each an object `{ "t": "..." }` of up to 120 characters. Objects rather than strings so that fields can be added later. |

Links live forever, so every decoded payload goes through `migrate(payload)` in
`app.js` before it is used. To change the format, bump `VERSION` and add an
upgrade step there. Old links must keep working.

Decoding is defensive. A damaged hash, bad JSON, an impossible date or an
unknown version shows a friendly message and the create form. Over-long names
and goals are clipped, and goals that are not `{ "t": "text" }` are dropped.

### `STATE_MODE`

`readState()` and `writeState()` are the only functions that know where the
state sits in the URL. The constant `STATE_MODE` at the top of `app.js` picks
the place:

- `'hash'` (default): `https://<user>.github.io/dwindle/#<payload>`
- `'query'`: `https://<user>.github.io/dwindle/?s=<payload>`

`'query'` is the fallback in case iOS drops the hash when the app is opened
from the home screen. Whichever mode is set, links in the other form are still
read, so flipping the constant does not break links that are already out there.

## Run it locally

Any static server works. For example:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

## More

Deploying, the pre-publish to-do list, the manual test checklist and the v1
scope are in [docs/development.md](docs/development.md).
