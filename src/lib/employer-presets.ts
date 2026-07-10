import type { CrustdataFilter } from "./crustdata.ts";

export interface EmployerPreset {
  key: string;
  label: string;
  description: string;
  revision: number;
  conditions: readonly CrustdataFilter[];
}

const industries = (...values: string[]): CrustdataFilter => ({
  field: "experience.employment_details.current.company_professional_network_industry",
  type: "in",
  value: values,
});

const PRESETS = [
  {
    key: "startup",
    label: "a startup",
    description: "Privately held employers with 1-200 employees.",
    revision: 1,
    conditions: [
      {
        field: "experience.employment_details.current.company_headcount_range",
        type: "in",
        value: ["1-10", "11-50", "51-200"],
      },
      { field: "experience.employment_details.current.company_type", type: "=", value: "Privately Held" },
    ],
  },
  {
    key: "large_technology_company",
    label: "a large technology company",
    description: "Technology employers with at least 10,000 employees.",
    revision: 1,
    conditions: [
      industries("Software Development", "Technology, Information and Internet", "IT Services and IT Consulting"),
      { field: "experience.employment_details.current.company_headcount_range", type: "in", value: ["10,001+"] },
    ],
  },
  {
    key: "large_law_firm",
    label: "a large law firm",
    description: "Law-practice employers with at least 1,000 employees.",
    revision: 1,
    conditions: [
      industries("Law Practice"),
      { field: "experience.employment_details.current.company_headcount_range", type: "in", value: ["1,001-5,000", "5,001-10,000", "10,001+"] },
    ],
  },
  {
    key: "investment_bank",
    label: "an investment bank",
    description: "Employers in the Investment Banking industry.",
    revision: 1,
    conditions: [industries("Investment Banking")],
  },
  {
    key: "commercial_bank",
    label: "a commercial bank",
    description: "Employers in Banking.",
    revision: 1,
    conditions: [industries("Banking")],
  },
  {
    key: "venture_capital_firm",
    label: "a venture-capital firm",
    description: "Employers in Venture Capital and Private Equity Principals.",
    revision: 1,
    conditions: [industries("Venture Capital and Private Equity Principals")],
  },
  {
    key: "private_equity_firm",
    label: "a private-equity firm",
    description: "Employers in Venture Capital and Private Equity Principals.",
    revision: 1,
    conditions: [industries("Venture Capital and Private Equity Principals")],
  },
  {
    key: "hedge_fund",
    label: "a hedge fund",
    description: "Employers in Hedge Funds.",
    revision: 1,
    conditions: [industries("Hedge Funds")],
  },
  {
    key: "asset_manager",
    label: "an asset manager",
    description: "Employers in Investment Management.",
    revision: 1,
    conditions: [industries("Investment Management")],
  },
  {
    key: "management_consulting_firm",
    label: "a management-consulting firm",
    description: "Employers in Business Consulting and Services.",
    revision: 1,
    conditions: [industries("Business Consulting and Services")],
  },
  {
    key: "hospital",
    label: "a hospital or health system",
    description: "Employers in Hospitals and Health Care.",
    revision: 1,
    conditions: [industries("Hospitals and Health Care")],
  },
  {
    key: "biotech_company",
    label: "a biotechnology company",
    description: "Employers in Biotechnology Research.",
    revision: 1,
    conditions: [industries("Biotechnology Research")],
  },
  {
    key: "pharma_company",
    label: "a pharmaceutical company",
    description: "Employers in Pharmaceutical Manufacturing.",
    revision: 1,
    conditions: [industries("Pharmaceutical Manufacturing")],
  },
  {
    key: "nonprofit",
    label: "a nonprofit",
    description: "Nonprofit employers.",
    revision: 1,
    conditions: [
      industries("Non-profit Organizations"),
      { field: "experience.employment_details.current.company_type", type: "=", value: "Nonprofit" },
    ],
  },
  {
    key: "research_organization",
    label: "a research organization",
    description: "Employers in Research Services.",
    revision: 1,
    conditions: [industries("Research Services")],
  },
] as const satisfies readonly EmployerPreset[];

export const EMPLOYER_PRESETS = Object.fromEntries(PRESETS.map((preset) => [preset.key, preset])) as Record<
  (typeof PRESETS)[number]["key"],
  (typeof PRESETS)[number]
>;
export type EmployerPresetKey = keyof typeof EMPLOYER_PRESETS;
export const EMPLOYER_PRESET_KEYS = Object.keys(EMPLOYER_PRESETS) as EmployerPresetKey[];

export function employerPresetByKey(key: string | null | undefined): EmployerPreset | null {
  return key && key in EMPLOYER_PRESETS ? EMPLOYER_PRESETS[key as EmployerPresetKey] : null;
}
