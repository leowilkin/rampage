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

either (Y) accept the risks or (N) pause your commit right there!
```

answer `y` to commit anyway, anything else blocks it.

## setup

```sh
npm install   # installs deps and points git at hooks/ via the prepare script
```

that's it — `prepare` runs `git config core.hooksPath hooks`. the first scan
downloads the ~15 MB quantized model from hugging face; after that it's cached
and runs fully offline.

## knobs

| env var | effect |
|---|---|
| `RAMPART_SKIP=1 git commit ...` | skip the scan for one commit |
| `RAMPART_HEURISTICS_ONLY=1` | skip the NER model — fast, structured PII only |
| `RAMPART_MIN_SCORE=0.6` | raise the NER confidence threshold (default 0.4) |

## what gets scanned

only lines *added* in the staged diff. lockfiles, minified bundles, source
maps, and vendored directories are skipped. URLs are never reported, and NER
spans must pass shape checks (names must look like names, ID numbers like ID
numbers) since the model was trained on chat text, not code.
