export interface CompanySeed {
  key: string;
  canonicalName: string;
  aliases?: readonly string[];
  domain?: string;
  linkedinUrl?: string;
}

export interface CompanySet {
  key: string;
  label: string;
  description: string;
  revision: number;
  asOf: string;
  companies: readonly CompanySeed[];
}

const company = (
  canonicalName: string,
  domain?: string,
  aliases: readonly string[] = [],
  linkedinUrl?: string,
): CompanySeed => ({
  key: normalizeCompanyToken(canonicalName).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  canonicalName,
  aliases,
  domain,
  linkedinUrl,
});

export function normalizeCompanyToken(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s*&\s*/g, " and ")
    .replace(/[.,;:!?]+$/g, "")
    .replace(/\s+/g, " ");
}

const SETS = [
  {
    key: "tech.faang",
    label: "FAANG",
    description: "The five companies represented by the conventional FAANG acronym.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Meta", "meta.com", ["Facebook", "Meta Platforms"]),
      company("Amazon", "amazon.com"),
      company("Apple", "apple.com"),
      company("Netflix", "netflix.com"),
      company("Google", "google.com"),
    ],
  },
  {
    key: "tech.mango",
    label: "MANGO",
    description: "Meta, Amazon, Netflix, Google, and OpenAI.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Meta", "meta.com", ["Facebook", "Meta Platforms"]),
      company("Amazon", "amazon.com"),
      company("Netflix", "netflix.com"),
      company("Google", "google.com"),
      company("OpenAI", "openai.com"),
    ],
  },
  {
    key: "tech.magnificent_seven",
    label: "Magnificent Seven",
    description: "The conventional seven-company U.S. public-equity technology cohort.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Google", "google.com"),
      company("Amazon", "amazon.com"),
      company("Apple", "apple.com"),
      company("Meta", "meta.com", ["Meta Platforms", "Facebook"]),
      company("Microsoft", "microsoft.com"),
      company("NVIDIA", "nvidia.com"),
      company("Tesla", "tesla.com"),
    ],
  },
  {
    key: "ai.independent_model_labs.v1",
    label: "independent AI model labs",
    description: "A reviewed cohort of independent general-purpose model developers.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("AI21 Labs", "ai21.com"),
      company("Anthropic", "anthropic.com"),
      company("Cohere", "cohere.com"),
      company("DeepSeek", "deepseek.com"),
      company("MiniMax", "minimax.io"),
      company("Mistral AI", "mistral.ai"),
      company("Moonshot AI", "moonshot.ai"),
      company("OpenAI", "openai.com"),
      company("xAI", "x.ai"),
      company("Zhipu AI", "zhipuai.cn"),
    ],
  },
  {
    key: "consulting.mbb",
    label: "MBB",
    description: "McKinsey & Company, Boston Consulting Group, and Bain & Company.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("McKinsey & Company", "mckinsey.com", ["McKinsey"], "https://www.linkedin.com/company/mckinsey/"),
      company("Boston Consulting Group (BCG)", "bcg.com", ["Boston Consulting Group", "BCG"], "https://www.linkedin.com/company/boston-consulting-group/"),
      company("Bain & Company", "bain.com", ["Bain"], "https://www.linkedin.com/company/bain-and-company/"),
    ],
  },
  {
    key: "professional_services.big_four",
    label: "Big Four",
    description: "The four global accounting and professional-services networks.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Deloitte", "deloitte.com"),
      company("PwC", "pwc.com", ["PricewaterhouseCoopers"]),
      company("EY", "ey.com", ["Ernst & Young"]),
      company("KPMG", "kpmg.com"),
    ],
  },
  {
    key: "banking.bulge_bracket.v1",
    label: "bulge-bracket investment banks",
    description: "A reviewed reference cohort of globally scaled investment banks.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Bank of America", "bankofamerica.com", ["BofA", "Merrill Lynch"]),
      company("Barclays", "barclays.com"),
      company("Citi", "citi.com", ["Citigroup"]),
      company("Deutsche Bank", "db.com"),
      company("Goldman Sachs", "goldmansachs.com", ["Goldman"]),
      company("JPMorgan Chase & Co.", "jpmorganchase.com", ["J.P. Morgan", "JPMorgan"]),
      company("Morgan Stanley", "morganstanley.com"),
      company("UBS", "ubs.com"),
    ],
  },
  {
    key: "banking.us_gsib",
    label: "U.S. G-SIBs",
    description: "U.S.-headquartered global systemically important banks.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Bank of America", "bankofamerica.com"),
      company("BNY", "bny.com", ["Bank of New York Mellon"]),
      company("Citi", "citi.com", ["Citigroup"]),
      company("Goldman Sachs", "goldmansachs.com"),
      company("JPMorgan Chase & Co.", "jpmorganchase.com"),
      company("Morgan Stanley", "morganstanley.com"),
      company("State Street", "statestreet.com"),
      company("Wells Fargo", "wellsfargo.com"),
    ],
  },
  {
    key: "banking.independent_advisory.v1",
    label: "independent advisory investment banks",
    description: "A reviewed reference cohort of independent advisory and boutique investment banks.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Centerview Partners", "centerviewpartners.com"),
      company("Evercore", "evercore.com"),
      company("Houlihan Lokey", "hl.com"),
      company("Lazard", "lazard.com"),
      company("Moelis & Company", "moelis.com"),
      company("Perella Weinberg Partners", "pwpartners.com"),
      company("PJT Partners", "pjtpartners.com"),
      company("Qatalyst Partners", "qatalyst.com"),
    ],
  },
  {
    key: "investing.large_alternative_managers.v1",
    label: "large alternative-asset managers",
    description: "A reviewed cohort of globally scaled alternative-asset managers.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Apollo Global Management", "apollo.com"),
      company("Ares Management", "aresmgmt.com"),
      company("Blackstone", "blackstone.com"),
      company("Blue Owl Capital", "blueowl.com"),
      company("Brookfield Asset Management", "brookfield.com"),
      company("Carlyle", "carlyle.com"),
      company("CVC Capital Partners", "cvc.com"),
      company("EQT Group", "eqtgroup.com"),
      company("KKR", "kkr.com"),
      company("Partners Group", "partnersgroup.com"),
      company("TPG", "tpg.com"),
    ],
  },
  {
    key: "investing.venture_firms_reference.v1",
    label: "venture-capital firms reference cohort",
    description: "A reviewed, non-exhaustive cohort of established venture-capital firms.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Accel", "accel.com"),
      company("Andreessen Horowitz", "a16z.com", ["a16z"]),
      company("Benchmark", "benchmark.com"),
      company("Bessemer Venture Partners", "bvp.com"),
      company("Founders Fund", "foundersfund.com"),
      company("General Catalyst", "generalcatalyst.com"),
      company("Greylock", "greylock.com"),
      company("Index Ventures", "indexventures.com"),
      company("Insight Partners", "insightpartners.com"),
      company("Khosla Ventures", "khoslaventures.com"),
      company("Kleiner Perkins", "kleinerperkins.com"),
      company("Lightspeed Venture Partners", "lsvp.com"),
      company("New Enterprise Associates", "nea.com", ["NEA"]),
      company("Sequoia Capital", "sequoiacap.com", ["Sequoia"], "https://www.linkedin.com/company/sequoia/"),
      company("Thrive Capital", "thrivecap.com"),
    ],
  },
  {
    key: "investing.multimanager_hedge_funds.v1",
    label: "multi-manager hedge funds",
    description: "A reviewed cohort of major multi-manager investment platforms.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Balyasny Asset Management", "bamfunds.com"),
      company("Citadel", "citadel.com"),
      company("ExodusPoint Capital Management", "exoduspoint.com"),
      company("Millennium", "mlp.com", ["Millennium Management"]),
      company("Point72", "point72.com"),
      company("Schonfeld", "schonfeld.com"),
    ],
  },
  {
    key: "investing.quant_trading_firms.v1",
    label: "quantitative trading firms",
    description: "A reviewed cohort spanning quantitative market makers and investment firms.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Citadel Securities", "citadelsecurities.com"),
      company("D. E. Shaw", "deshaw.com"),
      company("DRW", "drw.com"),
      company("Hudson River Trading", "hudsonrivertrading.com", ["HRT"]),
      company("IMC Trading", "imc.com"),
      company("Jane Street", "janestreet.com"),
      company("Jump Trading", "jumptrading.com"),
      company("Optiver", "optiver.com"),
      company("Susquehanna International Group", "sig.com", ["SIG"]),
      company("Two Sigma", "twosigma.com"),
    ],
  },
  {
    key: "law.magic_circle_uk",
    label: "Magic Circle law firms",
    description: "The conventional UK Magic Circle law-firm cohort.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("A&O Shearman", "aoshearman.com", ["Allen & Overy"]),
      company("Clifford Chance", "cliffordchance.com"),
      company("Freshfields", "freshfields.com"),
      company("Linklaters", "linklaters.com"),
      company("Slaughter and May", "slaughterandmay.com"),
    ],
  },
  {
    key: "biopharma.global_originator_reference.v1",
    label: "global biopharma reference cohort",
    description: "A reviewed cohort of globally scaled originator pharmaceutical and biopharma employers.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("AbbVie", "abbvie.com"), company("Amgen", "amgen.com"), company("AstraZeneca", "astrazeneca.com"),
      company("Bristol Myers Squibb", "bms.com"), company("Eli Lilly and Company", "lilly.com"),
      company("Gilead Sciences", "gilead.com"), company("GSK", "gsk.com"), company("Johnson & Johnson", "jnj.com"),
      company("Merck", "merck.com"), company("Novartis", "novartis.com"), company("Novo Nordisk", "novonordisk.com"),
      company("Pfizer", "pfizer.com"), company("Roche", "roche.com"), company("Sanofi", "sanofi.com"),
      company("Takeda", "takeda.com"),
    ],
  },
  {
    key: "healthcare.us_managed_care_reference.v1",
    label: "U.S. managed-care reference cohort",
    description: "A reviewed cohort of large U.S. managed-care parent organizations.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Centene", "centene.com"), company("CVS Health", "cvshealth.com"), company("The Cigna Group", "thecignagroup.com"),
      company("Elevance Health", "elevancehealth.com"), company("Humana", "humana.com"),
      company("Molina Healthcare", "molinahealthcare.com"), company("UnitedHealth Group", "unitedhealthgroup.com"),
    ],
  },
  {
    key: "media.us_studio_groups.v1",
    label: "major U.S. studio groups",
    description: "A reviewed cohort of U.S. parent groups operating major film, television, or broadcast studios.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("The Walt Disney Company", "thewaltdisneycompany.com"),
      company("Fox Corporation", "foxcorporation.com"),
      company("NBCUniversal", "nbcuniversal.com"),
      company("Paramount", "paramount.com"),
      company("Warner Bros. Discovery", "wbd.com"),
    ],
  },
  {
    key: "consumer.global_cpg_reference.v1",
    label: "global consumer packaged-goods reference cohort",
    description: "A reviewed cohort of scaled global branded consumer-goods manufacturers.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("The Coca-Cola Company", "coca-colacompany.com"), company("Colgate-Palmolive", "colgatepalmolive.com"),
      company("General Mills", "generalmills.com"), company("Kenvue", "kenvue.com"),
      company("Kimberly-Clark", "kimberly-clark.com"), company("Kraft Heinz", "kraftheinzcompany.com"),
      company("Mondelēz International", "mondelezinternational.com"), company("Nestlé", "nestle.com"),
      company("PepsiCo", "pepsico.com"), company("Procter & Gamble", "pg.com"),
      company("Reckitt", "reckitt.com"), company("Unilever", "unilever.com"),
    ],
  },
  {
    key: "government.us_executive_departments",
    label: "U.S. executive departments",
    description: "The 15 Cabinet-level departments of the U.S. federal government.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("U.S. Department of Agriculture", "usda.gov", ["USDA"]),
      company("U.S. Department of Commerce", "commerce.gov"),
      company("U.S. Department of Defense", "defense.gov", ["DoD"]),
      company("U.S. Department of Education", "ed.gov"),
      company("U.S. Department of Energy", "energy.gov", ["DOE"]),
      company("U.S. Department of Health and Human Services", "hhs.gov", ["HHS"]),
      company("U.S. Department of Homeland Security", "dhs.gov", ["DHS"]),
      company("U.S. Department of Housing and Urban Development", "hud.gov", ["HUD"]),
      company("U.S. Department of the Interior", "doi.gov"),
      company("U.S. Department of Justice", "justice.gov", ["DOJ"]),
      company("U.S. Department of Labor", "dol.gov"),
      company("U.S. Department of State", "state.gov"),
      company("U.S. Department of Transportation", "dot.gov"),
      company("U.S. Department of the Treasury", "treasury.gov"),
      company("U.S. Department of Veterans Affairs", "va.gov", ["VA"]),
    ],
  },
  {
    key: "government.us_financial_regulators",
    label: "U.S. federal financial regulators",
    description: "Federal agencies with primary prudential, markets, or consumer-finance regulatory authority.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Federal Reserve Board", "federalreserve.gov"), company("Consumer Financial Protection Bureau", "consumerfinance.gov", ["CFPB"]),
      company("Commodity Futures Trading Commission", "cftc.gov", ["CFTC"]), company("Federal Deposit Insurance Corporation", "fdic.gov", ["FDIC"]),
      company("Federal Housing Finance Agency", "fhfa.gov", ["FHFA"]), company("National Credit Union Administration", "ncua.gov", ["NCUA"]),
      company("Office of the Comptroller of the Currency", "occ.gov", ["OCC"]),
      company("U.S. Securities and Exchange Commission", "sec.gov", ["SEC"]),
    ],
  },
  {
    key: "research.us_doe_national_laboratories",
    label: "U.S. Department of Energy national laboratories",
    description: "The 17 laboratories officially designated in the U.S. DOE national-laboratory system.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("Ames National Laboratory", "ameslab.gov"),
      company("Argonne National Laboratory", "anl.gov"),
      company("Brookhaven National Laboratory", "bnl.gov"),
      company("Fermi National Accelerator Laboratory", "fnal.gov", ["Fermilab"]),
      company("Idaho National Laboratory", "inl.gov"),
      company("Lawrence Berkeley National Laboratory", "lbl.gov", ["Berkeley Lab"]),
      company("Lawrence Livermore National Laboratory", "llnl.gov"),
      company("Los Alamos National Laboratory", "lanl.gov"),
      company("National Energy Technology Laboratory", "netl.doe.gov"),
      company("National Renewable Energy Laboratory", "nrel.gov"),
      company("Oak Ridge National Laboratory", "ornl.gov"),
      company("Pacific Northwest National Laboratory", "pnnl.gov"),
      company("Princeton Plasma Physics Laboratory", "pppl.gov"),
      company("Sandia National Laboratories", "sandia.gov"),
      company("Savannah River National Laboratory", "srnl.gov"),
      company("SLAC National Accelerator Laboratory", "slac.stanford.edu"),
      company("Thomas Jefferson National Accelerator Facility", "jlab.org", ["Jefferson Lab"]),
    ],
  },
  {
    key: "international.multilateral_development_banks",
    label: "multilateral development banks",
    description: "Major sovereign-owned multilateral development-finance institutions.",
    revision: 1,
    asOf: "2026-07-09",
    companies: [
      company("African Development Bank Group", "afdb.org"), company("Asian Development Bank", "adb.org"),
      company("Asian Infrastructure Investment Bank", "aiib.org"), company("European Bank for Reconstruction and Development", "ebrd.com", ["EBRD"]),
      company("Inter-American Development Bank", "iadb.org"), company("Islamic Development Bank", "isdb.org"),
      company("New Development Bank", "ndb.int"), company("World Bank Group", "worldbank.org"),
    ],
  },
] as const satisfies readonly CompanySet[];

export const COMPANY_SETS = Object.fromEntries(SETS.map((set) => [set.key, set])) as Record<
  (typeof SETS)[number]["key"],
  (typeof SETS)[number]
>;
export type CompanySetKey = keyof typeof COMPANY_SETS;
export const COMPANY_SET_KEYS = Object.keys(COMPANY_SETS) as CompanySetKey[];

const SET_ALIASES: Record<string, CompanySetKey> = {
  faang: "tech.faang",
  maang: "tech.faang",
  mango: "tech.mango",
  "mag 7": "tech.magnificent_seven",
  "magnificent seven": "tech.magnificent_seven",
  mbb: "consulting.mbb",
  "big four": "professional_services.big_four",
  "big 4": "professional_services.big_four",
  "bulge bracket": "banking.bulge_bracket.v1",
  "boutique investment bank": "banking.independent_advisory.v1",
  "boutique investment banks": "banking.independent_advisory.v1",
  "elite boutique": "banking.independent_advisory.v1",
  "top vc": "investing.venture_firms_reference.v1",
  "top venture capital firms": "investing.venture_firms_reference.v1",
  "leading vc": "investing.venture_firms_reference.v1",
  "multi-manager": "investing.multimanager_hedge_funds.v1",
  "pod shop": "investing.multimanager_hedge_funds.v1",
  "quant firms": "investing.quant_trading_firms.v1",
  "prop trading firms": "investing.quant_trading_firms.v1",
  "magic circle": "law.magic_circle_uk",
  "big pharma": "biopharma.global_originator_reference.v1",
  "ai lab": "ai.independent_model_labs.v1",
  "independent ai lab": "ai.independent_model_labs.v1",
  "doe labs": "research.us_doe_national_laboratories",
  "national labs": "research.us_doe_national_laboratories",
};

const COMPANY_ALIASES = new Map<string, CompanySeed>();
for (const set of SETS) {
  for (const member of set.companies) {
    for (const alias of [member.canonicalName, ...(member.aliases ?? [])]) {
      const token = normalizeCompanyToken(alias);
      const existing = COMPANY_ALIASES.get(token);
      if (existing && existing.key !== member.key) {
        throw new Error(`Conflicting company alias "${alias}"`);
      }
      if (!existing) COMPANY_ALIASES.set(token, member);
    }
  }
}

export function companySetByKey(key: string | null | undefined): CompanySet | null {
  return key && key in COMPANY_SETS ? COMPANY_SETS[key as CompanySetKey] : null;
}

export function companySetByAlias(value: string): CompanySet | null {
  const key = SET_ALIASES[normalizeCompanyToken(value)];
  return key ? COMPANY_SETS[key] : null;
}

export function companyByAlias(value: string): CompanySeed | null {
  return COMPANY_ALIASES.get(normalizeCompanyToken(value)) ?? null;
}

export function validateCompanyRegistry(): void {
  for (const set of SETS) {
    if (!set.asOf || set.revision < 1) throw new Error(`Invalid company set ${set.key}`);
    const keys = new Set<string>();
    for (const member of set.companies) {
      if (keys.has(member.key)) throw new Error(`Duplicate member ${member.key} in ${set.key}`);
      keys.add(member.key);
    }
  }
}

validateCompanyRegistry();
