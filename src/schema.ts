import { z } from 'zod';

export const categoryIds = ['comida', 'fijos', 'credito', 'transporte', 'bencina', 'salidas', 'cuotas', 'repuestos'] as const;
export const transactionSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  type: z.enum(['income', 'expense']),
  description: z.string().trim().min(1).max(120),
  amount: z.number().int().positive().max(999999999999),
  category: z.enum([...categoryIds, 'ingreso']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => value >= '1900-01-01' && value <= '9999-12-31' && Number.isFinite(Date.parse(value)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value, 'La fecha no es válida'),
}).strict().refine(t => t.type === 'income' ? t.category === 'ingreso' : t.category !== 'ingreso', 'La categoría no corresponde al tipo de movimiento');

export const dataSchema = z.object({
  version: z.literal(1),
  demo: z.boolean(),
  transactions: z.array(transactionSchema).max(40000),
}).strict().superRefine((data, ctx) => {
  const ids = new Set(data.transactions.map(t => t.id));
  if (ids.size !== data.transactions.length) ctx.addIssue({ code: 'custom', path: ['transactions'], message: 'Hay identificadores de movimientos duplicados.' });
});

export type Transaction = z.infer<typeof transactionSchema>;
export type FinanceData = z.infer<typeof dataSchema>;
export type FinanceState = FinanceData & { revision: number };
export const emptyData = (): FinanceData => ({ version: 1, demo: false, transactions: [] });
