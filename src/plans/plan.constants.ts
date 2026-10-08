export enum PlanCode {
  FREE = 'free',
  BASIC = 'basic',
  PREMIUM = 'premium',
}

export enum BillingCurrency {
  USD = 'USD',
}

export enum BillingInterval {
  MONTH = 'month',
}

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  // Legacy API field name: the allowance applies to currently stored files.
  includedFilesPerMonth: number;
  // Employees are company members; the company owner is not a billable employee.
  maxEmployees: number | null;
  basePriceCents: number;
  employeePriceCents: number;
  extraFilePriceCents: number | null;
  currency: BillingCurrency;
  interval: BillingInterval;
}

export const PLAN_CATALOG: Readonly<
  Record<PlanCode, Readonly<PlanDefinition>>
> = Object.freeze({
  [PlanCode.FREE]: Object.freeze({
    code: PlanCode.FREE,
    name: 'Free',
    includedFilesPerMonth: 10,
    maxEmployees: 0,
    basePriceCents: 0,
    employeePriceCents: 0,
    extraFilePriceCents: null,
    currency: BillingCurrency.USD,
    interval: BillingInterval.MONTH,
  }),
  [PlanCode.BASIC]: Object.freeze({
    code: PlanCode.BASIC,
    name: 'Basic',
    includedFilesPerMonth: 100,
    maxEmployees: 10,
    basePriceCents: 0,
    employeePriceCents: 500,
    extraFilePriceCents: null,
    currency: BillingCurrency.USD,
    interval: BillingInterval.MONTH,
  }),
  [PlanCode.PREMIUM]: Object.freeze({
    code: PlanCode.PREMIUM,
    name: 'Premium',
    includedFilesPerMonth: 1000,
    maxEmployees: null,
    basePriceCents: 30000,
    employeePriceCents: 0,
    extraFilePriceCents: 50,
    currency: BillingCurrency.USD,
    interval: BillingInterval.MONTH,
  }),
});
