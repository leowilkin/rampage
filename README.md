# rampage 🤠

a pre-commit hook that scans your staged changes for PII using
[NDS Rampart](https://ndstudio.gov/posts/say-hello-to-rampart) —
deterministic recognizers (email, SSN, credit card, IP, phone) plus a small
on-device [NER model](https://huggingface.co/nationaldesignstudio/rampart)
for names and addresses. nothing ever leaves your machine.

when PII lands in a staged diff, the commit pauses:

```
Woah partner! Looks like we found 2 bits of PII in your latest and greatest commit.

  user@example.com - home/index.html:30  (EMAIL)
  +1 (555) 019-2653 - home/dashboard.html:120  (PHONE)

either accept the risks or pause your commit right there:

  ❯ (N) pause your commit right there!
    (Y) accept the risks
```

"pause" is preselected — arrow down and hit enter to accept the risks and
commit anyway. `y`/`n` work as shortcuts, and esc/ctrl-c pauses.

## install (one line)

```sh
curl -fsSL https://rampage.alphabeti.se/setup.sh | sh
```

this installs **globally**: the scanner lands in `~/.rampage` and
`git config --global core.hooksPath` points every repo on the machine at it —
no per-repo setup. it plays nice with what you already have:

- a previous global hooksPath (e.g. ggshield/GitGuardian) is chained *after*
  the rampage scan, not replaced
- repo-local `.git/hooks` still run — every hook in `~/.rampage/hooks` is a
  pass-through shim
- repos that set their own `core.hooksPath` (e.g. husky) are untouched, since
  local git config beats global

the first scan downloads the ~15 MB quantized model from hugging face; after
that it's cached and runs fully offline. uninstall by restoring the previous
hooksPath (printed at install time) or `git config --global --unset core.hooksPath`.

### from this repo instead

```sh
npm install   # installs deps and points git at hooks/ via the prepare script
```

## knobs

| env var | effect |
|---|---|
| `RAMPART_SKIP=1 git commit ...` | skip the scan for one commit |
| `RAMPART_HEURISTICS_ONLY=1` | skip the NER model — fast, structured PII only |
| `RAMPART_MIN_SCORE=0.6` | raise the NER confidence threshold (default 0.4) |

## hosting the installer

serve two files from the root of rampage.alphabeti.se:

- `setup.sh`
- `scan-staged.mjs`

`setup.sh` fetches `scan-staged.mjs` from the same origin (override with
`RAMPAGE_BASE_URL` for testing).

## what gets scanned

only lines *added* in the staged diff. lockfiles, minified bundles, source
maps, and vendored directories are skipped. URLs are never reported, and NER
spans must pass shape checks (names must look like names, ID numbers like ID
numbers) since the model was trained on chat text, not code.
