// Drift check (CLAUDE.md rule 17: verify by the artifact, never by an exit
// code or a printed checkmark). Two independent checks, both must pass:
//
// 1. INTRA-REPO: re-renders the pricing copy fresh from data/pricing.json
//    using the SAME render functions build_pricing.mjs uses, extracts what's
//    actually committed between the PRICING:START/END and
//    CONSUMER_PRICING:START/END markers in portfolio/bluemonster.html and
//    pricing.html, and fails loudly — printing the two strings it compared —
//    if they differ even by one character. This is the same pattern as
//    check_portfolio_sync.mjs for /portfolio.
//
// 2. CROSS-REPO: data/pricing.json claims to match specific fields in
//    mobluehq-platform's packages/bluehelm/src/bluehelm/config.py (the file
//    that actually bills the customer — see data/pricing.json's
//    "sourceOfTruth"). If a checkout of that repo can be found on this
//    machine, this script parses the four *_search_hours float defaults out
//    of config.py and FAILS if any of them differ from data/pricing.json.
//    If no checkout can be found, it prints a loud, unambiguous WARN (never
//    a silent pass) so a false green can't be mistaken for "checked."
//
// Usage: node scripts/check_pricing_sync.mjs [pathToBluehelmConfigPy]
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { renderBluemonsterPriceLine, renderConsumerPricingCards, tierById } from "./pricing_render.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_PATH = join(ROOT, "data", "pricing.json");

let failed = false;

function fail(msg) {
  console.error(`MISMATCH: ${msg}`);
  failed = true;
}

function checkMarkerBlock(label, path, start, end, expected) {
  const html = readFileSync(path, "utf8");
  const startIdx = html.indexOf(start);
  const endIdx = html.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    fail(`could not find ${label} markers in ${path}`);
    return;
  }
  const actual = html.slice(startIdx + start.length, endIdx).trim();
  const expectedTrimmed = expected.trim();
  if (actual !== expectedTrimmed) {
    fail(`${label} in ${path} has drifted from data/pricing.json.`);
    console.error("Run `node scripts/build_pricing.mjs` and commit the result.");
    console.error(`--- expected (from data/pricing.json) ---\n${expectedTrimmed}`);
    console.error(`--- actual (currently committed) ---\n${actual}`);
    return;
  }
  console.log(`OK: ${label} in ${path} matches data/pricing.json.`);
}

// Resolves the git ref to use for reading config.py from mobluehq-platform.
// Checked in order: explicit CLI flag, $BLUEHELM_GIT_REF env var, default to rc/bluemonster-v1.0-rc1.
// Example: node check_pricing_sync.mjs --ref=main
// The returned object {ref, found} indicates whether the ref actually exists in the remote.
function resolveGitRef(argv) {
  let ref = null;

  // Check for --ref=<value> flag
  const refFlag = argv.find(arg => arg.startsWith("--ref="));
  if (refFlag) {
    ref = refFlag.split("=")[1];
  }

  // Check env var
  if (!ref && process.env.BLUEHELM_GIT_REF) {
    ref = process.env.BLUEHELM_GIT_REF;
  }

  // Default
  if (!ref) {
    ref = "rc/bluemonster-v1.0-rc1";
  }

  return ref;
}

// Reads the bluehelm config from mobluehq-platform at a named git ref.
// Returns {text, ref, repoPath} on success, or throws with a descriptive error.
function readConfigFromRef(ref, platformRepoPath) {
  let actualRepoPath = platformRepoPath;

  // If not explicitly provided, try to find the repo
  if (!actualRepoPath) {
    const candidates = [
      join(ROOT, "..", "mobluehq-platform"),
      "/opt/mobluehq/platform",
      process.env.MOBLUEHQ_PLATFORM_REPO,
    ].filter(Boolean);

    for (const c of candidates) {
      try {
        execFileSync("git", ["-C", c, "rev-parse", "--is-inside-work-tree"], {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"], // suppress stderr
        });
        actualRepoPath = c;
        break;
      } catch (_e) {
        // Not a git repo, continue
      }
    }
  }

  if (!actualRepoPath) {
    throw new Error(
      "FATAL: could not locate mobluehq-platform repository. " +
      "Checked: ~/dev/../mobluehq-platform, /opt/mobluehq/platform, and $MOBLUEHQ_PLATFORM_REPO env var. " +
      "Pass the repo path explicitly as the second argument."
    );
  }

  // Verify the ref exists
  try {
    execFileSync("git", ["-C", actualRepoPath, "rev-parse", ref], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"], // suppress stderr
    });
  } catch (_e) {
    throw new Error(
      `FATAL: git ref "${ref}" does not exist in ${actualRepoPath}. ` +
      `Verify the ref name is correct and run: git -C ${actualRepoPath} branch -a | grep ${ref}`
    );
  }

  // Read the config from the named ref
  const configPath = "packages/bluehelm/src/bluehelm/config.py";
  let text;
  try {
    text = execFileSync("git", ["-C", actualRepoPath, "show", `${ref}:${configPath}`], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"], // suppress stderr
    });
  } catch (e) {
    throw new Error(
      `FATAL: could not read ${configPath} from ref "${ref}" in ${actualRepoPath}. ` +
      `File may not exist in that ref. Original error: ${e.message}`
    );
  }

  return { text, ref, repoPath: actualRepoPath };
}

function parseHoursField(text, fieldName) {
  // Matches e.g. `    entry_search_hours: float = 4.0` — the dataclass
  // field declaration with its default, not the CLI/env override lines.
  const re = new RegExp(`\\b${fieldName}\\s*:\\s*float\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)`);
  const m = text.match(re);
  return m ? parseFloat(m[1]) : null;
}

function main() {
  const data = JSON.parse(readFileSync(DATA_PATH, "utf8"));

  // --- Check 1: intra-repo (JSON -> generated HTML) ---
  checkMarkerBlock(
    "PRICING block (bluemonster.html)",
    join(ROOT, "portfolio", "bluemonster.html"),
    "<!-- PRICING:START (generated by scripts/build_pricing.mjs from data/pricing.json — do not hand-edit between these markers) -->",
    "<!-- PRICING:END -->",
    renderBluemonsterPriceLine(data)
  );
  checkMarkerBlock(
    "CONSUMER_PRICING block (pricing.html)",
    join(ROOT, "pricing.html"),
    "<!-- CONSUMER_PRICING:START (generated by scripts/build_pricing.mjs from data/pricing.json — do not hand-edit between these markers) -->",
    "<!-- CONSUMER_PRICING:END -->",
    renderConsumerPricingCards(data)
  );

  // --- Check 2: cross-repo (JSON -> bluehelm/config.py from a named git ref) ---
  const ref = resolveGitRef(process.argv.slice(2));
  const platformRepoPath = process.argv.find(arg => arg.startsWith("--repo="))?.split("=")[1] || process.env.MOBLUEHQ_PLATFORM_REPO;

  let configResult;
  try {
    configResult = readConfigFromRef(ref, platformRepoPath);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }

  console.log(`Cross-repo check: comparing against git ref "${configResult.ref}" in ${configResult.repoPath}`);

  const configText = configResult.text;
  let fieldsMissing = [];
  for (const tier of data.tiers) {
    const configValue = parseHoursField(configText, tier.configKey);
    if (configValue === null) {
      fieldsMissing.push(tier.configKey);
      fail(`could not find field "${tier.configKey}" in ref "${ref}"`);
      continue;
    }
    if (configValue !== tier.hours) {
      fail(
        `data/pricing.json tier "${tier.id}" says ${tier.hours} hours but ` +
          `ref "${ref}"'s ${tier.configKey} default is ${configValue}.`
      );
      continue;
    }
    console.log(`OK: tier "${tier.id}" (${tier.configKey}) — data/pricing.json (${tier.hours}) matches ref "${ref}" (${configValue}).`);
  }

  // If all fields were missing, that's a ref mismatch — give a clearer message
  if (fieldsMissing.length === data.tiers.length) {
    console.error(`\nFAIL: NONE of the expected fields exist in ref "${ref}". This suggests the ref does not contain the expected bluehelm version.`);
    process.exit(1);
  }

  if (failed) {
    console.error("\nFAILED: pricing copy has drifted. See MISMATCH lines above.");
    process.exit(1);
  }
  console.log("\nOK: all pricing sync checks passed.");
}

main();
