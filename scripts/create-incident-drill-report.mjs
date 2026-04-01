import { mkdirSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";

const ROOT = process.cwd();
const OUTPUT_DIR = resolve(ROOT, "docs/incident-drills");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    scenario: "dead-letter-spike",
    environment: "staging",
    commander: "TBD",
    output: ""
  };

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    const next = args[i + 1];

    if (value === "--scenario" && next) {
      options.scenario = next;
      i += 1;
      continue;
    }

    if (value === "--environment" && next) {
      options.environment = next;
      i += 1;
      continue;
    }

    if (value === "--commander" && next) {
      options.commander = next;
      i += 1;
      continue;
    }

    if (value === "--output" && next) {
      options.output = next;
      i += 1;
      continue;
    }
  }

  return options;
}

function toSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function scenarioTitle(scenario) {
  if (scenario === "dead-letter-spike") {
    return "Dead-Letter Spike";
  }
  if (scenario === "meta-refresh-failure-burst") {
    return "Meta Token Refresh Failure Burst";
  }
  return scenario
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function buildTemplate(params) {
  const now = new Date();
  const iso = now.toISOString();

  return `# Incident Drill Evidence - ${params.title}

- Drill date/time: ${iso}
- Scenario: ${params.title} (${params.scenario})
- Environment: ${params.environment}
- Incident Commander: ${params.commander}
- Scribe: TBD

## Alerts

- Alerts expected:
- Alerts fired (name + timestamp):
- Routing destinations verified:

## Timeline

1. T0:
2. Detection:
3. Mitigation started:
4. Stabilized:
5. Drill closed:

## Triage Summary

- Root cause summary:
- Primary signals used:
- Impact summary:

## Mitigation

- Action 1:
- Action 2:
- Recovery validation:

## Metrics

- Time to detect:
- Time to acknowledge:
- Time to mitigate:

## Follow-up Actions

1. 
2. 
3. 

## Sign-off

- Ops Responder:
- Security Responder:
- Incident Commander:
`;
}

function run() {
  const options = parseArgs();
  const date = new Date().toISOString().slice(0, 10);
  const scenario = toSlug(options.scenario || "drill");
  const title = scenarioTitle(scenario);

  const outputPath = options.output
    ? resolve(ROOT, options.output)
    : resolve(OUTPUT_DIR, `${date}-${scenario}.md`);

  const outputDir = resolve(outputPath, "..");
  mkdirSync(outputDir, { recursive: true });

  if (existsSync(outputPath)) {
    console.error(`Refusing to overwrite existing drill report: ${outputPath}`);
    process.exit(1);
  }

  writeFileSync(
    outputPath,
    buildTemplate({
      title,
      scenario,
      environment: options.environment,
      commander: options.commander
    }),
    "utf8"
  );

  console.log(`Incident drill report scaffold created: ${outputPath}`);
}

run();
