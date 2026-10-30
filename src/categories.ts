import { z } from 'zod';
import type { Collection, Db } from 'mongodb';
import { ApiError } from './errors.js';

export const categorySchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  type: z.enum(['income', 'expense']),
}).strict().refine(c => (c.type === 'income') === (c.id === 'ingreso'), 'La categoría ingreso debe conservar su tipo');
export type Category = z.infer<typeof categorySchema>;
export type CategoryRecord = Category & { revision: number };
export const defaultCategories: Category[] = [
  { id: 'comida', name: 'Comida', color: '#315c43', type: 'expense' },
  { id: 'fijos', name: 'Gastos fijos', color: '#7a9b68', type: 'expense' },
  { id: 'credito', name: 'Cuota crédito', color: '#b6ca8b', type: 'expense' },
  { id: 'transporte', name: 'Transporte', color: '#d6debe', type: 'expense' },
  { id: 'bencina', name: 'Bencina', color: '#8aa799', type: 'expense' },
  { id: 'salidas', name: 'Salidas', color: '#c7bda2', type: 'expense' },
  { id: 'cuotas', name: 'Cuotas', color: '#9da78a', type: 'expense' },
  { id: 'repuestos', name: 'Repuestos auto', color: '#62776c', type: 'expense' },
  { id: 'ingreso', name: 'Ingreso', color: '#4a8256', type: 'income' },
];
export interface CategoryStore {
  read(): Promise<CategoryRecord[]>;
  create(category: Category): Promise<void>;
  update(category: Category, revision: number): Promise<void>;
}
type CategoryDocument = CategoryRecord & { _id: string; userId: string };
export class MongoCategoryStore implements CategoryStore {
  private collection: Collection<CategoryDocument>;
  constructor(db: Db, private userId = 'personal') { this.collection = db.collection<CategoryDocument>('categories'); }
  async initialize() {
    for (const category of defaultCategories) {
      await this.collection.updateOne({ id: category.id, userId: this.userId }, { $setOnInsert: { _id: `${this.userId}:${category.id}`, ...category, revision: 0 } }, { upsert: true });
    }
  }
  async read(): Promise<CategoryRecord[]> {
    return (await this.collection.find({ userId: this.userId }).sort({ _id: 1 }).toArray()).map(({ _id, userId: _userId, ...category }) => category);
  }
  async create(category: Category) {
    try { await this.collection.insertOne({ _id: `${this.userId}:${category.id}`, userId: this.userId, ...category, revision: 0 }); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) throw new ApiError(409, 'DUPLICATE_CATEGORY', 'La categoría ya existe.');
      throw error;
    }
  }
  async update(category: Category, revision: number) {
    const result = await this.collection.updateOne({ id: category.id, userId: this.userId, revision, type: category.type }, { $set: { name: category.name, color: category.color }, $inc: { revision: 1 } });
    if (!result.matchedCount) throw new ApiError(409, 'REVISION_CONFLICT', 'La categoría cambió en otra ventana. Actualiza antes de guardar.');
  }
}
// Store aislado para pruebas de la API sin MongoDB.
export class MemoryCategoryStore implements CategoryStore {
  private categories = defaultCategories.map(c => ({ ...c, revision: 0 }));
  async read() { return structuredClone(this.categories); }
  async create(category: Category) {
    if (this.categories.some(c => c.id === category.id)) throw new ApiError(409, 'DUPLICATE_CATEGORY', 'La categoría ya existe.');
    this.categories.push({ ...category, revision: 0 });
  }
  async update(category: Category, revision: number) {
    const current = this.categories.find(c => c.id === category.id && c.revision === revision && c.type === category.type);
    if (!current) throw new ApiError(409, 'REVISION_CONFLICT', 'La categoría cambió en otra ventana.');
    Object.assign(current, { name: category.name, color: category.color, revision: revision + 1 });
  }
}
