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
import { auditDirectories, type AuditResult } from "../src/audit.ts";
import { SPECIALTY_GROUPS, type SpecialtyKey } from "../src/specialties.ts";

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (n: string) => argv.includes(`--${n}`);
if (flag("help")) {
  console.log("usage: audit-directories [--zips a,b] [--specialties ...] [--directories ...] [--max-locations N] [--max-pages N] [--timeout ms] [--out-dir dir] [--no-nppes] [--no-qhp] [--pool file]");
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
const errs = (e: Record<string, number>) => Object.entries(e).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(", ") || "0";
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");
const headline = `${t.age_policy_published} of ${t.records} public directory records (PractitionerRole + Location) state what patient ages are seen`;

const md: string[] = [];
md.push(`# Public provider directory audit — ${day}`);
md.push("");
md.push(`- Run: ${result.startedAt} → ${result.finishedAt} (UTC)`);
md.push(`- Command: \`${command}\``);
md.push(`- ZIPs: ${zips.join(", ")} · specialties: ${specialties.join(", ")}`);
md.push(`- Must-light control (same metric code on synthetic records): record with "Ages 3 and up" in newpatients.characteristics counted = **${result.control.synthetic_age_record_counted}**; plain record counted = ${result.control.synthetic_plain_record_counted}`);
md.push(`- Requests ${t.requests} · errors ${t.errors} (per directory below)`);
md.push("");
md.push(`**${headline}.**`);
md.push("");
md.push("| Directory | Strategy | Records (roles / locations) | Scene-specialty roles | Age stated | Hours present | Hours conflict | New-patients flag present | New-patients values | Roles with specialty / NPI | NPIs | Roles per NPI (mean / max) | Same NPI+location+network repeated | Requests | Errors |");
md.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const d of result.directories) {
  md.push(`| ${d.label} | ${d.strategy} | ${d.records} (${d.roles} / ${d.locations}) | ${d.scene_roles} | ${d.age_policy_published} | ${d.hours_present} (${pct(d.hours_present, d.records)}) | ${d.hours_conflict} | ${d.newpatients_present} (${pct(d.newpatients_present, d.records)}) | ${Object.entries(d.newpatients_values).map(([k, v]) => `${k} ${v}`).join(", ") || "-"} | ${d.roles_with_specialty} / ${d.roles_with_npi} of ${d.roles} | ${d.npis} | ${d.roles_per_npi_mean ?? "-"} / ${d.roles_per_npi_max ?? "-"} | ${d.duplicate_role_triples} | ${d.requests} | ${errs({ ...d.errors, ...Object.fromEntries(Object.entries(d.http_status).map(([k, v]) => [`HTTP ${k}`, v])) })} |`);
}
md.push(`| **All** | | **${t.records}** (${t.roles} / ${t.locations}) | ${t.scene_roles} | **${t.age_policy_published}** | ${t.hours_present} (${pct(t.hours_present, t.records)}) | ${t.hours_conflict} | ${t.newpatients_present} (${pct(t.newpatients_present, t.records)}) | ${Object.entries(t.newpatients_values).map(([k, v]) => `${k} ${v}`).join(", ")} | | | | | ${t.requests} | ${t.errors} |`);
md.push("");
md.push("Per ZIP:");
md.push("");
md.push("| Directory | ZIP | Roles | Locations | Failed requests | Truncated | ms |");
md.push("|---|---|---|---|---|---|---|");
for (const d of result.directories) for (const z of d.zips) md.push(`| ${d.key} | ${z.zip} | ${z.roles} | ${z.locations} | ${z.failures} | ${z.truncated ? "yes" : "no"} | ${z.ms} |`);
md.push("");
if (t.age_examples.length) { md.push("Age wording found (first examples):"); md.push(""); for (const e of t.age_examples) md.push(`- "${e}"`); md.push(""); }
md.push("Notes per directory:");
md.push("");
for (const d of result.directories) md.push(`- **${d.key}**: ${d.notes.join("; ") || "-"}; base ${d.base}`);
for (const n of result.notOpen) md.push(`- **${n.key}** (not audited, needs registration): ${n.observed}`);
md.push("");
if (result.nppes) {
  md.push(`NPPES (individuals, \`postal_code=ZIP&taxonomy_description=…\`): how many results practice elsewhere (their LOCATION address is not in the ZIP) unless \`address_purpose=LOCATION\` is added. Requests ${result.nppes.requests} · errors ${errs(result.nppes.errors)}.`);
  md.push("");
  md.push("| ZIP | Specialty | Results (any address) | Practice elsewhere | Results with address_purpose=LOCATION |");
  md.push("|---|---|---|---|---|");
  for (const r of result.nppes.rows) md.push(`| ${r.zip} | ${r.specialty} | ${r.any_address} | ${r.location_elsewhere} | ${r.location_only} |`);
  const a = result.nppes.rows.reduce((s, r) => s + r.any_address, 0), e = result.nppes.rows.reduce((s, r) => s + r.location_elsewhere, 0);
  md.push(`| **All** | | ${a} | **${e}** (${pct(e, a)}) | ${result.nppes.rows.reduce((s, r) => s + r.location_only, 0)} |`);
  md.push("");
}
if (result.qhp) {
  md.push(`Marketplace (QHP) machine-readable indexes for Florida, PY2026 (CMS Machine-readable URL PUF, 26 rows). Requests ${result.qhp.requests} · errors ${errs(result.qhp.errors)}.`);
  md.push("");
  md.push("| Issuer ID | Index URL | Status | Provider files listed |");
  md.push("|---|---|---|---|");
  for (const r of result.qhp.rows) md.push(`| ${r.issuerId} | ${r.url} | ${r.status} | ${r.provider_files ?? "-"} |`);
  md.push("");
}
md.push("Definitions: *Age stated* — newpatients.characteristics, comment/description/eligibility/characteristic texts or string extensions match an age pattern (\"ages 3 and up\", \"under 18 years\", \"adults only\", …; see `src/plannet.ts` AGE_PATTERNS). *Hours present* — Location.hoursOfOperation, availableTime, or the Plan-Net contactpoint-availabletime extension. *Hours conflict* — one record carries both hoursOfOperation and available-time and they disagree on a day. A record is one PractitionerRole or one Location resource, counted once per run.");

mkdirSync(outDir, { recursive: true });
const { names, ...publicResult } = result;
writeFileSync(join(outDir, `AUDIT-${day}.json`), `${JSON.stringify({ command, ...publicResult }, null, 1)}\n`);
writeFileSync(join(outDir, `AUDIT-${day}.md`), `${md.join("\n")}\n`);
if (pool && names) { mkdirSync(dirname(resolve(pool)), { recursive: true }); writeFileSync(resolve(pool), JSON.stringify({ capturedAt: result.startedAt, poolNames: [...new Set(names)] })); }

console.log("");
console.log(headline);
console.log(`records ${t.records} (roles ${t.roles}, locations ${t.locations}) · hours present ${t.hours_present} · hours conflict ${t.hours_conflict} · new-patients flag ${t.newpatients_present} · requests ${t.requests} · errors ${t.errors}`);
console.log(`control: synthetic age record counted = ${result.control.synthetic_age_record_counted} (must be true) · plain record counted = ${result.control.synthetic_plain_record_counted} (must be false)`);
console.log(`wrote ${join(outDir, `AUDIT-${day}.md`)} and .json${pool ? ` · name pool ${pool}` : ""}`);
if (!result.control.synthetic_age_record_counted || result.control.synthetic_plain_record_counted) process.exitCode = 1;
if (result.directories.every((d) => d.records === 0)) process.exitCode = 1;
