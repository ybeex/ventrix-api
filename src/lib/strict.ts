/**
 * Schema helpers. Every request-body object is `additionalProperties: false`, and
 * Fastify's Ajv is configured NOT to silently strip extras (see app.ts), so an
 * unexpected field is a 400 — this is the mass-assignment defence: a client can never
 * smuggle `role`, `orgId`, `quantityAvailable`, `stockDelta`, ... into a write.
 */
import { Type, type TProperties, type ObjectOptions, type TSchema, type TLiteral } from '@sinclair/typebox';

export const Obj = <T extends TProperties>(props: T, opts: ObjectOptions = {}) =>
  Type.Object(props, { additionalProperties: false, ...opts });

export const Uuid = Type.String({ format: 'uuid' });
export const IsoDate = Type.String({ format: 'date-time' });
export const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
export const Note = Type.String({ minLength: 1, maxLength: 2000 });
export const Email = Type.String({ format: 'email', maxLength: 254 });
export const Password = Type.String({ minLength: 12, maxLength: 128 });

export const IdParams = Obj({ id: Uuid });
export const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 200 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
};
export const PageOf = <T extends TSchema>(item: T) =>
  Type.Object({ items: Type.Array(item), nextCursor: Nullable(Type.String()) });

/** String-literal union that keeps its literal types: `lits(['a','b'])` is Type<'a' | 'b'>. */
export const lits = <const T extends readonly string[]>(vals: T) => Type.Union(vals.map((v) => Type.Literal(v)) as unknown as TLiteral<T[number]>[]);

/** For endpoints whose body is entirely optional: an absent body is treated as `{}` BEFORE schema validation (so `Obj({...optional})` works with no body). */
export const emptyBodyOk = async (req: { body?: unknown }): Promise<void> => { if (req.body === undefined || req.body === null) req.body = {}; };
