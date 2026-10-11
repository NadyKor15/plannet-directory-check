#!/usr/bin/env node
// audit-directories — measure what public provider directories (FHIR Plan-Net) publish for a set of ZIPs.
//
//   node bin/audit-directories.ts [--zips 32801,32803,32806] [--specialties primary_care,ob_gyn,...]
//        [--directories florida-blue,molina,...] [--max-locations 30] [--max-pages 10] [--timeout 20000]
//        [--out-dir docs] [--no-nppes] [--no-qhp] [--pool <file>]
//
// Writes <out-dir>/AUDIT-<date>.json and <out-dir>/AUDIT-<date>.md (date = UTC day of the run) and prints a summary.
// --pool <file> (or AUDIT_NAME_POOL) writes the practitioner names seen, for a local name guard; keep that file out of
// version control. Exit code 1 when the must-light control does not light or no directory answered at all.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { auditDirectories, type AuditResult } from "../src/audit.ts";
import { headlineOf, renderMarkdown } from "../src/report.ts";
import { SPECIALTY_GROUPS, type SpecialtyKey } from "../src/specialties.ts";

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (n: string) => argv.includes(`--${n}`);
if (flag("help")) {
  console.log("usage: audit-directories [--zips a,b] [--specialties ...] [--directories ...] [--max-locations N] [--max-pages N] [--timeout ms] [--out-dir dir] [--no-nppes] [--no-qhp] [--pool file]");
  process.exit(0);
}
const renderFrom = arg("render");
if (renderFrom) {
  const saved = JSON.parse(readFileSync(renderFrom, "utf8")) as AuditResult & { command: string };
  const out = renderFrom.replace(/\.json$/, ".md");
  writeFileSync(out, renderMarkdown(saved, saved.command));
  console.log(`${headlineOf(saved)}\nrendered ${out}`);
  process.exit(0);
}
const zips = (arg("zips") ?? "32801,32803,32806").split(",").map((s) => s.trim()).filter(Boolean);
const specialties = (arg("specialties") ?? "primary_care,ob_gyn,gastroenterology,dermatology,allergy,orthopedics").split(",").map((s) => s.trim()) as SpecialtyKey[];
for (const s of specialties) if (!(s in SPECIALTY_GROUPS)) { console.error(`unknown specialty ${s}; known: ${Object.keys(SPECIALTY_GROUPS).join(", ")}`); process.exit(2); }
const directories = arg("directories")?.split(",");
const outDir = resolve(arg("out-dir") ?? "docs");
const pool = arg("pool") ?? process.env.AUDIT_NAME_POOL;
const command = `audit-directories ${argv.join(" ")}`.trim();

const result: AuditResult = await auditDirectories({
  zips, specialties, directories,
  maxLocations: Number(arg("max-locations") ?? 30),
  maxPages: Number(arg("max-pages") ?? 10),
  timeoutMs: Number(arg("timeout") ?? 20_000),
  skipNppes: flag("no-nppes"),
  skipQhp: flag("no-qhp"),
  collectNames: Boolean(pool),
  log: (l) => console.log(l),
});

const day = result.startedAt.slice(0, 10);
const t = result.totals;
const headline = headlineOf(result);
mkdirSync(outDir, { recursive: true });
const { names, ...publicResult } = result;
writeFileSync(join(outDir, `AUDIT-${day}.json`), `${JSON.stringify({ command, ...publicResult }, null, 1)}\n`);
writeFileSync(join(outDir, `AUDIT-${day}.md`), renderMarkdown(result, command));
if (pool && names) { mkdirSync(dirname(resolve(pool)), { recursive: true }); writeFileSync(resolve(pool), JSON.stringify({ capturedAt: result.startedAt, poolNames: [...new Set(names)] })); }

console.log("");
console.log(headline);
console.log(`records ${t.records} (roles ${t.roles}, locations ${t.locations}) · hours present ${t.hours_present} · hours conflict ${t.hours_conflict} · new-patients flag ${t.newpatients_present} · requests ${t.requests} · errors ${t.errors}`);
console.log(`control: synthetic age record counted = ${result.control.synthetic_age_record_counted} (must be true) · plain record counted = ${result.control.synthetic_plain_record_counted} (must be false)`);
console.log(`wrote ${join(outDir, `AUDIT-${day}.md`)} and .json${pool ? ` · name pool ${pool}` : ""}`);
if (!result.control.synthetic_age_record_counted || result.control.synthetic_plain_record_counted) process.exitCode = 1;
if (result.directories.every((d) => d.records === 0)) process.exitCode = 1;
