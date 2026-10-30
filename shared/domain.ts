import { z } from "zod";
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      value >= "1900-01-01" &&
      value <= "9999-12-31" &&
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "Enter a valid calendar date (1900–9999).");
export const moneySchema = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/,
    "Enter an amount with at most two decimal places.",
  )
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  })
  .refine((value) => value > 0, "Amount must be greater than zero.");
export const policySchema = z
  .object({
    customerId: z.string().min(1),
    startDate: dateSchema,
    endDate: dateSchema,
    sumInsured: moneySchema,
  })
  .strict()
  .refine((value) => value.endDate >= value.startDate, {
    path: ["endDate"],
    message: "End date cannot precede start date.",
  });
export const claimSchema = z
  .object({
    policyId: z.string().min(1),
    incidentDate: dateSchema,
    amount: moneySchema,
    requestId: z.uuid(),
  })
  .strict();
export const decisionSchema = z
  .object({ status: z.enum(["Approved", "Rejected"]) })
  .strict();
export type User = {
  id: string;
  username: string;
  role: "Customer" | "Administrator";
};
export type Policy = {
  id: string;
  customerId: string;
  customer: string;
  startDate: string;
  endDate: string;
  sumInsured: number;
  remaining: number;
};
export type Claim = {
  id: string;
  policyId: string;
  customer: string;
  incidentDate: string;
  amount: number;
  status: "Submitted" | "Approved" | "Rejected";
};
