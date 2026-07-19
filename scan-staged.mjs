#!/usr/bin/env node
/**
 * rampart pre-commit PII scanner
 *
 * Scans the lines being added in the staged diff for PII using
 * @nationaldesignstudio/rampart (heuristics + NER model), reports each
 * finding as `<pii> - <file>:<line>`, and asks the committer whether the
 * PII is intentional. Exits 0 to allow the commit, 1 to block it.
 *
 * Escape hatches:
 *   RAMPART_SKIP=1 git commit ...        skip the scan entirely
 *   RAMPART_HEURISTICS_ONLY=1            skip the NER model (fast / offline)
 */
import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";
import {
  detectHeuristics,
  detectNer,
  loadNerClassifier,
  mergeSpans,
  applyPolicy,
} from "@nationaldesignstudio/rampart";

const MIN_SCORE = Number(process.env.RAMPART_MIN_SCORE ?? 0.4);

/** Generated/vendored files: not worth scanning, endless false positives. */
const SKIP_FILE = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)(yarn|pnpm-lock|bun)\.(lock|lockb|yaml)$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)(node_modules|vendor|dist|build)\//,
  /\.(min\.(js|css)|map|svg|lock)$/,
];

/** Labels we never report: URLs are everywhere in source and rarely PII. */
const IGNORE_LABELS = new Set(["URL"]);

const NAME_LABELS = new Set(["GIVEN_NAME", "SURNAME"]);
const ID_LABELS = new Set([
  "DRIVERS_LICENSE", "GOVERNMENT_ID", "TAX_ID", "PASSPORT",
  "BANK_ACCOUNT", "ROUTING_NUMBER",
]);
// Capitalized with a lowercase letter and only name characters; internal
// capitals and apostrophes allowed so realistic surnames still match.
const NAME_SHAPE = /^[A-Z][a-zA-Z'’-]*[a-z][a-zA-Z'’-]*$/;
const NAME_MIN_LENGTH = 3;
// Capitalized words that are code vocabulary far more often than names.
const NAME_STOPWORDS = new Set([
  "Set", "Map", "Date", "Math", "Array", "Object", "String", "Number",
  "Boolean", "Promise", "Buffer", "Error", "Symbol", "Function", "Class",
  "Type", "True", "False", "Null", "None", "Json", "Http", "Https", "Api",
]);
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;

/**
 * The NER model is trained on chat text and mislabels code identifiers
 * ("commonjs" → SURNAME at 0.99), so NER spans must also pass a shape check:
 * names must look like names, ID numbers must look like ID numbers.
 */
function plausible(span) {
  if (span.source !== "ner") return true;
  const text = span.text.trim();
  if (NAME_LABELS.has(span.label)) {
    return (
      text.length >= NAME_MIN_LENGTH &&
      NAME_SHAPE.test(text) &&
      !NAME_STOPWORDS.has(text)
    );
  }
  if (ID_LABELS.has(span.label)) {
    return text.length >= 6 && /\d/.test(text) && ID_SHAPE.test(text);
  }
  if (span.label === "SECONDARY_ADDRESS") return /\d/.test(text);
  return true;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Parse `git diff --cached -U0` into added lines with file + line number. */
function stagedAddedLines() {
  const diff = git(["diff", "--cached", "-U0", "--no-color", "--diff-filter=ACM"]);
  const lines = [];
  let file = null;
  let lineNo = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      file = raw.slice(6);
      if (SKIP_FILE.some((p) => p.test(file))) file = null;
    } else if (raw.startsWith("@@")) {
      const m = raw.match(/\+(\d+)/);
      lineNo = m ? Number(m[1]) : 0;
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (file) lines.push({ file, line: lineNo, text: raw.slice(1) });
      lineNo++;
    }
  }
  return lines;
}

/**
 * Supplemental phone detector. Rampart's heuristics leave phones to the NER
 * model, which is unreliable on them in code/markup contexts, so we match
 * NANP and international formats ourselves and let mergeSpans dedupe.
 */
const PHONE_PATTERNS = [
  /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]?\d{4}(?!\d)/g,
  /(?<!\d)\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d(?:[\s.-]?\d){6,12}(?!\d)/g,
];
function detectPhones(text) {
  const spans = [];
  for (const pattern of PHONE_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      spans.push({
        start: m.index,
        end: m.index + m[0].length,
        label: "PHONE",
        score: 1,
        source: "heuristic",
        text: m[0],
      });
    }
  }
  return spans;
}

/** Detect PII spans in one blob of text (heuristics + phones + optional NER). */
async function detect(text, ner) {
  const spans = [...detectHeuristics(text), ...detectPhones(text)];
  if (ner) spans.push(...(await detectNer(text, ner, MIN_SCORE)));
  // mergeSpans dedupes overlaps; applyPolicy drops the keep-set (city/state/zip)
  return applyPolicy(mergeSpans(spans)).filter(
    (s) => s.score >= MIN_SCORE && !IGNORE_LABELS.has(s.label) && plausible(s),
  );
}

async function loadNer() {
  if (process.env.RAMPART_HEURISTICS_ONLY === "1") return null;
  try {
    return await loadNerClassifier({ device: "cpu" });
  } catch (err) {
    process.stderr.write(
      `rampart: NER model unavailable (${err.message.split("\n")[0]}); falling back to heuristics only\n`,
    );
    return null;
  }
}

/** Ask y/n on the terminal even though git owns stdin. */
function askUser(question) {
  process.stderr.write(question);
  let fd;
  try {
    fd = openSync("/dev/tty", "r");
  } catch {
    process.stderr.write("\nrampart: no terminal to ask on — blocking commit. Re-run with RAMPART_SKIP=1 to override.\n");
    return false;
  }
  try {
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64);
    const answer = buf.toString("utf8", 0, n).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    closeSync(fd);
  }
}

async function main() {
  if (process.env.RAMPART_SKIP === "1") return 0;

  const added = stagedAddedLines();
  if (added.length === 0) return 0;

  const ner = await loadNer();

  // group added lines by file, scan each line so offsets map cleanly to line numbers
  const findings = [];
  for (const { file, line, text } of added) {
    if (!text.trim()) continue;
    const spans = await detect(text, ner);
    for (const s of spans) findings.push({ pii: s.text, label: s.label, file, line });
  }

  if (findings.length === 0) return 0;

  const bits = findings.length === 1 ? "1 bit" : `${findings.length} bits`;
  process.stderr.write(
    `\n\x1b[1;33mWoah partner!\x1b[0m Looks like we found ${bits} of PII in your latest and greatest commit.\n\n`,
  );
  for (const f of findings) {
    process.stderr.write(`  \x1b[31m${f.pii}\x1b[0m - ${f.file}:${f.line}  \x1b[2m(${f.label})\x1b[0m\n`);
  }
  const ok = askUser("\neither (Y) accept the risks or (N) pause your commit right there! ");
  if (ok) return 0;
  process.stderr.write("\ncommit paused. clean up that PII and try again, partner.\n");
  return 1;
}

process.exit(await main());
