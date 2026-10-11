// Public Plan-Net provider directories that answered without a key or registration on 2026-10-11, and HOW each one
// can be asked "practitioners at locations in ZIP Z" — the servers differ in which search parameters they support,
// so each entry names a strategy that was checked live:
//   chain        PractitionerRole?location.address-postalcode=Z (server supports chained search) + _include
//   per-location Location?address-postalcode=Z, then PractitionerRole?location=<id> one location at a time
//                (the server rejects comma-separated OR lists or answers them with 0)
// Directories that need registration (Aetna: 401; Elevance: 500 without a token) are listed in NOT_OPEN.

export type Strategy = "chain" | "per-location";

export type DirectoryInfo = {
  key: string;
  label: string;
  base: string;
  strategy: Strategy;
  /** Location ids are passed bare ("123") instead of "Location/123". */
  bareIds?: boolean;
  /** Supports _include=PractitionerRole:location / :practitioner on PractitionerRole searches. */
  includes?: boolean;
  /** Pause between requests (ms); some gateways answer 403 to bursts. */
  pauseMs?: number;
  /** Max Location pages to read per ZIP. */
  maxLocationPages?: number;
  /** Page size the server honours (some ignore _count). */
  pageSize?: number;
  notes: string;
};

export const DIRECTORIES: DirectoryInfo[] = [
  {
    key: "florida-blue",
    label: "Florida Blue provider directory (FHIR Plan-Net)",
    base: "https://apigw.bcbsfl.com/interop/interop-developer-portal/emr/api/v1/fhir",
    strategy: "chain",
    includes: true,
    pageSize: 100,
    notes: "HAPI-style server: /metadata 404 at the gateway, but an unknown search parameter returns the list of valid ones. PractitionerRole has no `network` search parameter; plan filter via identifier system https://www.edifecs.com/fhir/cms-organization/plan_id. Specialty is free text with a NullFlavor code (classification only).",
  },
  {
    key: "molina",
    label: "Molina Healthcare provider directory (FHIR Plan-Net)",
    base: "https://api.interop.molinahealthcare.com/providerdirectory",
    strategy: "per-location",
    bareIds: true,
    includes: false,
    pauseMs: 300,
    maxLocationPages: 10,
    pageSize: 100,
    notes: "PractitionerRole supports `network` and `location` with bare ids; comma-separated id lists return 0; _include on network searches returns 500; bursts of 6 parallel requests got HTTP 403.",
  },
  {
    key: "uhc-optum",
    label: "UnitedHealthcare / Optum provider directory (FHIR Plan-Net)",
    base: "https://flex.optum.com/fhirpublic/R4",
    strategy: "per-location",
    includes: false,
    pauseMs: 150,
    maxLocationPages: 5,
    pageSize: 50,
    notes: "Location search by ZIP answers; PractitionerRole links to InsurancePlan-level network references.",
  },
  {
    key: "cigna",
    label: "Cigna provider directory (FHIR Plan-Net)",
    base: "https://fhir.cigna.com/ProviderDirectory/v1",
    strategy: "per-location",
    includes: false,
    pauseMs: 150,
    maxLocationPages: 5,
    pageSize: 50,
    notes: "Location by ZIP answers; network-reference on PractitionerRole.",
  },
  {
    key: "humana",
    label: "Humana provider directory (FHIR Plan-Net)",
    base: "https://fhir.humana.com/api",
    strategy: "per-location",
    includes: false,
    pauseMs: 150,
    maxLocationPages: 5,
    pageSize: 50,
    notes: "Location and InsurancePlan answer; PractitionerRole timed out twice at 30 s on 2026-10-11 (02:2xZ).",
  },
  {
    key: "centene",
    label: "Centene (Ambetter, Sunshine Health, Wellcare) provider directory (FHIR Plan-Net)",
    base: "https://iopc-pd.api.centene.com/iopc/pd/fhir/providerdirectory",
    strategy: "per-location",
    includes: false,
    pauseMs: 150,
    maxLocationPages: 2,
    pageSize: 200,
    notes: "Location by ZIP returns 200 records per page and ignores _count; PractitionerRole without a parameter is 400.",
  },
];

export const NOT_OPEN = [
  { key: "aetna", base: "https://apif1.aetna.com/fhir/v1/providerdirectorydata", observed: "401 Invalid client id or secret (registration required)" },
  { key: "elevance", base: "https://totalview.healthos.elevancehealth.com/resources/unregistered/api/v1/fhir/cms_mandate/mcd/", observed: "500 without a token; their document says production requires registration" },
];

export const directoryByKey = (key: string): DirectoryInfo => {
  const d = DIRECTORIES.find((x) => x.key === key);
  if (!d) throw new Error(`unknown directory ${key}`);
  return d;
};
