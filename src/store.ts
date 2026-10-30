import type { Collection, Db } from 'mongodb';
import { ApiError } from './errors.js';
import { dataSchema, emptyData, type FinanceData, type FinanceState } from './schema.js';

export interface FinanceStore {
  read(): Promise<FinanceState>;
  replace(expectedRevision: number, data: FinanceData): Promise<FinanceState>;
}

type FinanceDocument = FinanceState & { _id: string; updatedAt: Date };

// Un documento personal permite importaciones y borrados atómicos incluso en MongoDB
// local sin replica set. La revisión impide sobrescribir cambios de otra pestaña.
export class MongoFinanceStore implements FinanceStore {
  private collection: Collection<FinanceDocument>;
  constructor(db: Db, private userId = 'personal') { this.collection = db.collection<FinanceDocument>('finances'); }

  async initialize(): Promise<void> {
    await this.collection.updateOne({ _id: this.userId }, { $setOnInsert: { ...emptyData(), revision: 0, updatedAt: new Date() } }, { upsert: true });
  }

  async read(): Promise<FinanceState> {
    const document = await this.collection.findOne({ _id: this.userId });
    if (!document) throw new ApiError(503, 'DATA_UNAVAILABLE', 'Los datos no están disponibles. Reinicia la API.');
    return { version: document.version, demo: document.demo, transactions: document.transactions, revision: document.revision };
  }

  async replace(expectedRevision: number, input: FinanceData): Promise<FinanceState> {
    const data = dataSchema.parse(input);
    // Margen respecto de los 16 MiB máximos de un documento BSON.
    if (Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024) throw new ApiError(413, 'DATA_TOO_LARGE', 'Los movimientos superan el límite de almacenamiento de esta versión (8 MB).');
    const state = { ...data, revision: expectedRevision + 1 };
    const result = await this.collection.replaceOne({ _id: this.userId, revision: expectedRevision }, { ...state, updatedAt: new Date() });
    if (!result.matchedCount) throw new ApiError(409, 'REVISION_CONFLICT', 'Los datos cambiaron en otra ventana. Actualiza antes de volver a guardar.');
    return state;
  }
}
