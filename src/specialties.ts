// Specialty groups as NUCC Health Care Provider Taxonomy codes (https://taxonomy.nucc.org), with the words
// directories actually use. Codes were checked against live NPPES answers on 2026-10-11 (each code below appeared
// as a practitioner's taxonomy in an NPPES response for an Orlando ZIP).
//
// Why `directoryTexts` and `needsTaxonomyJoin`: some Plan-Net directories carry only the taxonomy CLASSIFICATION as
// free text with a NullFlavor code (e.g. "INTERNAL MEDICINE" for a gastroenterologist). A sub-specialty such as
// gastroenterology then cannot be found in that directory alone; it is found by joining on NPI with NPPES, where the
// SPECIALIZATION code (207RG0100X) is published.

export type SpecialtyGroup = {
  label: string;
  /** NUCC codes that count as this specialty (classification and specializations). */
  nucc: string[];
  /** NPPES `taxonomy_description` search term. */
  nppesTerm: string;
  /** Upper-case specialty texts seen in Plan-Net directories for this group (used for `specialty:text` and matching). */
  directoryTexts: string[];
  /** true when directories that publish only the classification cannot tell this group apart without NPPES. */
  needsTaxonomyJoin: boolean;
  /** Free-text match for files and directories that use plain words ("Orthopedic Surgeon", "Allergist"). */
  textPattern: RegExp;
};

export const SPECIALTY_GROUPS = {
  primary_care: {
    label: "Primary care (family medicine, general practice)",
    nucc: ["207Q00000X", "207QA0505X", "207QG0300X", "208D00000X"],
    nppesTerm: "Family Medicine",
    directoryTexts: ["FAMILY MEDICINE", "FAMILY PRACTICE", "GENERAL PRACTICE"],
    needsTaxonomyJoin: false,
    textPattern: /\b(family (practice|medicine|physician)|general practi(ce|tioner))\b/i,
  },
  ob_gyn: {
    label: "Obstetrics & gynecology",
    nucc: ["207V00000X", "207VG0400X", "207VX0000X", "207VM0101X", "207VF0040X"],
    nppesTerm: "Obstetrics & Gynecology",
    directoryTexts: ["OBSTETRICS & GYNECOLOGY", "OBSTETRICS AND GYNECOLOGY", "OBSTETRICS/GYNECOLOGY", "GYNECOLOGY", "OB/GYN"],
    needsTaxonomyJoin: false,
    textPattern: /\b(ob ?\/? ?gyn|obstetric|gyn(a)?ecolog)/i,
  },
  gastroenterology: {
    label: "Gastroenterology",
    nucc: ["207RG0100X"],
    nppesTerm: "Gastroenterology",
    directoryTexts: ["GASTROENTEROLOGY", "INTERNAL MEDICINE"],
    needsTaxonomyJoin: true,
    textPattern: /gastroenterolog/i,
  },
  dermatology: {
    label: "Dermatology",
    nucc: ["207N00000X", "207NP0225X", "207NS0135X", "207ND0101X", "207NI0002X"],
    nppesTerm: "Dermatology",
    directoryTexts: ["DERMATOLOGY"],
    needsTaxonomyJoin: false,
    textPattern: /dermatolog/i,
  },
  allergy: {
    label: "Allergy & immunology",
    nucc: ["207K00000X", "207KA0200X", "207KI0005X", "207RA0201X", "2080P0201X"],
    nppesTerm: "Allergy",
    directoryTexts: ["ALLERGY & IMMUNOLOGY", "ALLERGY AND IMMUNOLOGY", "ALLERGY/IMMUNOLOGY", "ALLERGY"],
    needsTaxonomyJoin: false,
    textPattern: /allerg/i,
  },
  orthopedics: {
    label: "Orthopaedic surgery",
    nucc: ["207X00000X", "207XP3100X", "207XS0106X", "207XS0114X", "207XS0117X", "207XX0004X", "207XX0005X", "207XX0801X"],
    nppesTerm: "Orthopaedic Surgery",
    directoryTexts: ["ORTHOPAEDIC SURGERY", "ORTHOPEDIC SURGERY", "ORTHOPEDICS", "ORTHOPAEDICS"],
    needsTaxonomyJoin: false,
    textPattern: /orthop(a)?edic/i,
  },
  pediatrics: {
    label: "Pediatrics",
    nucc: ["208000000X"],
    nppesTerm: "Pediatrics",
    directoryTexts: ["PEDIATRICS", "PEDIATRIC MEDICINE"],
    needsTaxonomyJoin: false,
    textPattern: /^(general )?pediatric(s|ian)$|^pediatric medicine$/i,
  },
  cardiology: {
    label: "Cardiology",
    nucc: ["207RC0000X", "207RI0011X", "207RC0001X", "2080P0202X"],
    nppesTerm: "Cardiovascular Disease",
    directoryTexts: ["CARDIOVASCULAR DISEASE", "CARDIOLOGY", "INTERNAL MEDICINE"],
    needsTaxonomyJoin: true,
    textPattern: /cardiolog|cardiovascular disease/i,
  },
  ent: {
    label: "Otolaryngology (ear, nose and throat)",
    nucc: ["207Y00000X", "207YP0228X", "207YS0123X", "207YX0007X"],
    nppesTerm: "Otolaryngology",
    directoryTexts: ["OTOLARYNGOLOGY"],
    needsTaxonomyJoin: false,
    textPattern: /otolaryngolog|\bENT\b|ear,? nose/i,
  },
  ophthalmology: {
    label: "Ophthalmology",
    nucc: ["207W00000X", "207WX0110X"],
    nppesTerm: "Ophthalmology",
    directoryTexts: ["OPHTHALMOLOGY"],
    needsTaxonomyJoin: false,
    textPattern: /ophthalmolog/i,
  },
  urology: {
    label: "Urology",
    nucc: ["208800000X", "2088P0231X"],
    nppesTerm: "Urology",
    directoryTexts: ["UROLOGY"],
    needsTaxonomyJoin: false,
    textPattern: /urolog/i,
  },
  endocrinology: {
    label: "Endocrinology",
    nucc: ["207RE0101X"],
    nppesTerm: "Endocrinology",
    directoryTexts: ["ENDOCRINOLOGY", "INTERNAL MEDICINE"],
    needsTaxonomyJoin: true,
    textPattern: /endocrinolog/i,
  },
} as const satisfies Record<string, SpecialtyGroup>;

export type SpecialtyKey = keyof typeof SPECIALTY_GROUPS;

/** Does a record's specialty (NUCC codes and/or texts) belong to the group? Texts that need the NPPES join never count alone. */
export function matchesGroup(key: SpecialtyKey, codes: string[], texts: string[]): boolean {
  const g: SpecialtyGroup = SPECIALTY_GROUPS[key];
  if (codes.some((c) => g.nucc.includes(c))) return true;
  const up = texts.map((t) => t.trim().toUpperCase());
  const own = g.needsTaxonomyJoin ? g.directoryTexts.filter((t) => t !== "INTERNAL MEDICINE") : g.directoryTexts;
  return up.some((t) => own.some((d) => t === d || t.startsWith(d)));
}

/** Group of a free-text specialty ("Allergist", "Orthopedic Surgeon specializing in Pediatrics"). Dentists never match,
 *  nor do allied-health roles named after a field ("Orthopedic Physical Therapist", Molina 2026-10-13): not a physician. */
export function groupOfText(text: string): SpecialtyKey | null {
  if (/dent(ist|al)/i.test(text)) return null;
  if (/\b(therapist|therapy|assistant|technician|technologist|orthotist|prosthetist)\b/i.test(text)) return null;
  for (const [k, g] of Object.entries(SPECIALTY_GROUPS) as [SpecialtyKey, SpecialtyGroup][]) if (g.textPattern.test(text)) return k;
  return null;
}
