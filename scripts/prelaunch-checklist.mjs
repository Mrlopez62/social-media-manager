import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";

const ROOT = process.cwd();
const REQUIRE_REAL_ALERT_TARGETS = process.env.PRELAUNCH_REQUIRE_REAL_ALERT_TARGETS === "true";
const REQUIRE_DRILL_EVIDENCE = process.env.PRELAUNCH_REQUIRE_DRILL_EVIDENCE === "true";

function readJson(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
}

function readText(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractPrefixedLineValue(text, prefix) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*(.*)$`, "m");
  const match = text.match(pattern);
  return match ? match[1].trim() : null;
}

function isBlankEvidenceValue(value) {
  if (!value) {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return normalized === "tbd" || normalized === "todo";
}

function extractSection(text, heading) {
  const headingIndex = text.indexOf(heading);
  if (headingIndex === -1) {
    return "";
  }

  const sectionStart = headingIndex + heading.length;
  const nextHeadingIndex = text.indexOf("\n## ", sectionStart);
  if (nextHeadingIndex === -1) {
    return text.slice(sectionStart);
  }

  return text.slice(sectionStart, nextHeadingIndex);
}

function isExactVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function collectDependencyPinFailures(packageJson) {
  const failures = [];
  const groups = ["dependencies", "devDependencies"];

  for (const group of groups) {
    const entries = Object.entries(packageJson[group] ?? {});
    for (const [name, version] of entries) {
      if (!isExactVersion(version)) {
        failures.push(`${group}.${name} must be exact (found "${version}").`);
      }
    }
  }

  return failures;
}

function collectLockfileFailures(packageJson, lockfile) {
  const failures = [];
  const rootPackage = lockfile?.packages?.[""];

  if (!rootPackage) {
    failures.push("package-lock.json missing root packages[\"\"].");
    return failures;
  }

  const sections = ["dependencies", "devDependencies"];
  for (const section of sections) {
    const expected = packageJson[section] ?? {};
    const actual = rootPackage[section] ?? {};

    for (const [name, version] of Object.entries(expected)) {
      if (actual[name] !== version) {
        failures.push(`package-lock root ${section}.${name} mismatch (expected "${version}", found "${actual[name] ?? "missing"}").`);
      }
    }
  }

  return failures;
}

const REQUIRED_ALERT_RULE_IDS = [
  "critical_dead_letter_spike",
  "warning_publish_failures_increasing",
  "critical_meta_refresh_failures",
  "warning_meta_refresh_degradation",
  "warning_internal_worker_failures",
  "warning_rate_limit_denial_surge",
  "critical_rate_limit_denial_flood",
  "warning_oauth_start_failures"
];

function collectAlertRoutingFailures(alertRouting) {
  const failures = [];
  const channels = alertRouting.channels ?? {};
  const rules = alertRouting.rules ?? [];

  for (const id of ["ops-slack", "security-slack", "pager"]) {
    if (!channels[id]) {
      failures.push(`config/alert-routing.json missing channel "${id}".`);
    }
  }

  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  for (const id of REQUIRED_ALERT_RULE_IDS) {
    if (!rulesById.has(id)) {
      failures.push(`config/alert-routing.json missing required rule "${id}".`);
    }
  }

  for (const rule of rules) {
    if (!["warning", "critical"].includes(rule.severity)) {
      failures.push(`alert rule "${rule.id}" has invalid severity "${rule.severity}".`);
    }

    if (typeof rule.query !== "string" || !rule.query.includes("environment:production")) {
      failures.push(`alert rule "${rule.id}" must include "environment:production" in query.`);
    }

    if (!Array.isArray(rule.channels) || rule.channels.length === 0) {
      failures.push(`alert rule "${rule.id}" must include at least one channel.`);
      continue;
    }

    for (const channelId of rule.channels) {
      if (!channels[channelId]) {
        failures.push(`alert rule "${rule.id}" references unknown channel "${channelId}".`);
      }
    }

    if (rule.severity === "critical" && !rule.channels.includes("pager")) {
      failures.push(`critical alert rule "${rule.id}" must route to "pager".`);
    }
  }

  return failures;
}

const ALERT_ROUTING_PLACEHOLDERS = new Set(["#ops-alerts", "#security-alerts", "primary-oncall"]);

function collectAlertRoutingTargetFailures(alertRouting) {
  const failures = [];
  const channels = alertRouting.channels ?? {};

  for (const [channelId, channel] of Object.entries(channels)) {
    const target = typeof channel?.target === "string" ? channel.target.trim() : "";

    if (!target) {
      failures.push(`channel "${channelId}" must define a non-empty target.`);
      continue;
    }

    if (ALERT_ROUTING_PLACEHOLDERS.has(target)) {
      failures.push(
        `channel "${channelId}" target "${target}" still looks like a placeholder. Replace it with your real production destination.`
      );
    }
  }

  return failures;
}

const REQUIRED_INCIDENT_HEADINGS = [
  "## Objectives",
  "## Participants And Roles",
  "## Drill Cadence",
  "## Pre-Drill Checklist",
  "## Scenario 1: Dead-Letter Spike",
  "## Scenario 2: Meta Token Refresh Failure Burst",
  "## Execution Timeline",
  "## Evidence Capture Template",
  "## Exit Criteria",
  "## Post-Drill Follow-Up"
];

function collectIncidentDrillFailures(docText) {
  const failures = [];
  for (const heading of REQUIRED_INCIDENT_HEADINGS) {
    if (!docText.includes(heading)) {
      failures.push(`docs/incident-drill.md missing heading "${heading}".`);
    }
  }
  return failures;
}

const REQUIRED_INCIDENT_EVIDENCE_PREFIXES = [
  "- Drill date/time:",
  "- Scenario:",
  "- Environment:",
  "- Incident Commander:",
  "- Scribe:",
  "- Alerts fired (name + timestamp):",
  "- Routing destinations verified:",
  "- Root cause summary:",
  "- Recovery validation:",
  "- Time to detect:",
  "- Time to acknowledge:",
  "- Time to mitigate:"
];

const REQUIRED_SIGNOFF_PREFIXES = ["- Ops Responder:", "- Security Responder:", "- Incident Commander:"];

function collectIncidentEvidenceFailures() {
  const failures = [];
  const incidentDir = resolve(ROOT, "docs/incident-drills");

  if (!existsSync(incidentDir)) {
    failures.push("docs/incident-drills directory is required when PRELAUNCH_REQUIRE_DRILL_EVIDENCE=true.");
    return failures;
  }

  const evidenceFiles = readdirSync(incidentDir)
    .filter((entry) => entry.toLowerCase().endsWith(".md"))
    .filter((entry) => entry.toLowerCase() !== "readme.md");

  if (evidenceFiles.length === 0) {
    failures.push(
      "No incident drill evidence files found in docs/incident-drills. Run `npm run ops:drill:init` and complete at least one report."
    );
    return failures;
  }

  let hasCompletedEvidence = false;
  const incompleteFileReasons = [];

  for (const fileName of evidenceFiles) {
    const relativePath = `docs/incident-drills/${fileName}`;
    const text = readText(relativePath);
    const fileFailures = [];

    for (const prefix of REQUIRED_INCIDENT_EVIDENCE_PREFIXES) {
      const value = extractPrefixedLineValue(text, prefix);
      if (isBlankEvidenceValue(value)) {
        fileFailures.push(`${relativePath} missing completed value for "${prefix}"`);
      }
    }

    const signoffSection = extractSection(text, "## Sign-off");
    if (!signoffSection.trim()) {
      fileFailures.push(`${relativePath} is missing a completed "## Sign-off" section.`);
    } else {
      for (const prefix of REQUIRED_SIGNOFF_PREFIXES) {
        const value = extractPrefixedLineValue(signoffSection, prefix);
        if (isBlankEvidenceValue(value)) {
          fileFailures.push(`${relativePath} missing sign-off value for "${prefix}"`);
        }
      }
    }

    const followupSection = extractSection(text, "## Follow-up Actions");
    const hasFollowupAction = /^\s*\d+\.\s+\S.+$/m.test(followupSection);
    if (!hasFollowupAction) {
      fileFailures.push(`${relativePath} must include at least one populated follow-up action item.`);
    }

    if (fileFailures.length === 0) {
      hasCompletedEvidence = true;
      break;
    }

    incompleteFileReasons.push(...fileFailures);
  }

  if (!hasCompletedEvidence) {
    failures.push("No completed incident drill evidence file found in docs/incident-drills.");
    failures.push(...incompleteFileReasons.slice(0, 10));
  }

  return failures;
}

function run() {
  const failures = [];

  if (!existsSync(resolve(ROOT, "package-lock.json"))) {
    failures.push("package-lock.json is required.");
  }

  const packageJson = readJson("package.json");
  const lockfile = readJson("package-lock.json");
  const alertRouting = readJson("config/alert-routing.json");
  const incidentDrillDoc = readText("docs/incident-drill.md");

  failures.push(...collectDependencyPinFailures(packageJson));
  failures.push(...collectLockfileFailures(packageJson, lockfile));
  failures.push(...collectAlertRoutingFailures(alertRouting));
  if (REQUIRE_REAL_ALERT_TARGETS) {
    failures.push(...collectAlertRoutingTargetFailures(alertRouting));
  }
  failures.push(...collectIncidentDrillFailures(incidentDrillDoc));
  if (REQUIRE_DRILL_EVIDENCE) {
    failures.push(...collectIncidentEvidenceFailures());
  }

  if (failures.length > 0) {
    console.error("Pre-launch checklist failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("Pre-launch checklist passed:");
  console.log("- dependency pins verified");
  console.log("- alert routing config verified");
  if (REQUIRE_REAL_ALERT_TARGETS) {
    console.log("- alert routing targets verified (strict)");
  } else {
    console.log("- alert routing target verification skipped (set PRELAUNCH_REQUIRE_REAL_ALERT_TARGETS=true)");
  }
  console.log("- incident drill document verified");
  if (REQUIRE_DRILL_EVIDENCE) {
    console.log("- incident drill evidence verified (strict)");
  } else {
    console.log("- incident drill evidence verification skipped (set PRELAUNCH_REQUIRE_DRILL_EVIDENCE=true)");
  }
}

run();
