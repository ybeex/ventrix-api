import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AuthedUser } from './plugins/auth.js';
export type { AuthedUser };
/** Route modules call `typed(app)` once to get TypeBox-inferred request/response types. */
export const typed = (app: FastifyInstance) => app.withTypeProvider<TypeBoxTypeProvider>();
export type TypedApp = ReturnType<typeof typed>;
